'use strict';
// FRESHMART PART 17 — GROWTH FEATURES E2E
// ===============================
// Phase 1 growth surface: Analytics/Metrics foundation, Wallet/Reward ledger,
// Referrals, Repeat-order reminders, Back-in-stock alerts, Reviews with photos
// + Verified Purchase.
//
// SAFETY: runs against a DEDICATED Mongo database (fm_part17_growth_e2e_<pid>).
// The real `freshmart` database is never read or written and the test database
// is dropped on exit. Run with:  node part17_growth_e2e.js
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

const TEST_DB = "fm_part17_growth_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");

process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = "test";

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));
const User = require(path.join(REPO, "models/User"));
const Product = require(path.join(REPO, "models/Product"));
const Order = require(path.join(REPO, "models/Order"));
const Wallet = require(path.join(REPO, "models/Wallet"));
const WalletTransaction = require(path.join(REPO, "models/WalletTransaction"));
const StockAlert = require(path.join(REPO, "models/StockAlert"));
const Notification = require(path.join(REPO, "models/Notification"));
const Review = require(path.join(REPO, "models/Review"));
const { completeOrderDelivery } = require(path.join(REPO, "utils/deliveryCompletion"));

let passed = 0, failed = 0;
const failures = [];
function check(ok, label, extra) {
    if (ok) { passed++; console.log("  [PASS] " + label); }
    else { failed++; failures.push(label); console.log("  [FAIL] " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
function section(title) { console.log("\n--- " + title + " ---"); }

const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });

// The reminder/stock-alert notifications are fired fire-and-forget after a
// delivery, so poll instead of assuming a fixed sleep is enough.
async function waitFor(fn, label, timeoutMs, intervalMs) {
    const deadline = Date.now() + (timeoutMs || 4000);
    intervalMs = intervalMs || 200;
    let last;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) return last;
        await sleep(intervalMs);
    }
    check(false, "timed out waiting: " + label);
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

let seq = 0;
const uniq = (p) => p + "." + process.pid + "." + (seq++) + "@freshmart.test";
const token = (user) => jwt.sign({ id: String(user._id) }, JWT_SECRET, { expiresIn: "1h" });
const auth = (user) => ({ Authorization: "Bearer " + token(user) });

async function makeUser(over) {
    return User.create(Object.assign({
        email: uniq("user"),
        name: "Test User",
        phone: "98" + String(10000000 + (seq++) * 137).slice(0, 8),
        role: "customer",
        emailVerified: true,
        password: "Cust#123456",
    }, over || {}));
}

async function login(email, password) {
    const res = await req("/api/users/login", {
        method: "POST",
        headers: { "X-Request-Token": "1" },
        body: { email: email, password: password },
    });
    return res.json && res.json.token ? res.json.token : null;
}

async function makeDeliveredOrder(user, product, over) {
    return Order.create(Object.assign({
        orderNumber: "FM" + Date.now() + String(seq++),
        trackingId: "FM-17-" + Date.now() + "-" + (seq++),
        customer: { name: user.name, phone: user.phone, address: "12 Test Street", city: "New Delhi", state: "Delhi", pincode: "110001" },
        customerEmail: user.email,
        items: [{ name: product.name, price: product.price, quantity: 2, productId: product._id }],
        subtotal: product.price * 2,
        delivery: 20,
        total: product.price * 2 + 20,
        payment: "Cash On Delivery",
        paymentMethod: "cod",
        paymentStatus: "PAID",
        paid: true,
        status: "Out for Delivery",
        user: user._id,
    }, over || {}));
}

