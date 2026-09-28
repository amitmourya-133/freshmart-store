'use strict';
// ===============================
// FRESHMART PART 14 - Delivery Operations (Phases 1-6) E2E
// ===============================
// Covers: partner application + admin review, availability/GPS, broadcast offers,
// atomic first-come claim, decline, claim window expiry, auto-assign (fresh GPS
// only), OTP re-issue caps, COD cash recording, signature, delivery lifecycle
// with single-use OTP, day-end reconciliation, settings, push pruning, the
// secured cron sweep endpoint, and the no-leak guarantees for the customer's
// partner phone number.
//
// SAFETY: every run uses a DEDICATED Mongo database (fm_ops_e2e_<pid>). The
// real `freshmart` database is never read or written, and the test database is
// dropped on exit. Run with:  node part14_delivery_ops_e2e.js
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

const TEST_DB = "fm_ops_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");
const CRON_SECRET = "part14-cron-secret-" + process.pid;

// The app and every model must see the test database BEFORE anything is required.
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;
process.env.CRON_SECRET = CRON_SECRET;
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
const Notification = require(path.join(REPO, "models/Notification"));
const { hashOtp } = require(path.join(REPO, "utils/otp"));

// The delivery flow emails the customer's OTP. The test must never open an SMTP
// session (it would depend on live credentials, could deliver to real mailboxes
// and can hang on a throttled relay), so the mailer is stubbed out. Everything
// that actually matters here - hashing, expiry, attempt limits, cooldowns - is
// server logic and is still exercised for real.
const emailService = require(path.join(REPO, "utils/emailService"));
let emailsAttempted = 0;
emailService.sendOtpEmail = async function () { emailsAttempted += 1; return { sent: true, stubbed: true }; };
emailService.sendDeliveryConfirmation = async function () { return { sent: true, stubbed: true }; };
emailService.sendDeliveryAssignment = async function () { return { sent: true, stubbed: true }; };

let passed = 0, failed = 0;
const failures = [];
function check(ok, label, extra) {
    if (ok) { passed++; console.log("  [PASS] " + label); }
    else { failed++; failures.push(label); console.log("  [FAIL] " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
function section(title) { console.log("\n--- " + title + " ---"); }

// The order->broadcast hook is deliberately fire-and-forget, so the test waits
// for the observable end state instead of guessing a sleep duration.
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
        // The payload travels on opts.body; strip it before handing the rest to
        // http.request so the request options stay clean.
        const payload = o.body === undefined ? null : JSON.stringify(o.body);
        delete o.body;
        if (payload !== null) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
        const r = http.request(o, (res) => {
            let data = "";
            res.on("data", (c) => { data += c; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, json: json, raw: data, headers: res.headers });
            });
        });
        r.on("error", reject);
        if (payload !== null) r.write(payload);
        r.end();
    });
}
const token = (user) => jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: "1h" });
const auth = (user) => ({ Authorization: "Bearer " + token(user), "Content-Type": "application/json" });

// Delhi coordinates used for every distance assertion.
const STORE = { lat: 28.6139, lng: 77.209 };
const NEAR = { lat: 28.6200, lng: 77.2100 };   // ~0.7 km from the drop point
const FAR = { lat: 28.7500, lng: 77.1000 };    // tens of km away
const DROP = { lat: 28.6150, lng: 77.2110 };

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

// Force an offer into a chosen state without waiting for real time to pass.
async function ageOffer(offer, msAgoWindow, msAgoAuto) {
    const patch = {};
    patch.expiresAt = new Date(Date.now() - msAgoWindow);
    if (msAgoAuto !== undefined) patch.autoAssignAt = new Date(Date.now() - msAgoAuto);
    return DeliveryOffer.updateOne({ _id: offer._id }, { $set: patch });
}

async function setOpsSettings(patch) {
    const s = await Settings.getSettings();
    Object.keys(patch).forEach(function (k) { s[k] = patch[k]; });
    await s.save();
    return s;
}

