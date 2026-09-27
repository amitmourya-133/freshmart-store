'use strict';
// FRESHMART PART 12 — Phase 1 Gap Completion E2E Tests
// Verifies: configurable delivery radius (server-authoritative), real ETA,
// trending products (real sales data), admin settings for radius/ETA, and the
// security rules (server-side coordinate validation, admin-only settings).
// Creates ONLY @freshmart.test data and cleans up only what it created.
// Restores the admin settings to their pre-test snapshot at the end.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO = 'D:/vegetable store';
const mongoose = require(path.join(REPO, 'node_modules/mongoose'));
const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'));
const User = require(path.join(REPO, 'models/User'));
const Order = require(path.join(REPO, 'models/Order'));
const Product = require(path.join(REPO, 'models/Product'));

const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
const URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!URI) { console.error('MONGODB_URI not found'); process.exit(1); }
if (!JWT_SECRET) { console.error('JWT_SECRET not found'); process.exit(1); }

const TEST_TAG = '@freshmart.test';
const testTag = 'part12' + Date.now() + TEST_TAG;
const clientRefs = [];

const STORE = { lat: 28.6139, lng: 77.2090, locality: 'Delhi Test' }; // central Delhi

let passed = 0, failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log('  [PASS] ' + msg); }
    else { failed++; console.log('  [FAIL] ' + msg); }
}

