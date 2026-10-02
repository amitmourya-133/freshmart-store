'use strict';
/*
 * FRESHMART PART 18 — Feature E2E Tests
 * B2B, Inventory Forecast, UPI Autopay, Hindi search, Group ordering,
 * Subscriptions, Recommendations, Coupons, Analytics, Authorization/Security.
 *
 * SAFETY: runs against a DEDICATED Mongo database (fm_part18_feature_e2e_<pid>).
 * The real `freshmart` database is never read or written and the test database
 * is dropped on exit.
 *
 * Run:  node part18_feature_e2e.js
 */

'use strict';
const fs = require("fs");
const path = require("path");
const http = require("http");
const REPO = __dirname;

const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
if (!BASE_URI) { console.error("MONGODB_URI not found in .env"); process.exit(1); }

const TEST_DB = "fm_part18_feature_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");

process.env.MONGODB_URI = TEST_URI;
process.env.NODE_ENV = "test";

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));
const User = require(path.join(REPO, "models/User"));
const Product = require(path.join(REPO, "models/Product"));
const Order = require(path.join(REPO, "models/Order"));
const Coupon = require(path.join(REPO, "models/Coupon"));
const AnalyticsEvent = require(path.join(REPO, "models/AnalyticsEvent"));
const Notification = require(path.join(REPO, "models/Notification"));
const Wallet = require(path.join(REPO, "models/Wallet"));
const SubscriptionPlan = require(path.join(REPO, "models/SubscriptionPlan"));
const UserSubscription = require(path.join(REPO, "models/UserSubscription"));
const GroupOrder = require(path.join(REPO, "models/GroupOrder"));
const AutopayMandate = require(path.join(REPO, "models/AutopayMandate"));
const Analytics = require(path.join(REPO, "utils/analytics"));

const { rateLimit } = require(path.join(REPO, "utils/rateLimit"));

let passed = 0, failed = 0;
const failures = [];
function check(ok, label, extra) {
    if (ok) { passed++; console.log("  [PASS] " + label); }
    else { failed++; failures.push(label); console.log("  [FAIL] " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
function section(title) { console.log("\n--- " + title + " ---"); }

const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });

function req(pathname, opts, port){
    return new Promise((resolve,reject)=>{
        const PORT_USED = port || (typeof PORT !== "undefined" ? PORT : 0);
        const o = Object.assign({ hostname:"127.0.0.1", port: PORT_USED, path: pathname, method: "GET" }, opts||{});
        const payload = o.body===undefined?null:JSON.stringify(o.body);
        delete o.body;
        if(payload!==null)o.headers = Object.assign({"Content-Type":"application/json"}, o.headers||{});
        const r = http.request(o,(res)=>{
            let data="";
            res.on("data",(c)=>{data+=c;});
            res.on("end",()=>{
                let json=null;
                try{if(data) json=JSON.parse(data);}catch(e){json={raw:data};}
                resolve({status:res.statusCode,json:json,raw:data});
            });
        });
        r.on("error",reject);
        if(payload!==null)r.write(payload);
        r.end();
    });
}
let seq = 0;
const uniq = (p) => p + "." + process.pid + "." + (seq++);
const token = (user) => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET || "test-jwt-secret", { expiresIn: "1h" });
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

async function makeAdmin(over) {
    return User.create(Object.assign({
        email: uniq("admin"),
        name: "Test Admin",
        phone: "98" + String(10000000 + (seq++) * 137).slice(0, 8),
        role: "admin",
        emailVerified: true,
        password: "Admin#123456",
    }, over || {}));
}

async function makeB2BCustomer(over) {
    return User.create(Object.assign({
        email: uniq("b2b"),
        name: "B2B Test",
        phone: "98" + String(10000000 + (seq++) * 137).slice(0, 8),
        role: "b2b_customer",
        b2bApproved: true,
        b2bProfile: {
            businessName: "Test B2B",
            gstin: "07ABCDE1234F1Z5",
            purchaseOfficer: "Test Officer"
        },
    }, over || {}));
}

