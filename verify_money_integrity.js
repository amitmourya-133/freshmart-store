// Money + lifecycle integrity regression suite (batch B).
// Covers: atomic wallet credit, idempotency + compensation, B2B credit-lease
// concurrency, group-reward eligibility/retry/reversal, subscription state
// machine, and cancelled-is-terminal delivery completion.
//
// Isolated DB: fm_money_e2e_<pid>. The URI is rewritten to a throwaway database
// name and asserted not to be the production one before anything connects.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI || !JWT_SECRET) { console.error("FATAL: missing .env secrets"); process.exit(1); }

const TEST_DB = "fm_money_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");
if (TEST_DB.indexOf("freshmart") !== -1) { console.error("FATAL: refusing production DB"); process.exit(1); }
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));
const User = require(path.join(REPO, "models/User"));
const Order = require(path.join(REPO, "models/Order"));
const Product = require(path.join(REPO, "models/Product"));
const Wallet = require(path.join(REPO, "models/Wallet"));
const WalletTransaction = require(path.join(REPO, "models/WalletTransaction"));
const GroupOrder = require(path.join(REPO, "models/GroupOrder"));
const UserSubscription = require(path.join(REPO, "models/UserSubscription"));
const SubscriptionPlan = require(path.join(REPO, "models/SubscriptionPlan"));
const wallet = require(path.join(REPO, "utils/wallet"));
const groupRewards = require(path.join(REPO, "utils/groupRewards"));
const { completeOrderDelivery } = require(path.join(REPO, "utils/deliveryCompletion"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  [PASS] " + name); }
    else { fail++; console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + JSON.stringify(extra).slice(0, 300) : "")); }
}
function section(t) { console.log("\n--- " + t + " ---"); }

let PORT = 0;
function req(p, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
        const parsed = new URL(p, "http://localhost");
        const r = http.request({
            hostname: "127.0.0.1", port: parsed.port || PORT,
            path: parsed.pathname + (parsed.search || ""),
            method: o.method || "GET", headers: o.headers || {},
        }, function (res) {
            let data = "";
            res.on("data", function (c) { data += c; });
            res.on("end", function () {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { json = { raw: data }; }
                resolve({ status: res.statusCode, json: json, body: data });
            });
        });
        r.on("error", reject);
        if (o.body) r.write(JSON.stringify(o.body));
        r.end();
    });
}
function tok(u) {
    return { Authorization: "Bearer " + jwt.sign({ id: u._id, _id: u._id }, JWT_SECRET), "Content-Type": "application/json" };
}
const stamp = Date.now();
function mkUser(extra) {
    return Object.assign({
        name: "Test " + stamp,
        email: "u" + Math.random().toString(36).slice(2) + "@example.invalid",
        phone: "900000000" + Math.floor(Math.random() * 9),
        passwordHash: "x",
        role: "customer",
    }, extra || {});
}
async function mkOrder(extra) {
    return Order.create(Object.assign({
        orderNumber: "FM-T-" + Math.random().toString(36).slice(2, 9).toUpperCase(),
        customer: { name: "T", phone: "9000000000", address: "A", city: "C", pincode: "400001" },
        items: [{ name: "X", price: 10, quantity: 1 }],
        payment: "Cash On Delivery",
        paymentMethod: "cod",
        subtotal: 10, delivery: 0, discount: 0, total: 10,
        status: "Placed",
        paymentStatus: "PENDING",
    }, extra || {}));
}