function httpReq(options, body) {
    return new Promise((resolve, reject) => {
        if (body) {
            options.headers = options.headers || {};
            if (!options.headers['Content-Type']) options.headers['Content-Type'] = 'application/json';
        }
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

function api(pathname, opts) {
    const o = Object.assign({ hostname: 'localhost', port: 5000 }, opts, { path: pathname });
    const body = o.body;
    delete o.body;
    return httpReq(o, body);
}

function authHeaders(token) {
    return { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };
}

async function main() {
    console.log('=== FRESHMART PART 12: Phase 1 (radius / ETA / trending) Tests ===');

    await mongoose.connect(URI);

    const adminUser = await User.findOne({ role: 'admin' }).lean();
    const adminHeaders = authHeaders(jwt.sign({ id: adminUser._id }, JWT_SECRET, { expiresIn: '1h' }));

    const customerUser = await User.create({ email: testTag.toLowerCase(), role: 'customer', name: 'Phase1 Test Customer', phone: '999999' + String(Date.now()).slice(-6) });
    const customerHeaders = authHeaders(jwt.sign({ id: customerUser._id }, JWT_SECRET, { expiresIn: '1h' }));

    const actives = await Product.find({ active: true, stock: { $gt: 0 } }).sort({ price: -1 }).limit(20).lean();
    if (!actives || actives.length === 0) { console.log('  [SKIP AVAIL] no active in-stock product'); process.exit(0); }

    // ---- Snapshot & configure settings ------------------------------------
    const beforeAll = await api('/api/settings', { headers: adminHeaders });
    const snap = beforeAll.body && beforeAll.body.data ? beforeAll.body.data : {};
    const minOrder = Number(snap.minimumOrderValue) || 0;
    const origRadius = Number(snap.deliveryRadiusKm) || 0;
    const origLat = Number(snap.storeLat) || 0;
    const origLng = Number(snap.storeLng) || 0;
    const origLocality = snap.storeLocality || 'Store';
    const origBase = Number(snap.etaBaseMinutes) >= 0 ? Number(snap.etaBaseMinutes) : 45;
    const origPerKm = Number(snap.etaMinutesPerKm) >= 0 ? Number(snap.etaMinutesPerKm) : 3;

    // Pick one product whose price*qty clears the store minimum and fits stock.
    const targetQty = function (price, stock) {
        const need = Math.max(1, Math.ceil((minOrder + 100) / price));
        return need <= stock ? need : Math.max(1, Math.min(need, Math.max(1, stock - 1)));
    };
    let prod = actives.length ? actives[0] : null;
    let qty = 1;
    if (prod) {
        qty = targetQty(prod.price, prod.stock);
        if (minOrder > 0 && (prod.price * qty) < minOrder) {
            // Rare: the priciest item still can't clear the minimum with available stock.
            for (const cand of actives) {
                const q = targetQty(cand.price, cand.stock);
                if ((cand.price * q) >= minOrder) { prod = cand; qty = q; break; }
            }
        }
    }
    if (!prod) { console.log('  [SKIP AVAIL] no suitable product'); process.exit(0); }

    function payloadFor(lat, lng) {
        return { latitude: lat, longitude: lng, accuracy: 12, capturedAt: new Date().toISOString() };
    }
    function orderBody(extra, note) {
        const body = {
            customer: { name: 'Phase1 Customer', phone: '9812312345', address: 'Test Address Street ' + note, city: 'Delhi', state: 'Delhi', pincode: '110001' },
            items: [{ name: prod.name, price: prod.price, quantity: qty, productId: prod._id }],
            payment: 'Cash On Delivery',
            paymentMethod: 'cod',
            deliverySlot: 'Evening (5-8 PM)',
            clientRef: extra.clientRef
        };
        if (extra.deliveryLocation) body.deliveryLocation = extra.deliveryLocation;
        return body;
    }

    try {
        // ==================================================================
        // A. SETTINGS API (admin-only) + new fields
        // ==================================================================
        console.log('\n--- A. Settings API exposes radius/ETA fields ---');
        const getS = await api('/api/settings', { headers: adminHeaders });
        assert(getS.status === 200 && getS.body.data && 'deliveryRadiusKm' in getS.body.data,
            `admin GET /api/settings has deliveryRadiusKm (status ${getS.status})`);
        assert('storeLat' in getS.body.data && 'etaBaseMinutes' in getS.body.data,
            'admin GET /api/settings has storeLat/etaBaseMinutes');

        const ship = await api('/api/settings/shipping');
        assert(ship.status === 200 && 'deliveryRadiusKm' in ship.body.data && 'radiusEnabled' in ship.body.data,
            `public shipping policy has deliveryRadiusKm + radiusEnabled (status ${ship.status})`);
        assert(!('storeLat' in ship.body.data) && !('storeLng' in ship.body.data),
            'shipping policy NEVER leaks exact store coordinates');

        // Non-admin cannot write settings
        const noAdmin = await api('/api/settings', { method: 'PUT', headers: customerHeaders, body: JSON.stringify({ deliveryRadiusKm: 5 }) });
        assert(noAdmin.status === 403, `customer cannot update settings (status ${noAdmin.status})`);

        // Enable radius + store origin
        const cfg = await api('/api/settings', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({
            deliveryRadiusKm: 50, storeLat: STORE.lat, storeLng: STORE.lng, storeLocality: STORE.locality, etaBaseMinutes: 45, etaMinutesPerKm: 3
        }) });
        assert(cfg.status === 200 && cfg.body.data && cfg.body.data.deliveryRadiusKm === 50,
            `admin enables 50km radius (status ${cfg.status})`);

        // ==================================================================
        // B. DELIVERY-CHECK endpoint
        // ==================================================================
        console.log('\n--- B. Delivery coverage check ---');
        const inside = await api('/api/settings/delivery-check?lat=' + (STORE.lat + 0.02) + '&lng=' + STORE.lng);
        assert(inside.status === 200 && inside.body.data.inside === true && inside.body.data.serviceable === true,
            `in-radius coordinate is serviceable (inside=${inside.body && inside.body.data && inside.body.data.inside}, dist=${inside.body && inside.body.data && inside.body.data.distanceKm})`);

        const farLat = 28.1, farLng = 75.0; // ~250 km from Delhi
        const outside = await api('/api/settings/delivery-check?lat=' + farLat + '&lng=' + farLng);
        assert(outside.status === 200 && outside.body.data.inside === false && outside.body.data.serviceable === false,
            `far coordinate is outside (inside=${outside.body && outside.body.data && outside.body.data.inside}, dist=${outside.body && outside.body.data && outside.body.data.distanceKm})`);

        const badCoords = await api('/api/settings/delivery-check?lat=abc&lng=999');
        assert(badCoords.status === 400, `invalid coordinates rejected (status ${badCoords.status})`);

        // ==================================================================
        // C. QUOTE pre-check
        // ==================================================================
        console.log('\n--- C. Quote reflects radius pre-check ---');
        const qIn = await api('/api/orders/quote', { method: 'POST', body: JSON.stringify({ items: orderBody({}).items, deliveryLocation: payloadFor(STORE.lat, STORE.lng) }) });
        assert(qIn.status === 200 && qIn.body.success, `quote OK for in-radius (status ${qIn.status})`);
        const qOut = await api('/api/orders/quote', { method: 'POST', body: JSON.stringify({ items: orderBody({}).items, deliveryLocation: payloadFor(farLat, farLng) }) });
        assert(qOut.status === 400 && /outside our delivery area|within/.test(String((qOut.body && qOut.body.message) || '')),
            `quote blocked outside radius (status ${qOut.status}: ${qOut.body && qOut.body.message})`);

        // ==================================================================
        // D. ORDER CREATION — radius enforcement (server-authoritative)
        // ==================================================================
        console.log('\n--- D. Order creation radius enforcement ---');
        // (1) radius ON + no GPS -> blocked (address-only protected only when radius OFF)
        const r1 = await api('/api/orders', { method: 'POST', headers: customerHeaders, body: JSON.stringify(orderBody({ clientRef: testTag + '-no-loc' }, 'no-loc')) });
        assert(r1.status === 400 && /location/i.test(String((r1.body && r1.body.message) || '')),
            `no-GPS order blocked with clear message when radius enabled (status ${r1.status}: ${r1.body && r1.body.message})`);

        // (2) radius ON + malformed coords -> 400
        const r2 = await api('/api/orders', { method: 'POST', headers: customerHeaders, body: JSON.stringify(orderBody({ clientRef: testTag + '-bad', deliveryLocation: { latitude: 'abc', longitude: 77 } }, 'bad')) });
        assert(r2.status === 400 && /Invalid|coordinates/i.test(String((r2.body && r2.body.message) || '')),
            `malformed coordinates rejected (status ${r2.status}: ${r2.body && r2.body.message})`);

        // (3) radius ON + far coords -> 400
        const r3 = await api('/api/orders', { method: 'POST', headers: customerHeaders, body: JSON.stringify(orderBody({ clientRef: testTag + '-far', deliveryLocation: payloadFor(farLat, farLng) }, 'far')) });
        assert(r3.status === 400 && /outside our delivery area|within/i.test(String((r3.body && r3.body.message) || '')),
            `outside-radius order blocked (status ${r3.status}: ${r3.body && r3.body.message})`);

        // (4) radius ON + inside coords -> created 201, GPS persisted
        const locIn = payloadFor(STORE.lat, STORE.lng);
        const r4 = await api('/api/orders', { method: 'POST', headers: customerHeaders, body: JSON.stringify(orderBody({ clientRef: testTag + '-in', deliveryLocation: locIn }, 'in')) });
        assert(r4.status === 201 || r4.status === 200, `in-radius order created (status ${r4.status})`);
        const createdOrder = r4.body && r4.body.data;
        if (createdOrder) clientRefs.push(testTag + '-in');
        assert(!!createdOrder && createdOrder.deliveryLocation && Math.abs(createdOrder.deliveryLocation.latitude - STORE.lat) < 0.001,
            'in-radius order persisted GPS deliveryLocation');
        assert(!!createdOrder && createdOrder.status === 'Placed' && createdOrder.paymentStatus === 'PENDING',
            'COD order starts Placed/PENDING (server-set)');

        // ==================================================================
        // E. ETA (tracking + my-orders + admin detail)
        // ==================================================================
        console.log('\n--- E. Real ETA on order views ---');
        const track = await api('/api/orders/track/' + createdOrder.orderNumber);
        assert(track.status === 200 && track.body.data.eta && track.body.data.eta.text,
            `tracking returns an ETA (${track.body && track.body.data && track.body.data.eta && track.body.data.eta.text})`);
        const trackData = track.body.data;
        assert(!('deliveryLocation' in trackData) && !('customer' in trackData) && !('address' in trackData),
            'tracking view leaks NO location/address/customer data');

        const my = await api('/api/orders/my', { headers: customerHeaders });
        const mine = (my.body && my.body.data || []).find((o) => o.clientRef === testTag + '-in');
        assert(my.status === 200 && mine && mine.eta && mine.eta.text,
            `my-orders includes eta (source ${mine && mine.eta && mine.eta.source})`);

        const detail = await api('/api/orders/' + createdOrder._id, { headers: adminHeaders });
        assert(detail.status === 200 && detail.body.data.eta && detail.body.data.eta.text,
            `admin order detail includes eta (${detail.body && detail.body.data && detail.body.data.eta && detail.body.data.eta.text})`);

        // ==================================================================
        // F. RADIUS OFF restores address-only flow
        // ==================================================================
        console.log('\n--- F. Radius OFF keeps address-only customers working ---');
        const off = await api('/api/settings', { method: 'PUT', headers: adminHeaders, body: JSON.stringify({ deliveryRadiusKm: 0 }) });
        assert(off.status === 200 && off.body.data.deliveryRadiusKm === 0, 'admin disables radius');
        const r5 = await api('/api/orders', { method: 'POST', headers: customerHeaders, body: JSON.stringify(orderBody({ clientRef: testTag + '-addr-only' }, 'addr-only')) });
        assert(r5.status === 201 || r5.status === 200,
            `address-only order (no GPS) succeeds when radius OFF (status ${r5.status})`);
        if (r5.body && r5.body.data) clientRefs.push(testTag + '-addr-only');
        assert(r5.body && r5.body.data && r5.body.data.deliveryLocation == null,
            'address-only order has no deliveryLocation');

        // ==================================================================
        // G. TRENDING PRODUCTS (real sales data)
        // ==================================================================
        console.log('\n--- G. Trending products from real order data ---');
        const trend = await api('/api/products/trending?limit=8');
        assert(trend.status === 200 && trend.body.success && Array.isArray(trend.body.data) && trend.body.data.length > 0,
            `trending returns real products (count=${trend.body && trend.body.data && trend.body.data.length})`);
        const trending = trend.body && trend.body.data || [];
        let allValid = trending.length > 0;
        for (const t2 of trending) {
            if (!t2._id || typeof t2.price !== 'number' || typeof t2.name !== 'string') { allValid = false; break; }
            const prodDoc = await Product.findById(t2._id).lean();
            if (!prodDoc || !prodDoc.active || prodDoc.stock <= 0) { allValid = false; break; }
        }
        assert(allValid, 'every trending item is an active, in-stock product from the catalog');
        const tClamp = await api('/api/products/trending?limit=999');
        assert(tClamp.body && tClamp.body.data && tClamp.body.data.length <= 20, `trending limit clamped (count=${tClamp.body && tClamp.body.data && tClamp.body.data.length})`);

        // ==================================================================
        // H. ETA slot fallback for an order with no assignment
        // ==================================================================
        console.log('\n--- H. ETA slot fallback path ---');
        const slotEta = await api('/api/orders/track/' + (r5.body && r5.body.data && r5.body.data.orderNumber || 'FM000000'));
        if (r5.body && r5.body.data) {
            assert(slotEta.status === 200 && slotEta.body.data.eta && slotEta.body.data.eta.source === 'slot',
                `no-assignment order shows slot ETA (source=${slotEta.body && slotEta.body.data && slotEta.body.data.eta && slotEta.body.data.eta.source})`);
        } else {
            console.log('  [SKIP] address-only order missing for ETA check');
        }

    } catch (e) {
        failed++;
        console.log('  [FAIL] harness error: ' + (e && e.message ? e.message : e));
    }

    // ======================================================================
    // CLEANUP + RESTORE
    // ======================================================================
    console.log('\n--- Cleanup & settings restore ---');
    const adminHeaders2 = authHeaders(jwt.sign({ id: adminUser._id }, JWT_SECRET, { expiresIn: '1h' }));
    const restore = await api('/api/settings', { method: 'PUT', headers: adminHeaders2, body: JSON.stringify({
        deliveryRadiusKm: origRadius, storeLat: origLat, storeLng: origLng, storeLocality: origLocality, etaBaseMinutes: origBase, etaMinutesPerKm: origPerKm
    }) });
    assert(restore.status === 200, 'settings restored to snapshot');

    for (const ref of clientRefs) {
        const del = await Order.deleteOne({ clientRef: ref });
        if (del && del.deletedCount) console.log('  [cleanup] removed order ' + ref);
    }
    const delUser = await User.deleteOne({ email: testTag.toLowerCase() });
    if (delUser && delUser.deletedCount) console.log('  [cleanup] removed test customer');

    await mongoose.disconnect();

    console.log('\n=== RESULT: ' + passed + ' PASS / ' + failed + ' FAIL ===');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (e) {
    console.error(e);
    process.exit(1);
});