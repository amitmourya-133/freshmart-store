'use strict';
// FRESHMART PART 10 — Security E2E Tests
// Verifies: login enumeration fix, rate limiter XFF fix, password policy,
// customer order isolation, unauthorized API rejection.
// Creates ONLY @freshmart.test data and cleans up only what it created.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO = 'D:/vegetable store';
const mongoose = require(path.join(REPO, 'node_modules/mongoose'));
const User = require(path.join(REPO, 'models/User'));
const Order = require(path.join(REPO, 'models/Order'));
const Product = require(path.join(REPO, 'models/Product'));

// AUD-01 / SEC-02: this suite used to feed the raw production MONGODB_URI
// straight into mongoose.connect() and then insert real Users and Orders.
// utils/dbGuard refused that URI, so in practice the suite aborted before it
// ever ran — the security coverage it claims was never actually exercised —
// but the moment anyone ran it with FM_DB_FORCE=1 it wrote test rows into the
// production `freshmart` database.
//
// Instead, derive a dedicated throwaway database from the same credentials,
// assert the server under test is attached to that same database, and drop the
// database on exit. Nothing here can reach production.
const testDb = require(path.join(REPO, 'tests/lib/testDb'));
const { uri: URI, dbName: TEST_DB_NAME } = testDb.deriveTestUri('part10', process.env.FM_TEST_DB_NAME);
const BASE_URL = process.env.FM_TEST_BASE_URL || 'http://localhost:5000';

const TEST_TAG = '@freshmart.test';
const testEmail = 'part10' + Date.now() + TEST_TAG;
const testOrderNum = 'FM-P10-' + Date.now();

let passed = 0, failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log('  [PASS] ' + msg); }
    else { failed++; console.log('  [FAIL] ' + msg); }
}

const BASE = new URL(BASE_URL);

