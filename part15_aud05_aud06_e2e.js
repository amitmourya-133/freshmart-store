'use strict';
// ===============================
// FRESHMART PART 15 - AUD-05 / AUD-06 E2E REGRESSION
// ===============================
// AUD-05: delivery lifecycle state machine is now a hard transition closure
//   (REJECTED / CANCELLED / DELIVERED are terminal; EN_ROUTE may only move to
//   DELIVERED), candidate discovery excludes bound partners and closed orders,
//   the sweep closes an offer instead of re-opening it when it loses a race,
//   OTP re-issue is blocked for every closed status, and cash/signature
//   recording is idempotent.
// AUD-06: an admin manual "Delivered" is only valid from "Out for Delivery",
//   always requires an audit reason, runs through the SAME completion primitive
//   as the OTP path, consumes the active assignment, retires open offers, and
//   never fabricates payment.
//
// SAFETY: this test uses a DEDICATED Mongo database (fm_aud05_aud06_e2e_<pid>).
// The real `freshmart` database is never read or written and the test database
// is dropped on exit. Run with:  node part15_aud05_aud06_e2e.js
// ===============================

const fs = require("fs");
const path = require("path");
const http = require("http");
const REPO = __dirname;

const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI) { console.error("MONGODB_URI not found in .env"); process.exit(1); }
if (!JWT_SECRET) { console.error("JWT_SECRET not found in .env"); process.exit(1); }

const TEST_DB = "fm_aud05_aud06_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");

// The app and every model must see the test database BEFORE anything is required.
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = "test";

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));

const User = require(path.join(REPO, "models/User"));
const Order = require(path.join(REPO, "models/Order"));
const Product = require(path.join(REPO, "models/Product"));
const Settings = require(path.join(REPO, "models/Settings"));
const DeliveryOffer = require(path.join(REPO, "models/DeliveryOffer"));
const DeliveryAssignment = require(path.join(REPO, "models/DeliveryAssignment"));
const { hashOtp } = require(path.join(REPO, "utils/otp"));

// The mailer is stubbed (see part14) so the test opens no SMTP sessions; every
// server-side rule under test (hashes, expiry, closure) is still exercised.
const emailService = require(path.join(REPO, "utils/emailService"));
emailService.sendOtpEmail = async function () { return { sent: true, stubbed: true }; };
emailService.sendDeliveryConfirmation = async function () { return { sent: true, stubbed: true }; };
emailService.sendDeliveryAssignment = async function () { return { sent: true, stubbed: true }; };
emailService.sendOrderConfirmation = async function () { return { sent: true, stubbed: true }; };
emailService.sendOrderStatusUpdate = async function () { return { sent: true, stubbed: true }; };

let passed = 0, failed = 0;
const failures = [];
function check(ok, label, extra) {
    if (ok) { passed++; console.log("  [PASS] " + label); }
    else { failed++; failures.push(label); console.log("  [FAIL] " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
function section(title) { console.log("\n--- " + title + " ---"); }

async function waitFor(fn, label, timeoutMs) {
    const limit = timeoutMs || 8000;
    const step = 100;
    const started = Date.now();
    let last = null;
    while (Date.now() - started < limit) {
        last = await fn();
        if (last) return last;
        await new Promise(function (r) { setTimeout(r, step); });
    }
    return last;
}

let PORT = 0;
function req(pathname, opts) {
    return new Promise((resolve, reject) => {
        const o = Object.assign({ hostname: "127.0.0.1", port: PORT, path: pathname, method: "GET" }, opts || {});
        const payload = o.body === undefined ? null : JSON.stringify(o.body);
        delete o.body;
        if (payload !== null) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
        const r = http.request(o, (res) => {
            let data = "";
            res.on("data", (c) => { data += c; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, json: json, raw: data });
            });
        });
        r.on("error", reject);
        if (payload !== null) r.write(payload);
        r.end();
    });
}
const token = (user) => jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: "1h" });
const auth = (user) => ({ Authorization: "Bearer " + token(user), "Content-Type": "application/json" });