async function main() {
    console.log("=== FRESHMART PART 17: GROWTH FEATURES E2E ===");
    console.log("test database: " + TEST_DB + " (the real database is never touched)");

    await mongoose.connect(TEST_URI);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    const admin = await makeUser({ role: "admin", name: "Growth Admin", phone: "9810000001" });
    const referrer = await makeUser({ name: "Referrer A" });
    const referee = await makeUser({ name: "Referee B" });
    const reviewer = await makeUser({ name: "Reviewer C" });
    const aTok = await login(admin.email, "Cust#123456");
    const rTok = await login(referrer.email, "Cust#123456");
    const bTok = await login(referee.email, "Cust#123456");
    const cTok = await login(reviewer.email, "Cust#123456");
    check(!!aTok && !!rTok && !!bTok && !!cTok, "admin + customer logins work");

    // ===============================
    section("A. Analytics ingestion (public, sanitized, rate-limited)");
    // ===============================
    const bad = await req("/api/analytics/track", { method: "POST", body: { eventName: "nope" } });
    check(bad.status === 400, "unknown analytics event rejected", bad.status);

    const t1 = await req("/api/analytics/track", { method: "POST", body: { eventName: "product_view", anonymousId: "anon-17-" + process.pid, productId: "cat:" + "Vegetables" } });
    const t2 = await req("/api/analytics/track", { method: "POST", body: { eventName: "add_to_cart", anonymousId: "anon-17-" + process.pid, metadata: { name: "Test" } } });
    const t3 = await req("/api/analytics/track", { method: "POST", body: { eventName: "category_view", metadata: { category: "Fruits" } } });
    const t4 = await req("/api/analytics/track", { method: "POST", body: { eventName: "product_search", metadata: { query: "tomato" } } });
    const t5 = await req("/api/analytics/track", { method: "POST", headers: auth(reviewer), body: { eventName: "product_view", productId: "p-auth-" + process.pid } });
    check(t1.status === 200 && t2.status === 200 && t3.status === 200 && t4.status === 200 && t5.status === 200,
        "public + authenticated analytics events accepted", [t1.status, t2.status, t3.status, t4.status, t5.status]);
    await sleep(400);

    const forbid = await req("/api/admin/analytics?range=7d", { headers: auth(reviewer) });
    check(forbid.status === 403, "customer blocked from admin analytics", forbid.status);

    const dash = await req("/api/admin/analytics?range=7d", { headers: auth(admin) });
    check(dash.status === 200 && dash.json && dash.json.success && dash.json.kpis && typeof dash.json.kpis.revenue === "number",
        "admin analytics returns KPIs", dash.status);
    const ev = (dash.json && dash.json.events) || {};
    check(ev.product_view >= 2 && ev.add_to_cart === 1 && ev.product_search === 1 && ev.category_view === 1,
        "admin analytics aggregates each event", ev);

    // Login / signup lifecycle events exist.
    check(ev.login >= 4, "login event recorded", ev.login);

    // ===============================
    section("B. Wallet ledger (idempotent, owner-scoped, admin-gated)");
    // ===============================
    const w0 = await req("/api/wallet", { headers: auth(reviewer) });
    check(w0.status === 200 && w0.json.data.balance === 0, "wallet starts at 0 for a new user", w0.status);

    const cred1 = await req("/api/admin/wallet/credit", {
        method: "POST", headers: auth(admin),
        body: { userId: String(reviewer._id), amount: 100, referenceId: "e2e-credit-1", description: "E2E credit" },
    });
    check(cred1.status === 200 && cred1.json.created === true, "admin credits ₹100", cred1.status);

    const cred2 = await req("/api/admin/wallet/credit", {
        method: "POST", headers: auth(admin),
        body: { userId: String(reviewer._id), amount: 100, referenceId: "e2e-credit-1" },
    });
    check(cred2.status === 200 && cred2.json.created === false, "duplicate admin credit is idempotent");

    const w1 = await req("/api/wallet", { headers: auth(reviewer) });
    check(w1.json.data.balance === 100 && w1.json.data.recentTransactions.length === 1,
        "balance = 100 after one successful credit", w1.json && w1.json.data);

    const wtx = await req("/api/wallet/transactions", { headers: auth(reviewer) });
    check(wtx.status === 200 && Array.isArray(wtx.json.data) && wtx.json.data.length === 1 && wtx.json.data[0].type === "ADMIN_CREDIT",
        "transaction history lists the credit", wtx.status);

    const creditBad = await req("/api/admin/wallet/credit", { method: "POST", headers: auth(reviewer), body: { userId: String(reviewer._id), amount: 10 } });
    check(creditBad.status === 403, "customer cannot admin-credit wallets", creditBad.status);

    const overview = await req("/api/admin/wallet/overview", { headers: auth(admin) });
    check(overview.status === 200 && overview.json && typeof overview.json.data.totalBalance === "number" && overview.json.data.fundedWallets === 1,
        "admin wallet overview returns totals", overview.json && overview.json.data);

    const wOther = await req("/api/wallet", { headers: auth(referrer) });
    check(wOther.json.data.balance === 0, "wallets are owner-scoped (referrer sees 0)", wOther.json.data);

    // ===============================
    section("C. Referral programme (code issuing, claim rules, reward)");
    // ===============================
    const me = await req("/api/referral/me", { headers: auth(referrer) });
    check(me.status === 200 && /^FM[A-Z2-9]{6}$/.test(me.json.data.code), "referral code auto-generated", me.json.data.code);

    const selfClaim = await req("/api/referral/claim", { method: "POST", headers: auth(referrer), body: { code: me.json.data.code } });
    check(selfClaim.status === 400, "self-referral rejected", selfClaim.status);

    const claim = await req("/api/referral/claim", { method: "POST", headers: auth(referee), body: { code: me.json.data.code } });
    check(claim.status === 200 && claim.json.data.referredBy, "referee claims the referrer's code", claim.status);

    const dupClaim = await req("/api/referral/claim", { method: "POST", headers: auth(referee), body: { code: me.json.data.code } });
    check(dupClaim.status === 400, "duplicate claim rejected", dupClaim.status);

    const badClaim = await req("/api/referral/claim", { method: "POST", headers: auth(reviewer), body: { code: "FMZZZZZZ" } });
    check(badClaim.status === 400, "unknown claim code rejected", badClaim.status);

    // Public signup validates the referral code BEFORE any OTP work (no email
    // is needed for the assertion — the code is checked first).
    const badSignup = await req("/api/users/signup", {
        method: "POST",
        body: { name: "Ref Signup", email: uniq("refcheck"), phone: "9811111111", password: "StrongPass#1", referralCode: "FMZZZZZZ" },
    });
    check(badSignup.status === 400 && /does not exist/i.test((badSignup.json && badSignup.json.message) || ""),
        "signup with an invalid referral code is rejected before OTP", badSignup.status);

    // Deliver the referee's FIRST qualifying order → referrer earns ₹50 (ledger
    // entry tagged referral:<orderId>), and it cannot be double-paid.
    const product = await Product.create({
        name: "Part17 Test Carrot", price: 60, unit: "500 g", category: "Vegetables",
        emoji: "🥕", gradient: "#f7c948", stock: 500, active: true,
    });
    const ord1 = await makeDeliveredOrder(referee, product);
    await completeOrderDelivery(ord1, null, { by: "test" });
    await sleep(400);

    const wA = await Wallet.findOne({ user: referrer._id });
    check(wA && wA.balance === 50, "referral reward ₹50 credited to the referrer", wA && wA.balance);
    const refTx = await WalletTransaction.findOne({ type: "REFERRAL_REWARD", referenceId: "referral:" + String(ord1._id) });
    check(!!refTx && refTx.amount === 50, "referral reward has a unique ledger entry", refTx && refTx.amount);

    await completeOrderDelivery(ord1, null, { by: "test" });
    await sleep(200);
    const wA2 = await Wallet.findOne({ user: referrer._id });
    check(wA2 && wA2.balance === 50, "re-delivery does not double-pay the referral reward", wA2 && wA2.balance);

    const refMe = await req("/api/referral/me", { headers: auth(referee) });
    check(refMe.status === 200 && refMe.json.data.referredBy === String(referrer._id), "GET /referral/me shows the link", refMe.json.data);

    // ===============================
    section("D. Back-in-stock alerts");
    // ===============================
    const out = await Product.create({ name: "Part17 Out Veg", price: 40, unit: "kg", category: "Vegetables", emoji: "🥬", stock: 0 });
    const na = await req("/api/stock-alerts", { method: "POST", headers: auth(reviewer), body: { productId: new mongoose.Types.ObjectId().toString() } });
    check(na.status === 404, "stock-alert for a missing product → 404", na.status);

    const sub = await req("/api/stock-alerts", { method: "POST", headers: auth(reviewer), body: { productId: String(out._id) } });
    check(sub.status === 200 && sub.json.data.status === "WAITING", "subscribe to an out-of-stock product", sub.status);

    const resub = await req("/api/stock-alerts", { method: "POST", headers: auth(reviewer), body: { productId: String(out._id) } });
    check(resub.status === 200, "re-subscribing is a no-op (200)", resub.status);

    const waiting = await req("/api/admin/stock-alerts/waiting", { headers: auth(admin) });
    check(waiting.status === 200 && waiting.json.data.waitingTotal === 1, "admin sees 1 waiting alert", waiting.status);

    const restock = await req("/api/products/" + out._id + "/stock", { method: "PATCH", headers: auth(admin), body: { stock: 25 } });
    check(restock.status === 200 && restock.json.data.stock === 25, "admin restocks the product", restock.status);

    await waitFor(function () {
        return Notification.findOne({ type: "stock_alert", user: reviewer._id });
    }, "stock restock notification", 5000);

    const wAfter = await req("/api/admin/stock-alerts/waiting", { headers: auth(admin) });
    check(wAfter.json.data.waitingTotal === 0, "alerts flip to NOTIFIED after restock", wAfter.json.data);
    const stockNotif = await Notification.countDocuments({ type: "stock_alert", user: reviewer._id });
    check(stockNotif >= 1, "restock notification delivered", stockNotif);

    // ===============================
    section("E. Reviews with photos + Verified Purchase");
    // ===============================
    const photoNoAuth = await req("/api/products/" + out._id + "/reviews/photos", { method: "POST", body: { image: "data:image/png;base64,AAAA" } });
    check(photoNoAuth.status === 401, "review photo upload requires auth", photoNoAuth.status);

    // Cloudinary is not configured in the test env → upload path returns 503,
    // proving validation ordering (auth first, then provider availability).
    const photoAuth = await req("/api/products/" + out._id + "/reviews/photos", { method: "POST", headers: auth(reviewer), body: { image: "data:image/png;base64,AAAA" } });
    if (photoAuth.status === 503) {
        check(true, "photo upload enforces auth + provider-gated (503 without Cloudinary)");
    } else {
        check(photoAuth.status === 400, "photo upload rejects junk magic bytes", photoAuth.status);
    }

    const revBefore = await req("/api/products/" + out._id + "/reviews", {
        method: "POST", headers: auth(reviewer),
        body: { rating: 4, comment: "Nice veg", photos: ["https://res.cloudinary.com/x/image/upload/v1/freshmart/reviews/p1.jpg", "http://insecure/2.png", "https://bad/3.png"] },
    });
    // The server normalizes photos: only secure https URLs (max 3) survive, so
    // the insecure http:// entry is dropped while both https entries remain.
    const normPhotos = revBefore.json.data.photos;
    check(revBefore.status === 201 && Array.isArray(normPhotos) && normPhotos.length === 2 && normPhotos.every(function (u) { return u.indexOf("https://") === 0; }),
        "review created with normalized photo list", normPhotos);
    check(revBefore.json.data.verifiedPurchase === false, "not yet verified (no delivered order)", revBefore.json.data.verifiedPurchase);

    // New reviews sit in PENDING moderation and must not surface publicly yet.
    const listedPending = await req("/api/products/" + out._id + "/reviews");
    check(listedPending.status === 200 && listedPending.json.data.length === 0,
        "pending review is withheld until approved", listedPending.status);

    // Approve it through the Review ledger, then it becomes public.
    await Review.updateOne({ _id: revBefore.json.data._id }, { $set: { moderationStatus: "APPROVED" } });
    const listed = await req("/api/products/" + out._id + "/reviews");
    check(listed.status === 200 && listed.json.data.length === 1 && listed.json.data[0].rating === 4 && (listed.json.data[0].photos || []).length === 2,
        "approved review appears in the product review list", listed.status);

    // After a delivered order the same author's NEW review is verified.
    const ordV = await makeDeliveredOrder(reviewer, product);
    await completeOrderDelivery(ordV, null, { by: "test" });
    await sleep(300);
    const revAfter = await req("/api/products/" + product._id + "/reviews", {
        method: "POST", headers: auth(reviewer),
        body: { rating: 5, comment: "Verified!", photos: [] },
    });
    check(revAfter.status === 201 && revAfter.json.data.verifiedPurchase === true,
        "review marked Verified Purchase after a delivered order", revAfter.status);
    await Review.updateOne({ _id: revAfter.json.data._id }, { $set: { moderationStatus: "APPROVED" } });
    const verifiedListed = await req("/api/products/" + product._id + "/reviews");
    check(verifiedListed.status === 200 && verifiedListed.json.data.length === 1 && verifiedListed.json.data[0].verifiedPurchase === true,
        "verified review is publicly listed with Verified Purchase", verifiedListed.status);

    // ===============================
    section("F. Repeat-order reminders + opt-out");
    // ===============================
    const ordR1 = await makeDeliveredOrder(reviewer, product, { orderNumber: "R1-" + Date.now() });
    await completeOrderDelivery(ordR1, null, { by: "test" });
    await sleep(200);
    const ordR2 = await makeDeliveredOrder(reviewer, product, { orderNumber: "R2-" + Date.now() });
    await completeOrderDelivery(ordR2, null, { by: "test" });

    // First delivery alone is not enough; the reminder fires only once a repeat
    // buyer has a second delivered order. Poll, since the hook is fire-and-forget.
    const remind = await waitFor(function () {
        return Notification.findOne({ type: "reminder", user: reviewer._id });
    }, "repeat-order reminder notification", 5000);
    check(!!remind && /^repeat_reminder:/.test(remind.dedupeKey || ""),
        "repeat-order reminder created after the 2nd delivery", remind && remind.dedupeKey);
    check(remind && remind.data && remind.data.link && remind.data.link.indexOf("index.html?search=") === 0,
        "reminder notification deep-links into the store", remind && remind.data && remind.data.link);

    const before = await Notification.countDocuments({ type: "reminder", user: reviewer._id });
    await req("/api/users/me", { method: "PUT", headers: auth(reviewer), body: { reminderOptOut: true } });
    const opt = await req("/api/users/me", { method: "PUT", headers: auth(reviewer), body: { reminderOptOut: true } });
    check(opt.status === 200, "reminder opt-out toggle accepted", opt.status);
    const ordR3 = await makeDeliveredOrder(reviewer, product, { orderNumber: "R3-" + Date.now() });
    await completeOrderDelivery(ordR3, null, { by: "test" });
    await sleep(400);
    const after = await Notification.countDocuments({ type: "reminder", user: reviewer._id });
    check(after === before, "opted-out users get no further reminders", { before: before, after: after });

    // ===============================
    section("G. Cleanup");
    // ===============================
    try { await mongoose.connection.dropDatabase(); } catch (e) { /* ignore */ }
    await mongoose.disconnect();
    server.close();

    console.log("");
    console.log("=== PART 17 RESULT: " + passed + " passed, " + failed + " failed ===");
    if (failures.length) {
        console.log("failures:");
        failures.forEach(function (f) { console.log("  - " + f); });
        process.exit(1);
    }
    process.exit(0);
}

main().catch(function (err) {
    console.error("FATAL: " + ((err && err.stack) || err));
    try { mongoose.disconnect(); } catch (e) {}
    process.exit(1);
});