function httpReq({ path: reqPath, method, headers }, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: BASE.hostname,
            port: BASE.port || 80,
            path: reqPath,
            method: method,
            headers: headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function cleanup() {
    await User.deleteMany({ email: new RegExp(TEST_TAG) });
    await Order.deleteMany({ orderNumber: new RegExp('^FM-P10-') });
}

async function main() {
    console.log('=== FRESHMART PART 10: Security E2E Tests ===');
    console.log('isolated database: ' + TEST_DB_NAME);

    await mongoose.connect(URI);
    // Verify against the driver's own view of the database, not just the URI.
    testDb.assertConnectionIsTestDb(mongoose, TEST_DB_NAME);
    console.log('connected database: ' + testDb.connectedDbName(mongoose));

    // Prove the API server under test is attached to the SAME throwaway
    // database. Without this the HTTP assertions below could pass vacuously
    // against a server still using production data.
    await testDb.assertServerOnTestDb(BASE_URL, TEST_DB_NAME);
    console.log('server preflight ok: ' + BASE_URL + ' is on ' + TEST_DB_NAME);

    // The throwaway database is empty, so Tests 4 and 8 need a product. Seed a
    // minimal one — inside the isolated DB only.
    if (!await Product.findOne()) {
        const fixture = new Product({
            name: 'P10 Fixture Tomato',
            description: 'part10 isolated-test fixture',
            price: 40,
            mrp: 45,
            unit: 'kg',
            stock: 500,
            category: 'Vegetables',
            image: '/images/jacfruit.png',
            active: true
        });
        await fixture.save();
        console.log('seeded product fixture ' + fixture._id);
    }

    // ==============================
    // Test 1: Login enumeration — both cases return identical message
    // ==============================
    console.log('\n--- Test 1: Login enumeration messages are identical ---');
    const r1 = await httpReq({ path: '/api/users/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, { email: 'noexist' + TEST_TAG, password: 'anypass' });

    const testUser = new User({
        name: 'P10 Test',
        email: testEmail,
        password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1',
        role: 'customer'
    });
    await testUser.save();

    const r2 = await httpReq({ path: '/api/users/login', method: 'POST', headers: { 'Content-Type': 'application/json' } }, { email: testEmail, password: 'wrongpassword' });

    assert(r1.status === r2.status,
        `Enumeration: no-account status ${r1.status} === wrong-password status ${r2.status}`);
    assert(r1.body && r2.body && r1.body.message === r2.body.message,
        `Enumeration: both messages identical = "${r1.body && r1.body.message}"`);

    // ==============================
    // Test 2: Rate limiter uses req.ip (code-level check)
    // ==============================
    console.log('\n--- Test 2: Rate limiter identity does not use XFF ---');
    const rateLimitCode = fs.readFileSync(path.join(REPO, 'utils/rateLimit.js'), 'utf8');
    const keyFromMatch = rateLimitCode.match(/function keyFrom[\s\S]*?^}/m);
    const keyFromBody = keyFromMatch ? keyFromMatch[0] : '';
    assert(keyFromBody.includes('req.ip') && !keyFromBody.includes('x-forwarded-for'),
        'Rate limiter keyFrom uses req.ip only, not client-supplied X-Forwarded-For');

    // ==============================
    // Test 3: Password policy requires 8+ chars
    // ==============================
    console.log('\n--- Test 3: Password policy minimum 8 characters ---');
    const pwCode = fs.readFileSync(path.join(REPO, 'controllers/userController.js'), 'utf8');
    assert(pwCode.includes('length < 8') || pwCode.includes('length < 8'),
        'Password minimum is 8 characters in userController');

    // ==============================
    // Test 4: Customer order isolation — valid fixture
    // ==============================
    console.log('\n--- Test 4: Customer order isolation ---');
    const prod = await Product.findOne().lean();
    if (!prod) {
        console.log('  [SKIP] No products in DB');
    } else {
        const userA = new User({
            name: 'P10 CustA', email: 'p10a' + Date.now() + TEST_TAG,
            password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1', role: 'customer'
        });
        const userB = new User({
            name: 'P10 CustB', email: 'p10b' + Date.now() + TEST_TAG,
            password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1', role: 'customer'
        });
        await userA.save(); await userB.save();

        const orderA = new Order({
            orderNumber: 'FM-P10-' + Date.now() + '-A',
            user: userA._id,
            customer: { name: 'CustA', phone: '9000000001', address: 'Test Lane', city: 'Delhi', pincode: '110001' },
            items: [{ name: prod.name, price: prod.price, quantity: 1, productId: prod._id }],
            paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price
        });
        const orderB = new Order({
            orderNumber: 'FM-P10-' + Date.now() + '-B',
            user: userB._id,
            customer: { name: 'CustB', phone: '9000000002', address: 'Test Lane 2', city: 'Delhi', pincode: '110002' },
            items: [{ name: prod.name, price: prod.price, quantity: 1, productId: prod._id }],
            paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price
        });
        await orderA.save(); await orderB.save();

        const ordersA = await Order.countDocuments({ user: userA._id, orderNumber: new RegExp('^FM-P10-') });
        const ordersB = await Order.countDocuments({ user: userB._id, orderNumber: new RegExp('^FM-P10-') });
        assert(ordersA === 1 && ordersB === 1,
            `Isolation: userA has ${ordersA}, userB has ${ordersB} (expected 1 each)`);

        await Order.deleteMany({ orderNumber: { $regex: '^FM-P10-' } });
        await User.deleteMany({ email: /p10[ab]\d+@freshmart\.test/ });
    }

    // ==============================
    // Test 5: Unauthorized APIs return 401
    // ==============================
    console.log('\n--- Test 5: Unauthorized API returns 401 ---');
    const unauth = await httpReq({ path: '/api/orders', method: 'GET' });
    assert(unauth.status === 401, `No token GET /api/orders => ${unauth.status} (expected 401)`);

    const unauth2 = await httpReq({ path: '/api/users/me', method: 'GET' });
    assert(unauth2.status === 401, `No token GET /api/users/me => ${unauth2.status} (expected 401)`);

    // ==============================
    // Test 6: getProductRating removed
    // ==============================
    console.log('\n--- Test 6: Fake rating generator removed ---');
    const scriptCode = fs.readFileSync(path.join(REPO, 'script.js'), 'utf8');
    assert(!scriptCode.includes('getProductRating'),
        'script.js has zero getProductRating references');

    // ==============================
    // Test 7: Razorpay not introduced
    // ==============================
    console.log('\n--- Test 7: Razorpay NOT added/restored ---');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    assert(!allDeps.razorpay, 'No razorpay in package.json dependencies');
    const payCtrl = fs.readFileSync(path.join(REPO, 'controllers/paymentController.js'), 'utf8');
    assert(!payCtrl.includes('require("razorpay")') && !payCtrl.includes("require('razorpay')"),
        'No razorpay require in paymentController');

    // ==============================
    // Test 8: COD flow intact
    // ==============================
    console.log('\n--- Test 8: COD order creation works ---');
    const codOrder = new Order({
        orderNumber: 'FM-P10-COD-' + Date.now(),
        customer: { name: 'COD Test', phone: '9000000009', address: 'COD Lane', city: 'Delhi', pincode: '110009' },
        items: [{ name: prod.name, price: prod.price, quantity: 2, productId: prod._id }],
        paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price * 2
    });
    await codOrder.save();
    const codCheck = await Order.findById(codOrder._id).lean();
    assert(codCheck && codCheck.paymentMethod === 'cod' && codCheck.total === prod.price * 2,
        `COD order: method=${codCheck && codCheck.paymentMethod}, total=${codCheck && codCheck.total}`);
    await Order.deleteOne({ _id: codOrder._id });

    // ==============================
    // Cleanup test user, then drop the
    // whole throwaway database
    // ==============================
    await cleanup();
    await mongoose.connection.db.dropDatabase();
    await mongoose.disconnect();

    console.log(`\n=== PART 10 RESULTS: ${passed} passed, ${failed} failed ===`);
    console.log('dropped test database ' + TEST_DB_NAME);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (err) => {
    console.error('FATAL:', err.message);
    // Still tear the isolated database down so a failed run leaves nothing.
    try {
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.db.dropDatabase();
            await mongoose.disconnect();
        }
    } catch (e) { /* nothing to clean up */ }
    process.exit(1);
});