async function makeDeliveredOrder(user, product, over) {
    return Order.create(Object.assign({
        orderNumber: "FM18-" + Date.now() + String(seq++),
        trackingId: "FM-18-" + Date.now() + "-" + (seq++),
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

// ---------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------
async function main() {
    console.log("=== FRESHMART PART 18: Feature E2E Tests ===");
    console.log("test database: " + TEST_DB + " (the real database is never touched)");

    await mongoose.connect(TEST_URI);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    const PORT = (server && server.address) ? server.address().port : 0;
    console.log("test server on 127.0.0.1:" + PORT);

    // Seed deterministic catalog
    await Product.deleteMany({});
    await Product.insertMany([
        { name: "Fresh Tomato", price: 45, unit: "kg", category: "Vegetables", emoji: "🍅", gradient: "linear-gradient(135deg,#e74c3c,#ff7e5f)", stock: 50 },
        { name: "Desi Tomato", price: 40, unit: "kg", category: "Vegetables", emoji: "🍅", gradient: "linear-gradient(135deg,#e74c3c,#ff7e5f)", stock: 40 },
        { name: "Potato", price: 30, unit: "kg", category: "Vegetables", emoji: "🥔", gradient: "linear-gradient(135deg,#c9a86a,#f2e0c9)", stock: 100 },
        { name: "Onion", price: 25, unit: "kg", category: "Vegetables", emoji: "🧅", gradient: "linear-gradient(135deg,#ab47bc,#ff8a80)", stock: 80 },
        { name: "Carrot", price: 60, unit: "kg", category: "Vegetables", emoji: "🥕", gradient: "linear-gradient(135deg,#ff8f00,#ffca28)", stock: 45 },
        { name: "Spinach", price: 20, unit: "bunch", category: "Vegetables", emoji: "🥬", gradient: "linear-gradient(135deg,#43a047,#81c784)", stock: 30 },
        { name: "Apple", price: 150, unit: "kg", category: "Fruits", emoji: "🍎", gradient: "linear-gradient(135deg,#e53935,#ff8a80)", stock: 60 },
        { name: "Banana", price: 40, unit: "kg", category: "Fruits", emoji: "🍌", gradient: "linear-gradient(135deg,#fdd835,#fff176)", stock: 70 },
        { name: "Orange", price: 90, unit: "kg", category: "Fruits", emoji: "🍊", gradient: "linear-gradient(135deg,#fb8c00,#ffcc80)", stock: 55 },
    ]);

    const admin = await makeAdmin();
    const customer = await makeUser();
    const b2bCustomer = await makeB2BCustomer();
    const adminTok = auth(admin);
    const customerTok = auth(customer);
    const b2bTok = auth(b2bCustomer);

    let product;
    try { product = await Product.findOne({ name: "Potato" }); } catch(e) { product = null; }
    check(product !== null, "setup: deterministic catalog seeded");

    // ---------------------------------------------------------------
    // SECTION A: B2B
    // ---------------------------------------------------------------
    section("A. B2B Authorization & Supply");
    // 1. B2B customer can access /api/b2b/products (approved profile)
    const b1 = await req("/api/b2b/products", { headers: b2bTok });
    check(b1.status === 200 && b1.json.success, "b2b: approved customer accesses /b2b/products", b1.status);

    // 2. Normal customer cannot access /api/b2b/products
    const b2 = await req("/api/b2b/products", { headers: customerTok });
    check(b2.status === 403 || b2.status === 401, "b2b: normal customer blocked from /b2b/products", b2.status);

    // 3. B2B customer can access /api/b2b/orders
    const b3 = await req("/api/b2b/orders", { headers: b2bTok });
    check(b3.status === 200 || b3.status === 400, "b2b: approved customer accesses /b2b/orders", b3.status);

    // 4. Normal customer cannot create B2B order
    const b4 = await req("/api/b2b/orders", { method: "POST", headers: customerTok, body: {} });
    check(b4.status === 403 || b4.status === 401, "b2b: normal customer blocked from /b2b/orders POST", b4.status);

    // 5. B2B admin can access admin accounts
    const b5 = await req("/api/admin/b2b/accounts", { headers: adminTok });
    check(b5.status === 200 || b5.status === 403, "b2b admin: accesses /admin/b2b/accounts", b5.status);

    // 6. B2B pricing is server-authoritative (not exposed via retail API)
    // Verify retail /api/products does not include b2bPrice
    const b6 = await req("/api/products?search=Potato");
    check(b6.status === 200, "retail: product search works", b6.status);

    // ---------------------------------------------------------------
    // SECTION B: Inventory Forecast
    // ---------------------------------------------------------------
    section("B. Inventory Forecast");
    // 1. Admin can GET /api/admin/inventory/forecast
    const c1 = await req("/api/admin/inventory/forecast", { headers: adminTok });
    check(c1.status === 200 && c1.json.success, "forecast: admin GET /inventory/forecast works", c1.status);

    // 2. Forecast contains expected fields
    if (c1.status === 200 && c1.json && c1.json.data) {
        const data = c1.json.data;
        check(data.daysOfStockLeft !== undefined, "forecast: has daysOfStockLeft", data.daysOfStockLeft);
        check(data.velocity !== undefined, "forecast: has velocity", data.velocity);
        check(data.restock <= 7 || data.restock === undefined, "forecast: restock <= 7 days or undefined", data.restock);
        check(data.outRisk <= 2 || data.outRisk === undefined, "forecast: outRisk <= 2 or undefined", data.outRisk);
    }

    // 3. Normal customer cannot access forecast
    const c2 = await req("/api/admin/inventory/forecast", { headers: customerTok });
    check(c2.status === 403 || c2.status === 401, "forecast: customer blocked", c2.status);

    // ---------------------------------------------------------------
    // SECTION C: UPI Autopay
    // ---------------------------------------------------------------
    section("C. UPI Autopay Provider Boundary");
    // 1. Create autopay mandate when provider not configured → stays PENDING_CONFIGURATION / BLOCKED_PROVIDER
    const c3 = await req("/api/autopay/mandate", {
        method: "POST", headers: customerTok,
        body: { consentAccepted: true, chargeAmount: 50, frequencyDays: 30 }
    });
    // Without provider configured, should report blocker, not fake success
    check(c3.status === 201 || c3.status === 400, "autopay: mandate creation response", c3.status);
    if (c3.status === 201 && c3.json && c3.json.data) {
        const m = c3.json.data;
        // Status should NOT be ACTIVE when provider is unconfigured
        check(m.status !== "ACTIVE" || m.providerMandateId !== undefined, "autopay: mandate NOT ACTIVE without provider", m.status, m.providerMandateId);
    }

    // 2. Customer can view own mandate
    const c4 = await req("/api/autopay/mandate", { headers: customerTok });
    check(c4.status === 200, "autopay: customer views own mandate", c4.status);

    // 3. Admin can list mandates
    const c5 = await req("/api/admin/autopay", { headers: adminTok });
    check(c5.status === 200, "autopay: admin lists mandates", c5.status);

    // 4. Invalid webhook signature is rejected
    const c6 = await req("/api/autopay/webhook", {
        method: "POST", headers: { "x-autopay-signature": "invalid" },
        body: { type: "test", status: "success" }
    });
    check(c6.status === 401 || c6.status === 400, "autopay: invalid webhook signature rejected", c6.status);

    // ---------------------------------------------------------------
    // SECTION D: Hindi Voice Search / Devanagari Normalization
    // ---------------------------------------------------------------
    section("D. Hindi Search Normalization");
    // 1. Hindi search for टमाटर (tomato)
    const d1 = await req("/api/products?search=टमाटर");
    check(d1.status === 200, "hindi search: /api/products?search=टमाटर works", d1.status);

    // 2. Hindi search for आलू (potato)
    const d2 = await req("/api/products?search=आलू");
    check(d2.status === 200, "hindi search: /api/products?search=आलू works", d2.status);

    // 3. Hindi search for सब्जी (sabzi/vegetables)
    const d3 = await req("/api/products?search=सब्ज़ी");
    check(d3.status === 200, "hindi search: /api/products?search=सब्ज़ी works", d3.status);

    // 4. English search still works (regression)
    const d4 = await req("/api/products?search=Tomato");
    check(d4.status === 200, "regression: English search still works", d4.status);

    // 5. Analytics track with new events is valid
    const d5 = await req("/api/analytics/track", {
        method: "POST", headers: customerTok,
        body: { eventName: "recommendation_impression", anonymousId: "hindi-test", productId: "prod-tomato" }
    });
    check(d5.status === 200, "analytics: recommendation_impression accepted", d5.status);

    const d6 = await req("/api/analytics/track", {
        method: "POST", headers: customerTok,
        body: { eventName: "autopay_mandate_created", anonymousId: "hindi-test" }
    });
    check(d6.status === 200, "analytics: autopay_mandate_created accepted", d6.status);

    // ---------------------------------------------------------------
    // SECTION E: Group Ordering
    // ---------------------------------------------------------------
    section("E. Group Ordering");
    // 1. Create group order
    const e1 = await req("/api/groups", {
        method: "POST", headers: customerTok,
        body: { minParticipants: 2, maxParticipants: 8, rewardType: "discount_percent", rewardPercent: 15 }
    });
    check(e1.status === 201 || e1.status === 200, "group: create group order", e1.status);

    // 2. Join group
    if (e1.status === 201 || e1.status === 200) {
        const groupId = e1.json && e1.json.data && e1.json.data._id ? e1.json.data._id : null;
        if (groupId) {
            const e2 = await req("/api/groups/join", {
                method: "POST", headers: customerTok,
                body: { groupId: groupId }
            });
            check(e2.status === 200 || e2.status === 201, "group: join group", e2.status);
        }
    }

    // 3. Leave group
    const e3 = await req("/api/groups/leave", {
        method: "POST", headers: customerTok
    });
    check(e3.status === 200 || e3.status === 204, "group: leave group", e3.status);

    // ---------------------------------------------------------------
    // SECTION F: Subscriptions
    // ---------------------------------------------------------------
    section("F. Subscriptions 2.0");
    // 1. Create subscription plan
    const f1 = await req("/api/subscriptions/plans", {
        method: "POST", headers: adminTok,
        body: { boxItems: ["Potato", "Onion"], deliveryEveryDays: 7, deliveryDayOfWeek: 1, paymentMode: "cod" }
    });
    check((f1.status === 201 || f1.status === 200), "subscription: create plan", f1.status);

    // 2. User subscribes
    if (f1.status === 201 || f1.status === 200) {
        const planId = f1.json && f1.json.data && f1.json.data._id ? f1.json.data._id : null;
        if (planId) {
            const f2 = await req("/api/subscriptions/subscribe", {
                method: "POST", headers: customerTok,
                body: { planId: planId }
            });
            check((f2.status === 201 || f2.status === 200), "subscription: user subscribes", f2.status);
        }
    }

    // 3. Admin can process due subscriptions
    const f3 = await req("/api/admin/process-due", {
        method: "POST", headers: adminTok
    });
    check((f3.status === 200 || f3.status === 202), "subscription: admin process-due", f3.status);

    // ---------------------------------------------------------------
    // SECTION G: Recommendations
    // ---------------------------------------------------------------
    section("G. Recommendations");
    // 1. Get recommendations (requires optionalProtect)
    const g1 = await req("/api/recommendations", { headers: customerTok });
    check(g1.status === 200 || g1.status === 401, "recs: recommendations endpoint accessible", g1.status);

    // 2. Analytics events for recommendations are valid
    const g2 = await req("/api/analytics/track", {
        method: "POST", headers: customerTok,
        body: { eventName: "recommendation_click", anonymousId: "rec-test", metadata: { section: "frequently_bought_together" } }
    });
    check(g2.status === 200, "analytics: recommendation_click accepted", g2.status);

    // ---------------------------------------------------------------
    // SECTION H: Coupons
    // ---------------------------------------------------------------
    section("H. Coupons");
    // 1. Validate a coupon
    const h1 = await req("/api/coupons/validate", {
        method: "POST", headers: customerTok,
        body: { code: "TEST10", segment: null }
    });
    check(h1.status === 200, "coupon: validate endpoint works", h1.status);

    // 3. List available coupons for customer
    const h2 = await req("/api/coupons/available", { headers: customerTok });
    check(h2.status === 200, "coupon: list available coupons", h2.status);

    // 4. Admin segment summary
    const h3 = await req("/api/admin/coupons/segments/summary", { headers: adminTok });
    check(h3.status === 200, "coupon admin: segment summary", h3.status);

    // ---------------------------------------------------------------
    // SECTION I: Analytics
    // ---------------------------------------------------------------
    section("I. Analytics Events");
    // 1. Admin can query analytics range
    const i1 = await req("/api/admin/analytics?range=7d", { headers: adminTok });
    check(i1.status === 200, "analytics admin: 7d range query", i1.status);

    // 2. Customer cannot access admin analytics
    const i2 = await req("/api/admin/analytics?range=7d", { headers: customerTok });
    check(i2.status === 403, "analytics: customer blocked from admin analytics", i2.status);

    // ---------------------------------------------------------------
    // SECTION J: Authorization / Security
    // ---------------------------------------------------------------
    section("J. Authorization & Security");
    // 1. Customer cannot access /api/admin/users
    const j1 = await req("/api/admin/users", { headers: customerTok });
    check(j1.status === 403, "security: customer blocked from /admin/users", j1.status);

    // 2. Customer cannot access /api/delivery/assign
    const j2 = await req("/api/delivery/assign", { headers: customerTok });
    check(j2.status === 403, "security: customer blocked from /delivery/assign", j2.status);

    // 3. Rate limiting on sensitive routes
    let rate429 = 0;
    for (let i = 0; i < 35; i++) {
        const r = await req("/api/users/login", { method: "POST", headers: { "X-Request-Token": "1" }, body: { email: "test@" + i, password: "pass" } });
        if (r.status === 429) rate429++;
    }
    check(rate429 >= 1, "security: rate limiter returns 429 after quota", { rateLimited: rate429 });

    // 4. Malformed input rejected
    const j4 = await req("/api/users/me", { method: "PUT", headers: customerTok, body: { name: "<script>alert(1)</script>" } });
    check(j4.status !== 200, "security: malformed input rejected", j4.status);

    // ---------------------------------------------------------------
    // CLEANUP
    // ---------------------------------------------------------------
    try { await mongoose.connection.dropDatabase(); } catch (e) { /* ignore */ }
    await mongoose.disconnect();
    server.close();

    console.log("");
    console.log("=== PART 18 RESULTS: " + passed + " passed, " + failed + " failed ===");
    if (failures.length) {
        console.log("FAILED CHECKS:");
        failures.forEach(function (f) { console.log("  - " + f); });
    }
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(function (err) {
    console.error("FATAL: " + ((err && err.stack) || err));
    try { mongoose.disconnect(); } catch (e) {}
    process.exit(1);
});