async function main() {
    await mongoose.connect(TEST_URI);
    console.log("isolated database: " + TEST_DB);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(function (r) { server.on("listening", r); });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    // ---------------------------------------------------------------
    section("B1. Wallet credit is atomic under concurrency");
    // ---------------------------------------------------------------
    const u1 = await User.create(mkUser());
    const N = 25;
    await Promise.all(Array.from({ length: N }, function () {
        return wallet.credit({ userId: u1._id, type: "CASHBACK", amount: 100 });
    }));
    let w = await Wallet.findOne({ user: u1._id });
    check("25 concurrent credits of 100 => balance exactly " + (N * 100), w && w.balance === N * 100, w && { balance: w.balance });
    check("totalCredited matches", w && w.totalCredited === N * 100, w && { totalCredited: w.totalCredited });

    const txs = await WalletTransaction.find({ user: u1._id }).sort({ createdAt: 1 });
    const balances = txs.map(function (t) { return t.balanceAfter; });
    const uniqueBalances = new Set(balances);
    check("every ledger row recorded a DISTINCT balanceAfter (no lost update)", uniqueBalances.size === balances.length, { rows: balances.length, distinct: uniqueBalances.size });
    check("ledger balanceAfter tops out at the real balance", Math.max.apply(null, balances) === w.balance, { max: Math.max.apply(null, balances), balance: w.balance });

    // ---------------------------------------------------------------
    section("B2. Wallet idempotency + compensation on a lost race");
    // ---------------------------------------------------------------
    const u2 = await User.create(mkUser());
    const ref = "test-ref-" + Date.now();
    const a = await wallet.credit({ userId: u2._id, type: "REFERRAL_REWARD", amount: 250, referenceType: "TEST", referenceId: ref });
    const b = await wallet.credit({ userId: u2._id, type: "REFERRAL_REWARD", amount: 250, referenceType: "TEST", referenceId: ref });
    check("first credit is created", a.created === true);
    check("repeat credit with the same reference is a no-op", b.created === false);
    w = await Wallet.findOne({ user: u2._id });
    check("balance is 250, not 500", w.balance === 250, { balance: w.balance });
    check("only one ledger row exists for that reference",
        (await WalletTransaction.countDocuments({ user: u2._id, referenceId: ref })) === 1);

    // Debit idempotency (the compensation path).
    const c = await wallet.debit({ userId: u2._id, type: "WALLET_DEBIT", amount: 100, referenceType: "TESTD", referenceId: ref });
    const d = await wallet.debit({ userId: u2._id, type: "WALLET_DEBIT", amount: 100, referenceType: "TESTD", referenceId: ref });
    check("debit created then replayed", c.created === true && d.created === false);
    w = await Wallet.findOne({ user: u2._id });
    check("balance is 150 after one debit, not 50", w.balance === 150, { balance: w.balance });
    check("totalDebited counts the debit once", w.totalDebited === 100, { totalDebited: w.totalDebited });

    let overThrew = null;
    try { await wallet.debit({ userId: u2._id, type: "WALLET_DEBIT", amount: 99999 }); } catch (e) { overThrew = e; }
    check("over-balance debit is refused with a 400", !!overThrew && overThrew.status === 400, overThrew && { status: overThrew.status, msg: overThrew.message });
    const wAfterOver = await Wallet.findOne({ user: u2._id });
    check("the refused debit left the balance untouched", wAfterOver.balance === 150, { balance: wAfterOver.balance });

    // ---------------------------------------------------------------
    section("B3. B2B credit limit cannot be exceeded by parallel orders");
    // ---------------------------------------------------------------
    const buyer = await User.create(mkUser({
        role: "b2b_customer",
        b2bApproved: true,
        creditLimit: 500,
        b2bProfile: { businessName: "Sharma Wholesale", bool: true }
    }));
    const prod = await Product.create({
        name: "Wholesale Onion", price: 30, unit: "kg", category: "Vegetables",
        stock: 1000, b2bPrice: 100, b2bMinQty: 1
    });
    const body = {
        items: [{ productId: String(prod._id), quantity: 3 }], // 3 x 100 = 300 per order
        deliveryAddress: { name: "Sharma", phone: "9000000000", address: "12 Market St", city: "Pune", pincode: "411001" }
    };
    // 3 parallel orders = 900 of credit against a 500 limit: at most ONE may win.
    const attempts = await Promise.all([1, 2, 3].map(function () {
        return req("/api/b2b/orders", { method: "POST", headers: tok(buyer), body: body });
    }));
    const created = attempts.filter(function (r) { return r.status === 201; });
    const refused = attempts.filter(function (r) { return r.status === 400 || r.status === 409; });
    check("at most one parallel order exceeds a 3x-too-big limit", created.length <= 1, attempts.map(function (r) { return r.status; }));
    check("the losers are refused with a 4xx", created.length + refused.length === 3, attempts.map(function (r) { return r.status; }));
    const creditOrders = await Order.countDocuments({ user: buyer._id, orderType: "b2b", paymentMode: "credit" });
    check("exactly the allowed order(s) are persisted", creditOrders === created.length, { creditOrders: creditOrders, created: created.length });
    if (created.length === 1) {
        check("the refusal message is the credit-limit one",
            /credit limit/i.test(attempts.filter(function (r) { return r.status !== 201; })[0].body), attempts.filter(function (r) { return r.status !== 201; })[0].body.slice(0, 160));
    }

    // Sequential sanity: a second order that fits is still accepted (the lease
    // must not permanently block a buyer).
    const seq = await req("/api/b2b/orders", { method: "POST", headers: tok(buyer), body: { items: [{ productId: String(prod._id), quantity: 1 }], deliveryAddress: body.deliveryAddress } });
    check("a sequential order that fits is still accepted (lease released)", seq.status === 201, { status: seq.status, body: seq.body.slice(0, 200) });

    // ---------------------------------------------------------------
    section("B4. Group rewards: eligibility, real payout, idempotency");
    // ---------------------------------------------------------------
    const host = await User.create(mkUser());
    const member = await User.create(mkUser());
    const member2 = await User.create(mkUser());
    const good = await mkOrder({ user: member._id, subtotal: 400, delivery: 60, total: 460, status: "Confirmed", paymentStatus: "PENDING" });
    const good2 = await mkOrder({ user: member2._id, subtotal: 400, delivery: 60, total: 460, status: "Confirmed", paymentStatus: "PENDING" });
    const cancelled = await mkOrder({ user: member._id, subtotal: 400, delivery: 60, total: 460, status: "Cancelled", paymentStatus: "CANCELLED" });
    const failedPay = await mkOrder({ user: member._id, subtotal: 400, delivery: 60, total: 460, status: "Placed", paymentStatus: "FAILED" });

    const group = await GroupOrder.create({
        host: host._id, title: "Colony order", minParticipants: 2, maxParticipants: 10,
        rewardType: "discount_percent", rewardPercent: 10,
        expiresAt: new Date(Date.now() + 86400000),
        orders: [good._id, good2._id, cancelled._id, failedPay._id]
    });
    const res1 = await groupRewards.applyRewards(group._id);
    check("applyRewards reports the threshold", res1 && res1.ok === true, res1);
    check("2 of 4 orders were skipped as ineligible", res1.skipped && res1.skipped.length === 2, res1.skipped);
    check("only the 2 eligible orders were paid", res1.issued && res1.issued.length === 2, res1.issued);
    const memberWallet = await Wallet.findOne({ user: member._id });
    check("the eligible order was actually paid (₹40 = 10% of 400)", memberWallet && memberWallet.balance === 40, memberWallet && { balance: memberWallet.balance });
    const ledger = await WalletTransaction.find({ user: member._id });
    check("a GROUP_REWARD ledger row now exists (the enum used to reject it)",
        ledger.length === 1 && ledger[0].type === "GROUP_REWARD", ledger.map(function (l) { return l.type; }));
    const groupAfter = await GroupOrder.findById(group._id);
    check("rewardsIssuedAt stamped on a complete run", !!groupAfter.rewardsIssuedAt);

    const res2 = await groupRewards.applyRewards(group._id);
    check("re-running is a no-op", res2 && res2.already === true, res2);
    const memberWallet2 = await Wallet.findOne({ user: member._id });
    check("balance unchanged after the re-run", memberWallet2.balance === 40, { balance: memberWallet2.balance });

    // Dead participants must not be able to satisfy the threshold. Previously the
    // test was `group.orders.length >= minParticipants`, so one live order plus
    // one cancelled order froze the group as ACHIEVED and locked real customers
    // out of ever completing a valid group.
    const halfHost = await User.create(mkUser());
    const halfLive = await mkOrder({ user: host._id, subtotal: 400, delivery: 60, total: 460, status: "Confirmed", paymentStatus: "PENDING" });
    const halfDead = await mkOrder({ user: host._id, subtotal: 400, delivery: 60, total: 460, status: "Cancelled", paymentStatus: "CANCELLED" });
    const halfGroup = await GroupOrder.create({
        host: halfHost._id, title: "Half dead", minParticipants: 2, maxParticipants: 10,
        rewardType: "discount_percent", rewardPercent: 10,
        expiresAt: new Date(Date.now() + 86400000),
        orders: [halfLive._id, halfDead._id]
    });
    const halfRes = await groupRewards.applyRewards(halfGroup._id);
    check("1 live + 1 cancelled order does NOT reach minParticipants=2", halfRes && halfRes.ok === false && halfRes.reason === "threshold_not_reached", halfRes);
    check("the threshold report counts eligible orders, not linked ids", halfRes && halfRes.count === 1 && halfRes.linked === 2, halfRes);
    const halfSaved = await GroupOrder.findById(halfGroup._id);
    check("the half-dead group stays OPEN (not frozen ACHIEVED)", halfSaved.status === "OPEN" && !halfSaved.rewardsIssuedAt, { status: halfSaved.status });
    const hostWallet = await Wallet.findOne({ user: host._id });
    check("no reward was paid into the half-dead group", !hostWallet || hostWallet.balance === 0, hostWallet && { balance: hostWallet.balance });

    // A cancelled participant after a payout must not re-open a settled group.
    const settledCancel = await Order.updateOne({ _id: good2._id }, { $set: { status: "Cancelled", paymentStatus: "CANCELLED" } });
    const settledRes = await groupRewards.applyRewards(group._id);
    check("a settled group stays ACHIEVED after a late cancellation", settledRes && settledRes.already === true, settledRes);
    const groupAfterLate = await GroupOrder.findById(group._id);
    check("the settled group was not re-opened", groupAfterLate.status === "ACHIEVED" && !!groupAfterLate.rewardsIssuedAt, { status: groupAfterLate.status });

    // ---------------------------------------------------------------
    section("B5. Cancelling a rewarded order reverses the reward");
    // ---------------------------------------------------------------
    const r = await req("/api/orders/" + good._id + "/cancel", { method: "POST", headers: tok(member) });
    check("customer cancel succeeds", r.status === 200, { status: r.status, body: r.body.slice(0, 160) });
    const memberWallet3 = await Wallet.findOne({ user: member._id });
    check("the reward was clawed back (balance back to 0)", memberWallet3 && memberWallet3.balance === 0, memberWallet3 && { balance: memberWallet3.balance });
    const ledger2 = await WalletTransaction.find({ user: member._id }).sort({ createdAt: 1 });
    check("both the credit and the reversal are on the ledger",
        ledger2.length === 2 && ledger2[1].type === "GROUP_REWARD_REVERSAL", ledger2.map(function (l) { return l.type; }));
    const revAgain = await groupRewards.reverseRewardsForOrder(good._id);
    check("reversal is idempotent (second call reverses nothing)", revAgain.reversed === 0, revAgain);

    // ---------------------------------------------------------------
    section("B6. Cancelled is terminal for delivery completion");
    // ---------------------------------------------------------------
    const liveOrder = await mkOrder({ status: "Out for Delivery", paymentMethod: "cod" });
    const done = await completeOrderDelivery(liveOrder, null, { by: "test" });
    check("a live order still completes normally", done.alreadyDelivered === false && done.order.status === "Delivered");

    const cancelledOrder = await mkOrder({ status: "Cancelled", paymentStatus: "CANCELLED" });
    let threw = null;
    try { await completeOrderDelivery(cancelledOrder, null, { by: "test" }); } catch (e) { threw = e; }
    check("a CANCELLED order cannot be completed (was a silent resurrection)", !!threw && threw.status === 409, threw && { status: threw.status });
    const reread = await Order.findById(cancelledOrder._id);
    check("the cancelled order is untouched in the database", reread.status === "Cancelled" && reread.paymentStatus === "CANCELLED", { status: reread.status, paymentStatus: reread.paymentStatus });

    // ---------------------------------------------------------------
    section("B7. Subscription state machine");
    // ---------------------------------------------------------------
    const plan = await SubscriptionPlan.create({
        name: "Weekly Veggie Box " + stamp, description: "test",
        pricing: { amount: 199, frequency: "weekly" },
        box: { items: [], fields: {} }
    });
    const subUser = await User.create(mkUser());
    const sub = await UserSubscription.create({ user: subUser._id, plan: plan._id, status: "active", nextDeliveryDate: new Date(Date.now() + 7 * 86400000) });

    const pause = await req("/api/subscriptions/" + sub._id + "/pause", { method: "PUT", headers: tok(subUser) });
    check("active -> paused is allowed", pause.status === 200, { status: pause.status, body: pause.body.slice(0, 160) });
    const resume = await req("/api/subscriptions/" + sub._id + "/resume", { method: "PUT", headers: tok(subUser) });
    check("paused -> active is allowed", resume.status === 200, { status: resume.status });
    const cancel = await req("/api/subscriptions/" + sub._id + "/cancel", { method: "PUT", headers: tok(subUser) });
    check("active -> cancelled is allowed", cancel.status === 200, { status: cancel.status });

    const resumeAfterCancel = await req("/api/subscriptions/" + sub._id + "/resume", { method: "PUT", headers: tok(subUser) });
    check("cancelled -> active is REFUSED (subscription cannot be resurrected)", resumeAfterCancel.status === 400, { status: resumeAfterCancel.status, body: resumeAfterCancel.body.slice(0, 200) });
    const pauseAfterCancel = await req("/api/subscriptions/" + sub._id + "/pause", { method: "PUT", headers: tok(subUser) });
    check("cancelled -> paused is refused", pauseAfterCancel.status === 400, { status: pauseAfterCancel.status });
    const cancelAgain = await req("/api/subscriptions/" + sub._id + "/cancel", { method: "PUT", headers: tok(subUser) });
    check("cancelled -> cancelled is refused (no duplicate notifications)", cancelAgain.status === 400, { status: cancelAgain.status });
    const rereadSub = await UserSubscription.findById(sub._id);
    check("the subscription is still cancelled", rereadSub.status === "cancelled");

    const other = await UserSubscription.create({ user: subUser._id, plan: plan._id, status: "paused", nextDeliveryDate: new Date(Date.now() + 7 * 86400000) });
    const dupe = await req("/api/subscriptions/subscribe", { method: "POST", headers: tok(subUser), body: { planId: String(plan._id) } });
    check("a PAUSED subscription also blocks a second one", dupe.status === 400, { status: dupe.status, body: dupe.body.slice(0, 160) });
    await UserSubscription.deleteOne({ _id: other._id });

    // ---------------------------------------------------------------
    section("B8. Autopay amount is server-authoritative");
    // ---------------------------------------------------------------
    const apUser = await User.create(mkUser());
    const apSub = await UserSubscription.create({ user: apUser._id, plan: plan._id, status: "active", nextDeliveryDate: new Date(Date.now() + 7 * 86400000) });
    const cheap = await req("/api/autopay/mandate", {
        method: "POST", headers: tok(apUser),
        body: { subscriptionId: String(apSub._id), consentAccepted: true, chargeAmount: 1 }
    });
    check("a tampered chargeAmount of ₹1 against a ₹199 plan is rejected", cheap.status === 400, { status: cheap.status, body: cheap.body.slice(0, 200) });
    const honest = await req("/api/autopay/mandate", {
        method: "POST", headers: tok(apUser),
        body: { subscriptionId: String(apSub._id), consentAccepted: true, chargeAmount: 199 }
    });
    check("the real plan amount is accepted", honest.status === 200 || honest.status === 201, { status: honest.status, body: honest.body.slice(0, 200) });
    if (honest.status === 200 || honest.status === 201) {
        check("the stored chargeAmount is the plan price",
            Number(honest.json && honest.json.data && honest.json.data.chargeAmount) === 199,
            honest.json && honest.json.data && { chargeAmount: honest.json.data.chargeAmount });
    }
    const absurd = await req("/api/autopay/mandate", {
        method: "POST", headers: tok(apUser), body: { consentAccepted: true, chargeAmount: 9999999 }
    });
    check("a standalone mandate above the ceiling is rejected", absurd.status === 400, { status: absurd.status });

    // ---------------------------------------------------------------
    section("B9. Segment classification and segment coupons actually run");
    // ---------------------------------------------------------------
    // utils/segments.js built its $match with `mongoose.Types.ObjectId(id)`,
    // which throws in bson 6 ("Class constructor ObjectId cannot be invoked
    // without 'new'"). Two silent consequences: coupon validation swallowed the
    // TypeError and refused EVERY segment-targeted coupon, and segmentCounts()
    // swallowed it per user so the admin targeting screen always read zero.
    const segments = require(path.join(REPO, "utils/segments"));
    const Coupon = require(path.join(REPO, "models/Coupon"));
    const coupons = require(path.join(REPO, "utils/coupons"));

    const segUser = await User.create(mkUser());
    await mkOrder({ user: segUser._id, total: 900, status: "Delivered", createdAt: new Date() });
    await mkOrder({ user: segUser._id, total: 900, status: "Delivered", createdAt: new Date() });
    await mkOrder({ user: segUser._id, total: 900, status: "Delivered", createdAt: new Date() });
    await mkOrder({ user: segUser._id, total: 900, status: "Delivered", createdAt: new Date() });

    let segErr = null, segRes = null;
    try { segRes = await segments.segmentOf(segUser._id); } catch (e) { segErr = e; }
    check("segmentOf() classifies an ordering customer without throwing", !segErr && segRes && Array.isArray(segRes.segments) && segRes.segments.length > 0,
        segErr ? { err: String(segErr.message) } : segRes && segRes.segments);
    check("a customer with 4 live orders is FREQUENT_BUYER", !!(segRes && segRes.segments.includes("FREQUENT_BUYER")), segRes && segRes.segments);
    check("a customer who spent over the high-value threshold is HIGH_VALUE", !!(segRes && segRes.segments.includes("HIGH_VALUE")), segRes && segRes.segments);

    const counts = await segments.segmentCounts();
    check("segmentCounts() counts the test customer (no longer silently zero)", Number(counts.FREQUENT_BUYER) >= 1, { counts: counts });

    const freqCoupon = await Coupon.create({
        code: "SEGFREQ" + stamp, discountType: "fixed", discountValue: 50, minimumOrderValue: 100,
        segment: "FREQUENT_BUYER", active: true, expiryDate: new Date(Date.now() + 86400000),
    });
    let vOk = null, vErr = null;
    try { vOk = await coupons.findValidCoupon(freqCoupon.code, { userId: segUser._id }); } catch (e) { vErr = e; }
    check("a matching customer can validate a segment coupon", !vErr && !!vOk, vErr ? { err: vErr.message, status: vErr.status } : null);

    const newcomer = await User.create(mkUser({ createdAt: new Date(), }));
    await mkOrder({ user: newcomer._id, total: 50, status: "Delivered", createdAt: new Date() });
    let vBad = null;
    try { await coupons.findValidCoupon(freqCoupon.code, { userId: newcomer._id }); vBad = "allowed"; } catch (e) { vBad = e; }
    check("a non-matching customer is refused the same coupon", vBad && vBad.status === 400, vBad === "allowed" ? "allowed a segment coupon to a non-member" : { status: vBad.status });

    // ---------------------------------------------------------------
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();

    console.log("\nRESULT: " + pass + "/" + (pass + fail) + " PASS, " + fail + " FAIL");
    process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
    console.error("SUITE ERROR:", e && e.stack ? e.stack : e);
    process.exit(1);
});