const DROP = { lat: 28.6150, lng: 77.2110 };
const NEAR = { lat: 28.6200, lng: 77.2100 };

let seq = 0;
const uniq = (p) => p + "." + process.pid + "." + (seq++) + "@freshmart.test";

async function makeUser(over) {
    return User.create(Object.assign({
        email: uniq("user"),
        name: "Test User",
        phone: "98" + String(10000000 + (seq++) * 137).slice(0, 8),
        role: "customer",
        emailVerified: true,
    }, over || {}));
}

async function makeOrder(user, over) {
    return Order.create(Object.assign({
        orderNumber: "FM" + String(Date.now()).slice(-6) + String(seq++).slice(-2),
        trackingId: "FM-20260928-" + String(seq++).padStart(4, "0"),
        customer: { name: "Test Customer", phone: "9812312345", address: "12 Test Street", city: "New Delhi", state: "Delhi", pincode: "110001" },
        customerEmail: user ? user.email : null,
        items: [{ name: "Test Carrot", price: 60, quantity: 2 }],
        subtotal: 120,
        delivery: 20,
        discount: 0,
        total: 140,
        payment: "Cash On Delivery",
        paymentMethod: "cod",
        paymentStatus: "PENDING",
        paid: false,
        status: "Placed",
        deliverySlot: "Evening (5-8 PM)",
        deliveryLocation: { latitude: DROP.lat, longitude: DROP.lng, accuracy: 12, capturedAt: new Date().toISOString() },
        user: user ? user._id : undefined,
    }, over || {}));
}

async function setOpsSettings(patch) {
    const s = await Settings.getSettings();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    await s.save();
    return s;
}

// Drive an order to a chosen order.status through the admin endpoint.
async function adminAdvance(admin, orderId, status) {
    return req("/api/orders/" + orderId + "/status", { method: "PATCH", headers: auth(admin), body: { status: status } });
}

// Mint a known OTP on an assignment so delivery completion can be driven.
async function pinOtp(assignmentId, otp) {
    await DeliveryAssignment.updateOne({ _id: assignmentId }, {
        $set: {
            otpHash: hashOtp(otp),
            otpExpiry: new Date(Date.now() + 15 * 60 * 1000),
            otpIssuedAt: new Date(),
            otpAttempts: 0,
        },
    });
}