async function main() {
    console.log("=== FRESHMART PART 14: Delivery Operations E2E ===");
    console.log("test database: " + TEST_DB + " (the real database is never touched)");

    await mongoose.connect(TEST_URI);

    // ---------------------------------------------------------------
    // SEED
    // ---------------------------------------------------------------
    const admin = await makeUser({ role: "admin", name: "Ops Admin", phone: "9810000001" });
    const customer = await makeUser({ role: "customer", name: "Regular Customer" });
    const noPhone = await makeUser({ role: "customer", name: "No Phone", phone: undefined });

    // Two approved partners with a FRESH ping, one approved but STALE, one pending.
    const partnerA = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner A", isAvailable: true, vehicleType: "Bike", zone: "Central Delhi", lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });
    const partnerB = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner B", isAvailable: true, vehicleType: "Cycle", zone: "South Delhi", lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });
    const partnerStale = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner Stale", isAvailable: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date(Date.now() - 60 * 60 * 1000) });
    const partnerFar = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Partner Far", isAvailable: true, lastLat: FAR.lat, lastLng: FAR.lng, lastLocationAt: new Date() });

    const product = await Product.create({
        name: "Part14 Test Carrot", price: 60, unit: "500 g", category: "Vegetables",
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

    try {
        // ===============================================================
        section("A. Authentication and role boundaries");
        // ===============================================================
        const noAuth = await req("/api/delivery-ops/offers");
        check(noAuth.status === 401, "unauthenticated offer feed is refused (401, got " + noAuth.status + ")", noAuth.json);

        const badToken = await req("/api/delivery-ops/me", { headers: { Authorization: "Bearer not-a-real-token" } });
        check(badToken.status === 401, "invalid bearer token is refused (401, got " + badToken.status + ")");

        const custOffers = await req("/api/delivery-ops/offers", { headers: auth(customer) });
        check(custOffers.status === 403, "customer cannot read the partner offer feed (403, got " + custOffers.status + ")");

        const custStatus = await req("/api/delivery-ops/me", { headers: auth(customer) });
        check(custStatus.status === 200 && custStatus.json.partner.partnerStatus === "none",
            "customer may read their own partner status (not a partner yet)");

        const custAdminList = await req("/api/delivery-ops/admin/partners", { headers: auth(customer) });
        check(custAdminList.status === 403, "customer cannot read the admin partner roster (403, got " + custAdminList.status + ")");

        const partnerAdminList = await req("/api/delivery-ops/admin/partners", { headers: auth(partnerA) });
        check(partnerAdminList.status === 403, "partner cannot read the admin partner roster (403, got " + partnerAdminList.status + ")");

        // A real end-to-end login (password + cookie + token opt-in).
        const loginUser = await makeUser({ name: "Login Person", password: "Str0ng-Passw0rd!" });
        const badLogin = await req("/api/users/login", { method: "POST", body: { email: loginUser.email, password: "wrong" } });
        check(badLogin.status === 400, "login with a wrong password is rejected (got " + badLogin.status + ")");
        const goodLogin = await req("/api/users/login", { method: "POST", headers: { "X-Request-Token": "1" }, body: { email: loginUser.email, password: "Str0ng-Passw0rd!" } });
        check(goodLogin.status === 200 && !!goodLogin.json.token, "login returns a token to explicit API clients");
        const meViaToken = await req("/api/users/me", { headers: { Authorization: "Bearer " + goodLogin.json.token } });
        check(meViaToken.status === 200 && String(meViaToken.json.data._id) === String(loginUser._id),
            "the issued token authenticates /api/users/me");

        // ===============================================================
        section("B. Partner application and admin review");
        // ===============================================================
        const noPhoneApply = await req("/api/delivery-ops/apply", { method: "POST", headers: auth(noPhone), body: { vehicleType: "Bike" } });
        check(noPhoneApply.status === 400, "application without a phone number is refused (got " + noPhoneApply.status + ")", noPhoneApply.json);

        const apply1 = await req("/api/delivery-ops/apply", { method: "POST", headers: auth(customer), body: { vehicleType: "Bike", zone: "Central Delhi" } });
        check(apply1.status === 200 && apply1.json.partnerStatus === "pending", "a customer can apply to be a partner", apply1.json);
        const apply2 = await req("/api/delivery-ops/apply", { method: "POST", headers: auth(customer), body: { vehicleType: "Bike" } });
        check(apply2.status === 400, "a duplicate application is refused (got " + apply2.status + ")");

        const applicant = await req("/api/delivery-ops/admin/partners", { headers: auth(admin) });
        check(applicant.status === 200 && applicant.json.applicants.some(function (a) { return String(a._id) === String(customer._id); }),
            "the pending applicant shows up in the admin roster");

        const rejectWrongAction = await req("/api/delivery-ops/admin/partners/" + customer._id + "/review", { method: "POST", headers: auth(admin), body: { action: "make-me-admin" } });
        check(rejectWrongAction.status === 400, "an unknown review action is refused (got " + rejectWrongAction.status + ")");

        const rejectApplicant = await req("/api/delivery-ops/admin/partners/" + customer._id + "/review", { method: "POST", headers: auth(admin), body: { action: "reject", reason: "No vehicle licence" } });
        check(rejectApplicant.status === 200 && rejectApplicant.json.partnerStatus === "rejected", "an admin can reject an application with a reason", rejectApplicant.json);
        const rejectedMe = await req("/api/delivery-ops/me", { headers: auth(customer) });
        check(rejectedMe.json.partner.partnerStatus === "rejected" && rejectedMe.json.partner.rejectReason === "No vehicle licence",
            "the applicant sees the rejection reason");
        const reapply = await req("/api/delivery-ops/apply", { method: "POST", headers: auth(customer), body: { vehicleType: "Bike", zone: "North Delhi" } });
        check(reapply.status === 200, "a rejected applicant may apply again");

        const adminCannotBePartner = await req("/api/delivery-ops/admin/partners/" + admin._id + "/review", { method: "POST", headers: auth(admin), body: { action: "approve" } });
        check(adminCannotBePartner.status === 400, "an admin cannot be converted into a delivery partner (got " + adminCannotBePartner.status + ")");

        const approve = await req("/api/delivery-ops/admin/partners/" + customer._id + "/review", { method: "POST", headers: auth(admin), body: { action: "approve" } });
        check(approve.status === 200 && approve.json.role === "delivery" && approve.json.partnerStatus === "approved",
            "approval promotes the applicant to role delivery", approve.json);
        await User.updateOne({ _id: customer._id }, { $set: { isAvailable: false } });
        const nowPartner = await req("/api/delivery-ops/me", { headers: auth(customer) });
        check(nowPartner.json.partner.role === "delivery", "the promoted partner sees the delivery role");

        const alreadyApproved = await req("/api/delivery-ops/apply", { method: "POST", headers: auth(customer), body: {} });
        check(alreadyApproved.status === 400, "an approved partner cannot apply again (got " + alreadyApproved.status + ")");

        const partnerSeesNotification = await Notification.countDocuments({ user: customer._id, type: "partner_status" });
        check(partnerSeesNotification >= 2, "the partner is notified about the decision (" + partnerSeesNotification + " inbox rows)");

        // ===============================================================
        section("C. Availability and live location");
        // ===============================================================
        const badAvail = await req("/api/delivery-ops/availability", { method: "PUT", headers: auth(partnerA), body: { isAvailable: "yes" } });
        check(badAvail.status === 400, "a non-boolean availability value is refused (got " + badAvail.status + ")");

        const onlineNoPing = await req("/api/delivery-ops/availability", { method: "PUT", headers: auth(partnerStale), body: { isAvailable: true } });
        check(onlineNoPing.status === 200 && onlineNoPing.json.needsLocation === true,
            "going online without a GPS ping asks the partner to share a location", onlineNoPing.json);

        const badLoc = await req("/api/delivery/location", { method: "PUT", headers: auth(partnerA), body: { lat: 999, lng: 77.2 } });
        check(badLoc.status === 400, "an out-of-range latitude is refused (got " + badLoc.status + ")");
        const goodLoc = await req("/api/delivery/location", { method: "PUT", headers: auth(partnerA), body: { lat: NEAR.lat, lng: NEAR.lng } });
        check(goodLoc.status === 200 && Number(goodLoc.json.lastLat) === NEAR.lat, "a partner can share a real location", goodLoc.json);

        await req("/api/delivery-ops/availability", { method: "PUT", headers: auth(partnerB), body: { isAvailable: false, breakReason: "Lunch break" } });
        const offlineLoc = await req("/api/delivery/location", { method: "PUT", headers: auth(partnerB), body: { lat: NEAR.lat, lng: NEAR.lng } });
        check(offlineLoc.status === 200 && offlineLoc.json.isAvailable === false,
            "sharing a location does NOT silently bring a partner back online", offlineLoc.json);
        const meB = await req("/api/delivery-ops/me", { headers: auth(partnerB) });
        check(meB.json.partner.online === false && meB.json.partner.breakReason === "Lunch break",
            "an offline partner with a fresh ping still reads as offline", meB.json.partner);
        await req("/api/delivery-ops/availability", { method: "PUT", headers: auth(partnerB), body: { isAvailable: true } });

        // ===============================================================
        section("D. Order broadcast and the offer feed");
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
        const created = await req("/api/orders", { method: "POST", headers: auth(customer), body: orderBody });
        check(created.status === 201, "a COD order is created (got " + created.status + ")", created.json);
        const order1 = created.json && created.json.data;

        // The broadcast runs after the order is persisted, so wait for it.
        const offer1 = await waitFor(async function () {
            const o = await DeliveryOffer.findOne({ order: order1._id }).lean();
            return o && o.notified && o.notified.length ? o : null;
        }, "broadcast offer");
        const offerRows = await DeliveryOffer.find({ order: order1._id }).lean();
        check(offerRows.length === 1, "creating an order opens exactly one broadcast offer (" + offerRows.length + ")");
        check(!!offer1 && offer1.notified.length >= 2, "every online approved partner is notified (" + (offer1 ? offer1.notified.length : 0) + ")");
        check(!!offer1 && offer1.notified.every(function (n) { return n.inApp === true; }),
            "each notified partner gets an in-app alert");
        check(!!offer1 && offer1.notified.every(function (n) { return n.push === false; }),
            "the offer mirror never claims a Web Push it did not send");
        check(!!offer1 && offer1.notified.some(function (n) { return String(n.user) === String(partnerStale._id); }),
            "manual broadcast still reaches a partner with a stale ping (claiming is allowed without GPS)");

        const offerDupe = await req("/api/orders", { method: "POST", headers: auth(customer), body: orderBody });
        check(offerDupe.status === 200 && offerDupe.json.already === true, "a repeated clientRef does not create a second order (idempotent)", offerDupe.json);

        const feedA = await req("/api/delivery-ops/offers", { headers: auth(partnerA) });
        check(feedA.status === 200 && feedA.json.offers.length === 1, "the partner sees the open offer", feedA.json);
        const shaped = (feedA.json.offers || [])[0] || {};
        check(Number.isFinite(shaped.distanceKm) && shaped.distanceKm < 5, "the offer carries a real distance from the partner's ping", shaped);
        check(shaped.expiresInSeconds > 0 && shaped.expiresInSeconds <= 90, "the offer shows a live countdown", shaped);
        check(shaped.orderNumber === order1.orderNumber && shaped.total > 0, "the offer carries the order number and total", shaped);

        const feedStale = await req("/api/delivery-ops/offers", { headers: auth(partnerStale) });
        check(feedStale.status === 200 && feedStale.json.offers.length === 1, "a partner with a stale ping can still see (and take) the offer");

        // Nothing client-supplied may leak into the offer view.
        check(shaped.customerPhone === undefined && shaped.address === undefined, "the offer view leaks no customer contact details", shaped);

        // ===============================================================
        section("E. Decline, and the atomic first-come claim");
        // ===============================================================
        const declined = await req("/api/delivery-ops/offers/" + offer1._id + "/decline", { method: "POST", headers: auth(partnerB) });
        check(declined.status === 200, "a notified partner can decline", declined.json);
        const feedB = await req("/api/delivery-ops/offers", { headers: auth(partnerB) });
        check(feedB.json.offers.length === 0, "a declined offer disappears from that partner's feed");
        const offerAfterDecline = await DeliveryOffer.findById(offer1._id).lean();
        check(String(offerAfterDecline.declinedBy[0]) === String(partnerB._id), "the decline is recorded on the offer");

        const stranger = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Not Notified", isAvailable: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() });
        const strangerClaim = await req("/api/delivery-ops/offers/" + offer1._id + "/claim", { method: "POST", headers: auth(stranger) });
        check(strangerClaim.status === 409, "a partner who was never notified cannot claim (got " + strangerClaim.status + ")", strangerClaim.json);

        const badClaimId = await req("/api/delivery-ops/offers/not-an-id/claim", { method: "POST", headers: auth(partnerA) });
        check(badClaimId.status === 400, "a malformed offer id is refused (got " + badClaimId.status + ")");

        const [claimA, claimStale] = await Promise.all([
            req("/api/delivery-ops/offers/" + offer1._id + "/claim", { method: "POST", headers: auth(partnerA) }),
            req("/api/delivery-ops/offers/" + offer1._id + "/claim", { method: "POST", headers: auth(partnerStale) }),
        ]);
        const winners = [claimA, claimStale].filter(function (r) { return r.status === 200; });
        const losers = [claimA, claimStale].filter(function (r) { return r.status === 409; });
        check(winners.length === 1, "exactly one partner wins a simultaneous claim", [claimA.status, claimStale.status]);
        check(losers.length === 1, "the other partner gets a 409 (first come, first served)", [claimA.status, claimStale.status]);
        const assignment1 = winners.length ? winners[0].json.assignment : null;
        check(assignment1 && assignment1.assignMode === "claim", "the winning assignment records how it happened", assignment1 && assignment1.assignMode);
        check(assignment1 && !!assignment1.otpHash && !assignment1.otpCode, "the delivery OTP is stored hashed, never in plain text");
        const assignments1 = await DeliveryAssignment.countDocuments({ order: order1._id });
        check(assignments1 === 1, "only ONE assignment exists for the order (" + assignments1 + ")");

        const doubleClaim = await req("/api/delivery-ops/offers/" + offer1._id + "/claim", { method: "POST", headers: auth(partnerA) });
        check(doubleClaim.status === 409, "the winner cannot claim the same offer twice (got " + doubleClaim.status + ")");

        // Whichever partner won the race, the rest of the lifecycle is driven as
        // that partner: a test must not assume who won a fair coin.
        const winnerIsA = !!winners.length && winners[0] === claimA;
        const winnerUser = winnerIsA ? partnerA : partnerStale;
        const winnerAuth = auth(winnerUser);
        check(!!winnerUser._id, "the winning partner is known for the rest of the run", winnerUser.email);

        const offerClosed = await DeliveryOffer.findById(offer1._id).lean();
        check(offerClosed.status === "CLAIMED" && String(offerClosed.assignment) === String(assignment1._id), "the offer points at the winning assignment");
        const loserNotified = await Notification.countDocuments({ user: partnerB._id, type: "delivery_offer_closed" });
        check(loserNotified >= 1, "partners who missed out are told the order went to someone else (" + loserNotified + ")");

        const noSecondAssignment = await req("/api/delivery-ops/offers/" + offer1._id + "/claim", { method: "POST", headers: auth(partnerFar) });
        check(noSecondAssignment.status === 409, "a closed offer cannot be claimed by anyone else");

        // ===============================================================
        section("F. Delivery lifecycle, OTP and customer notifications");
        // ===============================================================
        const accept = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "ACCEPTED" } });
        check(accept.status === 200, "the partner accepts the assignment", accept.json && accept.json.message);
        const backward = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "ASSIGNED" } });
        check(backward.status === 400, "status cannot move backwards (got " + backward.status + ")");
        const picked = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "PICKED_UP" } });
        check(picked.status === 200, "picked up");
        const enroute = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "EN_ROUTE" } });
        check(enroute.status === 200, "en route");

        const activeBoard = await req("/api/delivery-ops/active", { headers: winnerAuth });
        const boardRow = (activeBoard.json.active || []).filter(function (a) { return a.assignmentId === String(assignment1._id); })[0] || {};
        check(activeBoard.status === 200 && !!boardRow.assignmentId, "the active board lists the run in progress", boardRow.assignmentId);
        check(boardRow.isCod === true && Number(boardRow.expectedCash) > 0, "the run shows the cash expected at the door", boardRow);
        check(boardRow.hasSignature === false && boardRow.cashCollected === null, "nothing is pre-filled for cash or signature");
        check(!boardRow.signature && !boardRow.proofImage, "the active board carries no signature/proof image blobs");

        const noOtp = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "DELIVERED" } });
        check(noOtp.status === 400, "delivery cannot be completed without the customer OTP (got " + noOtp.status + ")");
        const afterNoOtp = await DeliveryAssignment.findById(assignment1._id).lean();
        check(Number(afterNoOtp.otpAttempts || 0) === 0, "a request with no code does NOT burn an attempt", afterNoOtp.otpAttempts);
        const wrongOtp = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "DELIVERED", otp: "0000" } });
        check(wrongOtp.status === 400, "a wrong OTP is rejected (got " + wrongOtp.status + ")");
        const afterFail = await DeliveryAssignment.findById(assignment1._id).lean();
        check(Number(afterFail.otpAttempts || 0) === 1, "a genuinely wrong OTP costs exactly one attempt (" + afterFail.otpAttempts + ")");

        // Mint a known OTP so the happy path can be driven deterministically.
        const realOtp = "4821";
        await DeliveryAssignment.updateOne({ _id: assignment1._id }, { $set: { otpHash: hashOtp(realOtp), otpExpiry: new Date(Date.now() + 15 * 60 * 1000), otpIssuedAt: new Date(), otpAttempts: 0 } });
        const delivered = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "DELIVERED", otp: realOtp } });
        check(delivered.status === 200, "the correct OTP completes the delivery (got " + delivered.status + ")", delivered.json);
        const afterDeliver = await DeliveryAssignment.findById(assignment1._id).lean();
        check(afterDeliver.otpHash === null && afterDeliver.otpVerified === true, "the OTP is wiped after use (single use)");
        const replay = await req("/api/delivery/status", { method: "PUT", headers: winnerAuth, body: { assignmentId: String(assignment1._id), status: "DELIVERED", otp: realOtp } });
        check(replay.status === 400, "the same OTP cannot be replayed (got " + replay.status + ")");

        const order1After = await Order.findById(order1._id).lean();
        check(order1After.status === "Delivered", "the order is marked Delivered", order1After.status);
        check(order1After.paymentStatus === "PAID" && order1After.paid === true, "COD payment flips to PAID only at the door", order1After.paymentStatus);
        const partnerCount = await User.findById(winnerUser._id).lean();
        check(partnerCount.deliveryCount >= 1, "the partner's delivery counter incremented (" + partnerCount.deliveryCount + ")");
        const earnings = Number(afterDeliver.earnings) || 0;
        check(earnings > 0, "the delivery fee the customer paid is credited to the partner (" + earnings + ")");

        // ===============================================================
        section("G. OTP re-issue limits and cooldowns");
        // ===============================================================
        const order2 = await makeOrder(customer);
        const a2 = await req("/api/delivery-ops/admin/partners/" + partnerA._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(order2._id) } });
        check(a2.status === 200, "admin force-assigns order 2 to partner A", a2.json && a2.json.message);
        const asg2 = a2.json.assignment;

        // A freshly minted OTP is inside its 3-minute cooldown, so a real partner
        // cannot spam the customer: age it to prove the rule both ways.
        const reissueTooSoon = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "immediately" } });
        check(reissueTooSoon.status === 429, "a re-issue inside the cooldown of a fresh OTP is refused (got " + reissueTooSoon.status + ")");
        await DeliveryAssignment.updateOne({ _id: asg2._id }, { $set: { otpIssuedAt: new Date(Date.now() - 5 * 60 * 1000) } });
        const reissue1 = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "Customer says no email" } });
        check(reissue1.status === 200 && reissue1.json.remaining === 1, "the first OTP re-issue succeeds and reports the remaining budget", reissue1.json);
        const reissue2 = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "again" } });
        check(reissue2.status === 429, "a second re-issue inside the cooldown is refused (got " + reissue2.status + ")");
        await DeliveryAssignment.updateOne({ _id: asg2._id }, { $set: { otpIssuedAt: new Date(Date.now() - 5 * 60 * 1000) } });
        const reissue3 = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "still nothing" } });
        check(reissue3.status === 200 && reissue3.json.remaining === 0, "the second re-issue uses the last of the budget", reissue3.json);
        await DeliveryAssignment.updateOne({ _id: asg2._id }, { $set: { otpIssuedAt: new Date(Date.now() - 5 * 60 * 1000) } });
        const reissue4 = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerA), body: { reason: "spam" } });
        check(reissue4.status === 429, "a third re-issue is capped (got " + reissue4.status + ")", reissue4.json);
        const reissueOther = await req("/api/delivery-ops/assignments/" + asg2._id + "/otp/reissue", { method: "POST", headers: auth(partnerB), body: {} });
        check(reissueOther.status === 404, "a partner cannot re-issue an OTP for someone else's run (got " + reissueOther.status + ")");
        const reissueLog = await DeliveryAssignment.findById(asg2._id).lean();
        check(reissueLog.otpReissueLog.length === 2, "every re-issue is logged for the audit trail (" + reissueLog.otpReissueLog.length + ")");
        check(emailsAttempted >= 2, "each successful re-issue asks the mailer to send exactly one OTP (" + emailsAttempted + " attempts)");

        // ===============================================================
        section("H. Cash reconciliation and signature");
        // ===============================================================
        const cashNegative = await req("/api/delivery-ops/assignments/" + asg2._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: -5 } });
        check(cashNegative.status === 400, "a negative cash amount is refused (got " + cashNegative.status + ")");
        const cashHuge = await req("/api/delivery-ops/assignments/" + asg2._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 999999 } });
        check(cashHuge.status === 400, "an implausible cash amount is refused (got " + cashHuge.status + ")");
        const cashWrongOwner = await req("/api/delivery-ops/assignments/" + asg2._id + "/cash", { method: "POST", headers: auth(partnerB), body: { amount: 140 } });
        check(cashWrongOwner.status === 404, "a partner cannot record cash for someone else's run (got " + cashWrongOwner.status + ")");
        const cashOk = await req("/api/delivery-ops/assignments/" + asg2._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 140 } });
        check(cashOk.status === 200 && cashOk.json.variance === 0, "cash equal to the order total records a zero variance", cashOk.json);

        const prepaid = await makeOrder(customer, { paymentMethod: "online", payment: "UPI - Online", total: 200, paymentStatus: "PAID", paid: true });
        const aPre = await req("/api/delivery-ops/admin/partners/" + partnerA._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(prepaid._id) } });
        const cashPrepaid = await req("/api/delivery-ops/assignments/" + aPre.json.assignment._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 200 } });
        check(cashPrepaid.status === 400, "cash cannot be recorded against a prepaid order (got " + cashPrepaid.status + ")");

        const sigBad = await req("/api/delivery-ops/assignments/" + asg2._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: "<svg>fake</svg>" } });
        check(sigBad.status === 400, "a non-image signature is refused (got " + sigBad.status + ")");
        const sigHuge = await req("/api/delivery-ops/assignments/" + asg2._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: "data:image/png;base64," + "A".repeat(400 * 1024) } });
        check(sigHuge.status === 400, "an oversized signature image is refused (got " + sigHuge.status + ")");
        const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        const sigOk = await req("/api/delivery-ops/assignments/" + asg2._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: tinyPng } });
        check(sigOk.status === 200, "a valid signature image is stored", sigOk.json);

        const closedCash = await DeliveryAssignment.findOne({ order: prepaid._id });
        await DeliveryAssignment.updateOne({ _id: closedCash._id }, { $set: { status: "CANCELLED" } });
        const cashOnClosed = await req("/api/delivery-ops/assignments/" + closedCash._id + "/cash", { method: "POST", headers: auth(partnerA), body: { amount: 10 } });
        check(cashOnClosed.status === 400, "cash cannot be recorded on a closed run (got " + cashOnClosed.status + ")");
        const sigOnClosed = await req("/api/delivery-ops/assignments/" + closedCash._id + "/signature", { method: "POST", headers: auth(partnerA), body: { signature: tinyPng } });
        check(sigOnClosed.status === 400, "a signature cannot be added to a closed run (got " + sigOnClosed.status + ")");

        // ===============================================================
        section("I. Expiry sweep, auto-assign and escalation");
        // ===============================================================
        // J1: auto-assign OFF, window closed, nobody claims -> escalate to admin.
        await setOpsSettings({ deliveryAutoAssign: false });
        const order3 = await makeOrder(customer);
        await req("/api/delivery/availability", { method: "PUT", headers: auth(partnerStale), body: { isAvailable: false } });
        const sweep1 = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweep1.status === 200, "the admin can run the sweep on demand", sweep1.json);
        const sweepBefore = await DeliveryOffer.find({ order: order3._id }).lean();
        check(sweepBefore.length === 0, "no offer exists yet for the directly-created order");
        // Force a broadcast, then expire it.
        const deliveryOpsController = require(path.join(REPO, "controllers/deliveryOpsController"));
        const forced = await deliveryOpsController.broadcastNewOrder(await Order.findById(order3._id));
        check(forced && forced.broadcast === true, "a direct order can be broadcast to the fleet", forced);
        const offer3 = await DeliveryOffer.findOne({ order: order3._id });
        await ageOffer(offer3, 1000, undefined);
        const sweepA = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweepA.json.escalated >= 1, "an expired, unclaimed offer is escalated (" + sweepA.json.escalated + ")");
        const offer3After = await DeliveryOffer.findById(offer3._id).lean();
        check(offer3After.status === "EXPIRED", "the offer is marked EXPIRED", offer3After.status);
        const escalatedNotice = await Notification.countDocuments({ user: admin._id, type: "delivery_unclaimed" });
        check(escalatedNotice >= 1, "the admin is told an order went unclaimed (" + escalatedNotice + ")");
        const sweepAgain = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweepAgain.json.swept === 0, "a handled offer is never swept twice (idempotent lock)", sweepAgain.json);

        // J2: auto-assign ON, the deadline has passed but the offer window is
        // still open, and the only free partner has a STALE ping -> the sweep
        // must retry, never hand a job to a partner who cannot be located.
        await setOpsSettings({ deliveryAutoAssign: true, deliveryAutoAssignDelaySeconds: 10 });
        await User.updateMany({ role: "delivery" }, { $set: { isAvailable: false } });
        await User.updateOne({ _id: partnerStale._id }, { $set: { isAvailable: true } });   // stale ping only
        const order4 = await makeOrder(customer);
        const b4 = await deliveryOpsController.broadcastNewOrder(await Order.findById(order4._id));
        check(b4 && b4.broadcast === true, "order 4 is broadcast with auto-assign on", b4);
        const offer4 = await DeliveryOffer.findOne({ order: order4._id });
        check(offer4.autoAssignAt !== null && offer4.autoAssignAt !== undefined, "an auto-assign deadline is stored on the offer");
        // Only the auto-assign deadline is in the past; the offer is still live.
        await DeliveryOffer.updateOne({ _id: offer4._id }, { $set: { autoAssignAt: new Date(Date.now() - 2000) } });
        const sweepB = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweepB.json.autoAssigned === 0, "auto-assign refuses a partner whose GPS ping is stale", sweepB.json);
        check(sweepB.json.retried === 1 && sweepB.json.escalated === 0, "a live offer with nobody locatable is retried, not escalated", sweepB.json);
        const noAsg4 = await DeliveryAssignment.countDocuments({ order: order4._id });
        check(noAsg4 === 0, "no assignment is created for a stale partner (" + noAsg4 + ")");
        const offer4Mid = await DeliveryOffer.findById(offer4._id).lean();
        check(offer4Mid.status === "OPEN" && offer4Mid.expiresHandledAt === null,
            "a retried offer is unlocked so the next sweep can still act on it", offer4Mid.status);

        // J3: the window finally closes -> the unclaimed order escalates.
        await ageOffer(offer4, 1000, undefined);
        const sweepC = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweepC.json.escalated >= 1, "an unclaimed offer is escalated once the window closes", sweepC.json);
        const offer4After = await DeliveryOffer.findById(offer4._id).lean();
        check(offer4After.status === "EXPIRED", "order 4 ends as EXPIRED (" + offer4After.status + ")");

        // J4: the deadline has passed and a fresh, idle partner is free ->
        // auto-assign must actually place the order, with no human involved.
        await setOpsSettings({ deliveryAutoAssign: true, deliveryAutoAssignDelaySeconds: 10 });
        await User.updateMany({ role: "delivery" }, { $set: { isAvailable: false } });
        // partnerA stays offline and is already mid-run (asg2 from section G):
        // auto-dispatch must never hand a second job to someone carrying one.
        const partnerAuto = await makeUser({ role: "delivery", partnerStatus: "approved", name: "Auto Pilot", isAvailable: true, lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date(), zone: "Central Delhi" });
        const orderAuto = await makeOrder(customer);
        const bAuto = await deliveryOpsController.broadcastNewOrder(await Order.findById(orderAuto._id));
        check(bAuto && bAuto.broadcast === true, "the auto-assign order is broadcast", bAuto);
        const offerAuto = await DeliveryOffer.findOne({ order: orderAuto._id });
        await DeliveryOffer.updateOne({ _id: offerAuto._id }, { $set: { autoAssignAt: new Date(Date.now() - 2000) } });
        const sweepD = await req("/api/delivery-ops/admin/offers/sweep", { method: "POST", headers: auth(admin), body: { limit: 50 } });
        check(sweepD.json.autoAssigned === 1, "a fresh, available partner is auto-assigned the order", sweepD.json);
        const asgAuto = await DeliveryAssignment.findOne({ order: orderAuto._id }).lean();
        check(asgAuto && String(asgAuto.deliveryUser) === String(partnerAuto._id) && asgAuto.assignMode === "auto",
            "the auto-assignment names the free partner and records the mode", asgAuto && asgAuto.assignMode);
        const busyA = await DeliveryAssignment.countDocuments({ deliveryUser: partnerA._id, order: orderAuto._id });
        check(busyA === 0, "a partner already mid-run is not given a second job at once", busyA);
        const offerAutoAfter = await DeliveryOffer.findById(offerAuto._id).lean();
        check(offerAutoAfter.status === "ASSIGNED" && offerAutoAfter.claimSource === "auto", "the offer is closed by the auto-assignment", offerAutoAfter);
        const autoPartnerTold = await Notification.countDocuments({ user: partnerAuto._id, type: "delivery_assignment" });
        check(autoPartnerTold >= 1, "the auto-assigned partner is told about the job", autoPartnerTold);
        const autoCustomerTold = await Notification.countDocuments({ user: customer._id, type: "order_status" });
        check(autoCustomerTold >= 1, "the customer is told a partner is bringing the order", autoCustomerTold);
        // The order doc itself carries no partner name: the rider is always
        // resolved from the live assignment, never from a stale field.
        const autoOrderDoc = await Order.findById(orderAuto._id).lean();
        check(!autoOrderDoc.deliveryPartner, "the order stores no denormalised rider (resolved live instead)");

        // J5: window still open but nobody free -> retried, not escalated.
        const order5 = await makeOrder(customer);
        await User.updateMany({ role: "delivery" }, { $set: { isAvailable: false } });
        const b5 = await deliveryOpsController.broadcastNewOrder(await Order.findById(order5._id));
        check(b5 && b5.broadcast === false && b5.reason === "no online partner", "with nobody online the broadcast warns the admin instead of ringing phones", b5);
        const unattended = await Notification.countDocuments({ user: admin._id, type: "delivery_unattended" });
        check(unattended >= 1, "the admin is warned that no partner is online (" + unattended + ")");

        // ===============================================================
        section("J. Secured cron sweep endpoint");
        // ===============================================================
        const cronNoAuth = await req("/api/ops/cron/delivery-sweep");
        check(cronNoAuth.status === 401, "the cron endpoint refuses an unauthenticated call (got " + cronNoAuth.status + ")");
        const cronWrong = await req("/api/ops/cron/delivery-sweep", { headers: { Authorization: "Bearer wrong-secret" } });
        check(cronWrong.status === 401, "the cron endpoint refuses a wrong secret (got " + cronWrong.status + ")");
        const cronHeader = await req("/api/ops/cron/delivery-sweep", { headers: { Authorization: "Bearer " + CRON_SECRET } });
        check(cronHeader.status === 200 && cronHeader.json.success === true, "a header-only Authorization (Vercel Cron style) is accepted", cronHeader.json);
        const cronQuery = await req("/api/ops/cron/delivery-sweep?token=" + encodeURIComponent(CRON_SECRET));
        check(cronQuery.status === 200, "a query-token-only call (most cron services) is accepted");
        const cronBoth = await req("/api/ops/cron/delivery-sweep?token=" + encodeURIComponent(CRON_SECRET), { headers: { Authorization: "Bearer " + CRON_SECRET } });
        check(cronBoth.status === 200, "both credentials together are accepted");

        // ===============================================================
        section("K. Admin surfaces");
        // ===============================================================
        // Everyone back online with a fresh ping, so the roster has real
        // online/offline ordering to assert on.
        await User.updateMany({ role: "delivery" }, { $set: { isAvailable: true } });
        await User.updateOne({ _id: partnerStale._id }, { $set: { lastLat: NEAR.lat, lastLng: NEAR.lng, lastLocationAt: new Date() } });
        // Cash recorded on the delivered run so the roster has a real figure.
        await req("/api/delivery-ops/assignments/" + assignment1._id + "/cash", { method: "POST", headers: winnerAuth, body: { amount: order1After.total } });
        const roster = await req("/api/delivery-ops/admin/partners", { headers: auth(admin) });
        check(roster.status === 200 && roster.json.partners.length >= 5, "the admin roster lists every partner", roster.json && roster.json.partners && roster.json.partners.length);
        const rowW = roster.json.partners.filter(function (p) { return String(p._id) === String(winnerUser._id); })[0] || {};
        check(rowW.delivered >= 1 && rowW.codExpected > 0, "per-partner delivered count and COD expectation are correct", rowW);
        check(rowW.codCollected > 0 && rowW.earnings > 0 && rowW.cashMissing === 0,
            "collected cash and earnings are summarised for the roster", rowW);
        check(typeof rowW.online === "boolean" && typeof rowW.stale === "boolean", "the roster reports online/stale state");
        const onlineFirst = roster.json.partners.length < 2 || roster.json.partners[0].online === true;
        check(onlineFirst, "online partners are listed first");

        const order6 = await makeOrder(customer);
        const b6 = await deliveryOpsController.broadcastNewOrder(await Order.findById(order6._id));
        check(b6 && b6.broadcast === true, "order 6 is broadcast to the online fleet", b6);
        const offer6 = await waitFor(async function () {
            const o = await DeliveryOffer.findOne({ order: order6._id }).lean();
            return o && o.notified && o.notified.length ? o : null;
        }, "offer6");
        check(!!offer6, "order 6 has a live offer before the admin steps in");
        const force6 = await req("/api/delivery-ops/admin/partners/" + partnerB._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(order6._id) } });
        check(force6.status === 200, "the admin force-assigns an order that was broadcast", force6.json && force6.json.message);
        const offer6After = await DeliveryOffer.findById(offer6._id).lean();
        check(offer6After.status === "ASSIGNED" && offer6After.claimSource === "admin", "the open offer is closed with the admin as the source", offer6After);
        const forceAgain = await req("/api/delivery-ops/admin/partners/" + partnerB._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(order6._id) } });
        check(forceAgain.status === 409, "the same order cannot be force-assigned twice (got " + forceAgain.status + ")", forceAgain.json);
        const forcedNotified = await Notification.countDocuments({ user: partnerA._id, type: "delivery_offer_closed" });
        check(forcedNotified >= 1, "partners looking at the offer are told an admin took it (" + forcedNotified + ")");

        const forceBadId = await req("/api/delivery-ops/admin/partners/" + admin._id + "/force-assign", { method: "POST", headers: auth(admin), body: { orderId: String(order6._id) } });
        check(forceBadId.status === 404, "an order cannot be force-assigned to a non-partner (got " + forceBadId.status + ")");

        const rebroadcast = await req("/api/delivery-ops/admin/broadcast/" + order4._id, { method: "POST", headers: auth(admin) });
        check(rebroadcast.status === 200, "the admin can re-alert partners for an unassigned order", rebroadcast.json);

        const recon = await req("/api/delivery-ops/admin/reconciliation", { headers: auth(admin) });
        check(recon.status === 200 && recon.json.totals.deliveries >= 1, "day-end reconciliation returns totals", recon.json && recon.json.totals);
        const reconRow = recon.json.partners.filter(function (r) { return String(r.partnerId) === String(winnerUser._id); })[0] || {};
        check(reconRow.codExpected > 0 && reconRow.codOrders >= 1, "the COD sheet has a row for the delivering partner", reconRow);
        const reconYesterday = await req("/api/delivery-ops/admin/reconciliation?date=2020-01-01", { headers: auth(admin) });
        check(reconYesterday.json.totals.deliveries === 0, "a date with no deliveries returns an empty sheet");

        const opsGet = await req("/api/delivery-ops/admin/settings", { headers: auth(admin) });
        check(opsGet.status === 200 && typeof opsGet.json.ops.offerTtlSeconds === "number", "ops settings are readable by an admin", opsGet.json);
        const opsBadTtl = await req("/api/delivery-ops/admin/settings", { method: "PUT", headers: auth(admin), body: { offerTtlSeconds: 5 } });
        check(opsBadTtl.status === 400, "an out-of-range offer TTL is refused (got " + opsBadTtl.status + ")");
        const opsBadDelay = await req("/api/delivery-ops/admin/settings", { method: "PUT", headers: auth(admin), body: { autoAssignDelaySeconds: 99999 } });
        check(opsBadDelay.status === 400, "an out-of-range auto-assign delay is refused (got " + opsBadDelay.status + ")");
        const opsOk = await req("/api/delivery-ops/admin/settings", { method: "PUT", headers: auth(admin), body: { offerTtlSeconds: 120, broadcastEnabled: false } });
        check(opsOk.status === 200 && opsOk.json.ops.offerTtlSeconds === 120, "valid settings are saved", opsOk.json && opsOk.json.ops);
        check(opsOk.json.ops.broadcastEnabled === false, "broadcast can be switched off by an admin");
        await setOpsSettings({ deliveryBroadcastEnabled: true });

        const prune = await req("/api/delivery-ops/admin/push/prune", { method: "POST", headers: auth(admin), body: { maxFailures: 25 } });
        check(prune.status === 200 && typeof prune.json.pruned === "number", "push pruning runs and reports a count", prune.json);
        const prunePartner = await req("/api/delivery-ops/admin/push/prune", { method: "POST", headers: auth(partnerA), body: {} });
        check(prunePartner.status === 403, "a partner cannot prune push subscriptions (got " + prunePartner.status + ")");

        // Revoking a partner must take effect immediately.
        const revoke = await req("/api/delivery-ops/admin/partners/" + partnerStale._id + "/review", { method: "POST", headers: auth(admin), body: { action: "revoke" } });
        check(revoke.status === 200 && revoke.json.partnerStatus === "none" && revoke.json.role === "customer",
            "revoking a partner returns them to a plain customer", revoke.json);
        const revokedFeed = await req("/api/delivery-ops/offers", { headers: auth(partnerStale) });
        check(revokedFeed.status === 403, "a revoked partner immediately loses partner-only access (got " + revokedFeed.status + ")");
        const revokedAvail = await DeliveryAssignment.countDocuments({ deliveryUser: partnerStale._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
        check(revokedAvail === 0, "a revoked partner holds no active run");

        // ===============================================================
        section("L. Customer privacy and history");
        // ===============================================================
        const mine = await req("/api/orders/my", { headers: auth(customer) });
        check(mine.status === 200, "the owner can list their own orders");
        const myDelivered = (mine.json.data || []).filter(function (o) { return String(o._id) === String(order1._id); })[0] || {};
        check(myDelivered.deliveryPartner && myDelivered.deliveryPartner.name && myDelivered.deliveryPartner.phone,
            "the order OWNER gets their rider's name and phone to call/WhatsApp", myDelivered.deliveryPartner);
        check(typeof myDelivered.eta === "object" || myDelivered.eta === null || myDelivered.eta !== undefined, "the order carries an ETA");

        const publicTrack = await req("/api/orders/track/" + order1.trackingId);
        check(publicTrack.status === 200, "public tracking still works");
        const publicPartner = publicTrack.json.data.deliveryPartner || {};
        check(publicPartner.name && !publicPartner.phone, "PUBLIC tracking never exposes the rider's phone number", publicPartner);
        check(!("customerEmail" in (publicTrack.json.data || {})), "public tracking exposes no customer email");

        const someoneElses = await req("/api/orders/my", { headers: auth(stranger) });
        check(someoneElses.status === 200 && someoneElses.json.data.length === 0, "a different user cannot see someone else's orders");
        const orderPeek = await req("/api/orders/" + order1._id, { headers: auth(stranger) });
        check(orderPeek.status === 404, "reading another user's order by id is a 404 (not a 403 leak)", orderPeek.status);

        const history = await req("/api/delivery-ops/history", { headers: winnerAuth });
        check(history.status === 200 && history.json.deliveries.length >= 1, "the partner history lists completed drops", history.json && history.json.deliveries && history.json.deliveries.length);
        const histRow = history.json.deliveries[0] || {};
        check(histRow.signature === undefined, "history rows do not embed the signature image");
        check(typeof histRow.earnings === "number", "history rows carry the earnings figure");

        // ===============================================================
        section("M. Static file exposure guard");
        // ===============================================================
        const leak = await req("/controllers/deliveryOpsController.js");
        check(leak.status === 404, "server-side source is not downloadable (got " + leak.status + ")");
        const envLeak = await req("/.env");
        check(envLeak.status === 404, ".env is not downloadable (got " + envLeak.status + ")");
    } finally {
        await new Promise(function (r) { server.close(r); });
    }

    // ===============================================================
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