async function main() {
    console.log("=== FRESHMART PART 15: AUD-05 / AUD-06 E2E ===");
    console.log("test database: " + TEST_DB + " (the real database is never touched)");

    await mongoose.connect(TEST_URI);

    const admin = await makeUser({ role: "admin", name: "Ops Admin", phone: "9810000001" });
    const customer = await makeUser({ role: "customer", name: "Regular Customer" });
    const partnerA = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner A", isAvailable: true, vehicleType: "Bike", zone: "Central Delhi", lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });
    const partnerB = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner B", isAvailable: true, vehicleType: "Cycle", zone: "South Delhi", lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });

    const product = await Product.create({
        name: "Part15 Test Carrot", price: 60, unit: "500 g", category: "Vegetables",
        emoji: "🥕", gradient: "#f7c948", stock: 500, active: true,
    });

    await setOpsSettings({
        deliveryBroadcastEnabled: true,
        deliveryOfferTtlSeconds: 90,
        deliveryAutoAssign: false,
        deliveryAutoAssignDelaySeconds: 30,
        deliveryMaxOtpReissue: 2,
        deliveryStaleMinutes: 15,
    });

    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    const deliveryOpsController = require(path.join(REPO, "controllers/deliveryOpsController"));
    const forceAssign = (partner, orderId) =>
        req("/api/delivery-ops/admin/partners/" + partner._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(orderId) } });
    const partnerStatus = (assignmentId, status, otp) => {
        const body = { assignmentId: String(assignmentId), status: status };
        if (otp !== undefined) body.otp = otp;
        return req("/api/delivery/status", { method: "PUT", headers: auth(partnerA), body: body });
    };

    try {
        // ===============================================================
        section("A. AUD-05B: hard transition closure (REJECTED / CANCELLED terminal)");
        // ===============================================================
        // REJECTED is a valid branch from ASSIGNED, but nothing may re-enter the
        // pipeline from it - the exact rank-gap the audit found.
        const orderR = await makeOrder(customer);
        const asgR = (await forceAssign(partnerA, orderR._id)).json.assignment;
        check(asgR && asgR.status === "ASSIGNED", "a force-assigned run starts ASSIGNED", asgR && asgR.status);
        check((await partnerStatus(asgR._id, "ACCEPTED")).status === 200, "ASSIGNED -> ACCEPTED stays allowed");
        const rejected = await partnerStatus(asgR._id, "REJECTED");
        check(rejected.status === 200, "ASSIGNED -> REJECTED is a valid decline branch");
        check((await partnerStatus(asgR._id, "ACCEPTED")).status === 400, "REJECTED -> ACCEPTED is blocked (the rank-gap fix)", rejected.json);
        check((await partnerStatus(asgR._id, "EN_ROUTE")).status === 400, "REJECTED -> EN_ROUTE is blocked (no OTP recycle into a new run)");
        await pinOtp(asgR._id, "1111");
        check((await partnerStatus(asgR._id, "DELIVERED", "1111")).status === 400, "REJECTED -> DELIVERED is blocked even with a valid OTP");

        // CANCELLED is terminal as well.
        const orderC = await makeOrder(customer);
        const asgC = (await forceAssign(partnerA, orderC._id)).json.assignment;
        check((await partnerStatus(asgC._id, "CANCELLED")).status === 200, "ASSIGNED -> CANCELLED is a valid close branch");
        await pinOtp(asgC._id, "2222");
        check((await partnerStatus(asgC._id, "DELIVERED", "2222")).status === 400, "CANCELLED -> DELIVERED is blocked (retains no usable OTP)");
        check((await partnerStatus(asgC._id, "EN_ROUTE")).status === 400, "CANCELLED -> EN_ROUTE is blocked");

        // A real EN_ROUTE -> DELIVERED run, then a replay of the same OTP.
        const orderD = await makeOrder(customer);
        const asgD = (await forceAssign(partnerA, orderD._id)).json.assignment;
        check((await partnerStatus(asgD._id, "ACCEPTED")).status === 200, "normal ASSIGNED -> ACCEPTED works");
        check((await partnerStatus(asgD._id, "ASSIGNED")).status === 400, "status cannot move backwards");
        check((await partnerStatus(asgD._id, "PICKED_UP")).status === 200, "ACCEPTED -> PICKED_UP works");
        check((await partnerStatus(asgD._id, "EN_ROUTE")).status === 200, "PICKED_UP -> EN_ROUTE works");
        check((await partnerStatus(asgD._id, "PICKED_UP")).status === 400, "EN_ROUTE cannot step back to PICKED_UP");
        await pinOtp(asgD._id, "3333");
        check((await partnerStatus(asgD._id, "DELIVERED", "3333")).status === 200, "EN_ROUTE -> DELIVERED with the correct OTP completes the run");
        const afterD = await DeliveryAssignment.findById(asgD._id).lean();
        check(afterD.otpHash === null && afterD.otpVerified === true, "the OTP is wiped on completion (single use)");
        check((await partnerStatus(asgD._id, "DELIVERED", "3333")).status === 400, "a completed run cannot be replayed");
        check((await partnerStatus(asgD._id, "REJECTED")).status === 400, "DELIVERED -> REJECTED is blocked");
        const orderDAfter = await Order.findById(orderD._id).lean();
        check(orderDAfter.status === "Delivered", "the parent order is Delivered", orderDAfter.status);
        const deliveredEntriesD = (orderDAfter.statusHistory || []).filter(function (h) { return h.status === "Delivered"; }).length;
        check(deliveredEntriesD === 1, "exactly ONE Delivered history entry is written (" + deliveredEntriesD + ")");

        // ===============================================================
        section("B. AUD-05A/D: candidate exclusion and no resurrection of closed orders");
        // ===============================================================
        // A partner with an active assignment on this order is not offered it
        // again (the whole-order exclusion protects discovery wholesale).
        const orderX = await makeOrder(customer);
        await forceAssign(partnerA, orderX._id);
        const reBroadcast = await deliveryOpsController.broadcastNewOrder(await Order.findById(orderX._id));
        check(reBroadcast.broadcast === false && reBroadcast.reason === "already assigned",
            "a bound order is not rebroadcast (active-assignment exclusion)", reBroadcast);

        // A closed order must never re-enter the pipeline.
        const closedBroadcast = await deliveryOpsController.broadcastNewOrder(await Order.findById(orderD._id));
        check(closedBroadcast.broadcast === false && closedBroadcast.reason === "order closed",
            "a Delivered order is never broadcast again", closedBroadcast);
        const resurrect = await forceAssign(partnerB, orderD._id);
        check(resurrect.status === 409, "a Delivered order cannot be force-assigned again (got " + resurrect.status + ")", resurrect.json);
        const orderDCount = await DeliveryAssignment.countDocuments({ order: orderD._id });
        check(orderDCount === 1, "still exactly one assignment for the Delivered order", orderDCount);

        // ===============================================================
        section("C. AUD-05C: atomic offer claim + normal delivery regression");
        // ===============================================================
        const orderBody = {
            customer: { name: "Test Customer", phone: "9812312345", address: "12 Test Street", city: "New Delhi", state: "Delhi", pincode: "110001" },
            items: [{ productId: String(product._id), name: product.name, price: product.price, quantity: 2 }],
            payment: "Cash On Delivery",
            paymentMethod: "cod",
            deliverySlot: "Evening (5-8 PM)",
            clientRef: uniq("ref"),
            deliveryLocation: { latitude: DROP.lat, longitude: DROP.lng, accuracy: 12, capturedAt: new Date().toISOString() },
        };
        const created8 = await req("/api/orders", { method: "POST", headers: auth(customer), body: orderBody });
        check(created8.status === 201, "a COD order is created (got " + created8.status + ")", created8.json);
        const order8 = created8.json && created8.json.data;
        const offer8 = await waitFor(async function () {
            const o = await DeliveryOffer.findOne({ order: order8._id }).lean();
            return o && o.notified && o.notified.length ? o : null;
        }, "order 8 broadcast");
        check(!!offer8, "order 8 is broadcast to the online fleet");

        const [claimA, claimB] = await Promise.all([
            req("/api/delivery-ops/offers/" + offer8._id + "/claim", { method: "POST", headers: auth(partnerA) }),
            req("/api/delivery-ops/offers/" + offer8._id + "/claim", { method: "POST", headers: auth(partnerB) }),
        ]);
        const winners = [claimA, claimB].filter(function (r) { return r.status === 200; });
        const losers = [claimA, claimB].filter(function (r) { return r.status === 409; });
        check(winners.length === 1, "exactly ONE partner wins a simultaneous claim", [claimA.status, claimB.status]);
        check(losers.length === 1, "the other partner gets 409 (first come, first served)", [claimA.status, claimB.status]);
        const asg8 = winners.length ? winners[0].json.assignment : null;
        check(asg8 && !!asg8.otpHash && !asg8.otpCode, "the OTP is stored hashed, never in plain text");
        const doubleClaim = await req("/api/delivery-ops/offers/" + offer8._id + "/claim", { method: "POST", headers: auth(partnerA) });
        check(doubleClaim.status === 409, "nobody can claim the winning offer twice");
        const assignments8 = await DeliveryAssignment.countDocuments({ order: order8._id });
        check(assignments8 === 1, "only ONE assignment exists for the order (" + assignments8 + ")");

        // Normal lifecycle to delivery (also the audit's base-flow regression).
        const winnerUser = winners[0] === claimA ? partnerA : partnerB;
        const winnerAuth = auth(winnerUser);
        const pStatus = (assignmentId, status, otp) => {
            const body = { assignmentId: String(assignmentId), status: status };
            if (otp !== undefined) body.otp = otp;
            return req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: body });
        };
        check((await pStatus(asg8._id, "ACCEPTED")).status === 200, "winner ACCEPTED");
        check((await pStatus(asg8._id, "PICKED_UP")).status === 200, "winner PICKED_UP");
        check((await pStatus(asg8._id, "EN_ROUTE")).status === 200, "winner EN_ROUTE");
        await pinOtp(asg8._id, "4444");
        check((await pStatus(asg8._id, "DELIVERED", "4444")).status === 200, "winner DELIVERED with OTP");
        const order8After = await Order.findById(order8._id).lean();
        check(order8After.status === "Delivered" && order8After.paymentStatus === "PAID" && order8After.paid === true,
            "COD order is Delivered and PAID at the door", order8After.status);
        const history8 = (order8After.statusHistory || []).filter(function (h) { return h.status === "Delivered"; }).length;
        check(history8 === 1, "exactly one Delivered history entry on the OTP path (" + history8 + ")");
        const winnerAfter = await User.findById(winnerUser._id).lean();
        check(Number(winnerAfter.deliveryCount) >= 1, "the partner's delivery counter incremented (" + winnerAfter.deliveryCount + ")");

        // ===============================================================
        section("D. AUD-05F: cash / signature recording is idempotent");
        // ===============================================================
        const orderCash = await makeOrder(customer);
        const asgCash = (await forceAssign(partnerA, orderCash._id)).json.assignment;
        const cash1 = await req("/api/delivery-ops/assignments/" + asgCash._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 140 } });
        check(cash1.status === 200 && cash1.json.variance === 0, "first cash confirmation records a zero-variance report", cash1.json);
        const cash2 = await req("/api/delivery-ops/assignments/" + asgCash._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 999 } });
        check(cash2.status === 200 && cash2.json.cashCollected === 140 && cash2.json.message === "Cash already confirmed.",
            "a retried cash confirmation is a no-op that never rewrites the report", cash2.json);
        const cashDoc = await DeliveryAssignment.findById(asgCash._id).lean();
        check(Number(cashDoc.cashCollected) === 140 && !!cashDoc.cashConfirmedAt, "the stored cash figure is unchanged (140)");

        const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const tinyPng2 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const sig1 = await req("/api/delivery-ops/assignments/" + asgCash._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: tinyPng } });
        check(sig1.status === 200, "first signature records the sign-off", sig1.json);
        const sig2 = await req("/api/delivery-ops/assignments/" + asgCash._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: tinyPng2 } });
        check(sig2.status === 200 && sig2.json.message === "Signature already saved.", "a retried sign-off is a no-op", sig2.json);
        const sigDoc = await DeliveryAssignment.findById(asgCash._id).lean();
        check(sigDoc.signature === tinyPng, "the stored signature is unchanged by the retry");

        // ===============================================================
        section("E. AUD-05E: OTP re-issue is closed for every terminal status");
        // ===============================================================
        const reissue = (asgId) => req("/api/delivery-ops/assignments/" + asgId + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "closure test" } });
        check((await reissue(asgR._id)).status === 400, "OTP re-issue is blocked on a REJECTED run (the audit gap)");
        check((await reissue(asgC._id)).status === 400, "OTP re-issue is blocked on a CANCELLED run");
        check((await reissue(asgD._id)).status === 400, "OTP re-issue is blocked on a DELIVERED run");

        // ===============================================================
        section("F. AUD-06: admin manual completion is hardened");
        // ===============================================================
        const order6 = await makeOrder(customer);
        const jump = await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered" } });
        check(jump.status === 400, "admin cannot jump Preparing/Placed straight to Delivered (got " + jump.status + ")", jump.json);
        check((await adminAdvance(admin, order6._id, "Confirmed")).status === 200, "admin advances to Confirmed");
        check((await adminAdvance(admin, order6._id, "Preparing")).status === 200, "admin advances to Preparing");
        check((await adminAdvance(admin, order6._id, "Out for Delivery")).status === 200, "admin advances to Out for Delivery");
        check((await adminAdvance(admin, order6._id, "Delivered")).status === 400, "Delivered without a reason is refused");
        check((await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered", reason: "   " } })).status === 400,
            "a whitespace-only reason is refused");
        check((await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered", reason: "x".repeat(301) } })).status === 400,
            "a reason longer than 300 characters is refused");

        // An active assignment and an open offer coexist with the manual completion.
        const asg6 = (await forceAssign(partnerB, order6._id)).json.assignment;
        await DeliveryOffer.create({ order: order6._id, round: 9, expiresAt: new Date(Date.now() + 120000), notified: [{ user: partnerA._id, inApp: true }] });
        const partnerBCountBefore = (await User.findById(partnerB._id).lean()).deliveryCount || 0;
        const complete6 = await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered", reason: "Handed over personally; customer confirmed by phone." } });
        check(complete6.status === 200, "Delivered with a valid reason succeeds (got " + complete6.status + ")", complete6.json && complete6.json.message);

        const order6After = await Order.findById(order6._id).lean();
        check(order6After.status === "Delivered", "the manual completion marks the order Delivered", order6After.status);
        check(order6After.paymentStatus === "PAID" && order6After.paid === true, "manual COD completion marks the cash as collected at the door", order6After.paymentStatus);
        const delivered6 = (order6After.statusHistory || []).filter(function (h) { return h.status === "Delivered"; });
        check(delivered6.length === 1 && delivered6[0].reason === "Handed over personally; customer confirmed by phone." && String(delivered6[0].by).indexOf("admin:") === 0,
            "exactly one Delivered history entry records the admin and the reason", delivered6);
        const asg6After = await DeliveryAssignment.findById(asg6._id).lean();
        check(asg6After.status === "DELIVERED" && !!asg6After.deliveredAt && asg6After.otpHash === null,
            "the manual completion consumes the active assignment", asg6After.status);
        const active6 = await DeliveryAssignment.countDocuments({ order: order6._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
        check(active6 === 0, "no contradictory active assignment survives the manual completion");
        const offers6 = await DeliveryOffer.find({ order: order6._id }).lean();
        check(offers6.length === 1 && offers6[0].status === "ASSIGNED",
            "the open offer for the order is retired by the manual completion", offers6.map(function (o) { return o.status; }));
        const partnerBCountAfter = (await User.findById(partnerB._id).lean()).deliveryCount || 0;
        check(partnerBCountAfter === partnerBCountBefore && Number(asg6After.earnings || 0) === 0,
            "a manual completion never invents earnings or a delivery count for the partner",
            { before: partnerBCountBefore, after: partnerBCountAfter });

        const dup6 = await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered", reason: "Another note" } });
        check(dup6.status === 200, "a duplicate manual Delivered is a safe no-op (got " + dup6.status + ")");
        const history6Again = (await Order.findById(order6._id).lean()).statusHistory.filter(function (h) { return h.status === "Delivered"; }).length;
        check(history6Again === 1, "the duplicate did not write a second Delivered history entry");
        const backwards6 = await req("/api/orders/" + order6._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Preparing" } });
        check(backwards6.status === 400, "a Delivered order cannot be moved back (got " + backwards6.status + ")");

        // Re-broadcasting or re-assigning the completed order is refused.
        const closedB6 = await deliveryOpsController.broadcastNewOrder(await Order.findById(order6._id));
        check(closedB6.broadcast === false && closedB6.reason === "order closed", "the completed order is not broadcast again");
        const resurrect6 = await forceAssign(partnerA, order6._id);
        check(resurrect6.status === 409, "the completed order cannot be force-assigned again (got " + resurrect6.status + ")");

        // ===============================================================
        section("G. AUD-06 D: online/manual payments are never fabricated");
        // ===============================================================
        const order7 = await makeOrder(customer, { paymentMethod: "online", payment: "UPI - Online", total: 200, paid: false, paymentStatus: "PENDING" });
        check((await adminAdvance(admin, order7._id, "Confirmed")).status === 200, "advance prepaid order to Confirmed");
        check((await adminAdvance(admin, order7._id, "Preparing")).status === 200, "advance prepaid order to Preparing");
        check((await adminAdvance(admin, order7._id, "Out for Delivery")).status === 200, "advance prepaid order to Out for Delivery");
        check((await req("/api/orders/" + order7._id + "/status", { method: "PATCH", headers: auth(admin), body: { status: "Delivered", reason: "Handed over; UPI settled outside" } })).status === 200,
            "a prepaid order can be manually completed with a reason");
        const order7After = await Order.findById(order7._id).lean();
        check(order7After.status === "Delivered", "the prepaid order is Delivered", order7After.status);
        check(order7After.paymentStatus === "PENDING" && order7After.paid === false,
            "an online payment is NOT flipped to PAID by a manual completion (no false cash claim)", order7After.paymentStatus);

        // ===============================================================
        section("H. AUD-05D: the sweep closes an offer it loses to a race");
        // ===============================================================
        const orderRace = await makeOrder(customer);
        const asgRace = (await forceAssign(partnerB, orderRace._id)).json.assignment;
        check(asgRace.status === "ASSIGNED", "a partner already holds the race order");
        // A second broadcast round expires and the auto-assigner fires, but the
        // order is already assigned: the sweep must CLOSE the offer, never leave
        // it ringing or reset it for retry.
        const offerRace = await DeliveryOffer.create({
            order: orderRace._id,
            round: 2,
            expiresAt: new Date(Date.now() - 1000),
            autoAssignAt: new Date(Date.now() - 1000),
            notified: [{ user: partnerA._id, inApp: true }],
        });
        const partnerClean = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Clean Rider", isAvailable: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });
        await User.updateMany({ role: "delivery" }, { $set: { isAvailable: false } });
        await User.updateOne({ _id: partnerClean._id }, { $set: { isAvailable: true } });
        await setOpsSettings({ deliveryAutoAssign: true, deliveryAutoAssignDelaySeconds: 10 });
        const sweep = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweep.status === 200 && sweep.json.autoAssigned === 0, "the sweep does not double-assign the order", sweep.json);
        const offerRaceAfter = await DeliveryOffer.findById(offerRace._id).lean();
        check(offerRaceAfter.status === "CANCELLED" && offerRaceAfter.claimSource === "raced",
            "an offer that lost the race to an existing assignment is closed as raced", offerRaceAfter);
        const raceAssignments = await DeliveryAssignment.countDocuments({ order: orderRace._id });
        check(raceAssignments === 1, "still exactly one assignment for the raced order", raceAssignments);
        const raceClean = await DeliveryAssignment.countDocuments({ deliveryUser: partnerClean._id });
        check(raceClean === 0, "the auto-assigner never gives the raced order to another rider", raceClean);
        const sweep2 = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweep2.json.swept === 0, "the handled offer is never swept twice (idempotent lock)");

        // ===============================================================
        section("I. AUD-02 / AUD-03 regression (unchanged behaviour)");
        // ===============================================================
        const anonReview = await req("/api/products/" + product._id + "/reviews", { method: "POST", body: { rating: 5, comment: "x" } });
        check(anonReview.status === 401, "an anonymous rating is still refused (AUD-02 intact, got " + anonReview.status + ")");
        const track = await req("/api/orders/track/" + order8.trackingId);
        check(track.status === 200, "public tracking still works (AUD-03 intact)");
        const pub = (track.json && track.json.data) || {};
        const pubPartner = pub.deliveryPartner || {};
        check(pubPartner.name && !pub.phone && !("customerEmail" in pub),
            "public tracking still hides the rider's phone and the customer email", pub);
    } finally {
        await new Promise(function (r) { server.close(r); });
    }

    console.log("\n=== RESULT: " + passed + " passed, " + failed + " failed ===");
    if (failures.length) { console.log("failed checks:"); failures.forEach(function (f) { console.log("  - " + f); }); }
}

main()
    .catch(function (e) { console.error("\nTEST CRASHED:", e && e.stack ? e.stack : e); process.exitCode = 1; })
    .then(async function () {
        // Leave nothing behind: drop ONLY the dedicated test database.
        try { await mongoose.connection.dropDatabase(); } catch (e) { /* ignore */ }
        try { await mongoose.disconnect(); } catch (e) { /* ignore */ }
        process.exit(process.exitCode || 0);
    });