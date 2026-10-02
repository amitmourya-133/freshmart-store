// HTTP-level verification of the accept/claim routes and admin monitoring.
// Isolated DB: fm_delivery_http_e2e_<pid>. Never touches freshmart.

const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI || !JWT_SECRET) {
    console.error("FATAL: MONGODB_URI / JWT_SECRET not found in .env");
    process.exit(1);
}

const TEST_DB = "fm_delivery_http_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");
if (TEST_DB.indexOf("freshmart") !== -1) {
    console.error("FATAL: refusing to run against production database");
    process.exit(1);
}
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));

const User = require(path.join(REPO, "models/User"));
const Order = require(path.join(REPO, "models/Order"));
const Settings = require(path.join(REPO, "models/Settings"));
const DeliveryOffer = require(path.join(REPO, "models/DeliveryOffer"));
const DeliveryAssignment = require(path.join(REPO, "models/DeliveryAssignment"));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  [PASS] " + name); }
    else { fail++; console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + extra : "")); }
}

let PORT = 0;
function req(p, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
        const parsed = new URL(p, "http://localhost");
        const options = {
            hostname: "127.0.0.1",
            port: parsed.port || PORT,
            path: parsed.pathname + (parsed.search || ""),
            method: o.method || "GET",
            headers: o.headers || {},
        };
        const r = http.request(options, function (res) {
            let data = "";
            res.on("data", function (c) { data += c; });
            res.on("end", function () {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { json = { raw: data }; }
                resolve({ status: res.statusCode, json: json });
            });
        });
        r.on("error", reject);
        if (o.body) r.write(JSON.stringify(o.body));
        r.end();
    });
}
function tok(user) {
    return { Authorization: "Bearer " + jwt.sign({ id: user._id, _id: user._id }, JWT_SECRET), "Content-Type": "application/json" };
}

async function mkPartner(tag) {
    return User.create({
        name: "P " + tag,
        email: "http-" + tag + "-" + Date.now() + "@example.invalid",
        phone: "0000000001",
        passwordHash: "x",
        role: "delivery",
        partnerStatus: "approved",
        isAvailable: true,
    });
}
async function mkOrder(tag) {
    return Order.create({
        orderNumber: "HTTP-" + tag + "-" + Date.now(),
        user: new mongoose.Types.ObjectId(),
        status: "Confirmed",
        paymentStatus: "PAID",
        items: [],
        total: 100,
        customer: { name: "T", email: "http-" + tag + "@example.invalid", phone: "0000000000", address: "1 St", city: "Bengaluru", pincode: "560001" },
    });
}
async function openOffer(order, partner, round) {
    return DeliveryOffer.create({
        order: order._id,
        round: round || 1,
        status: "OPEN",
        mode: "broadcast",
        ttlSeconds: 300,
        expiresAt: new Date(Date.now() + 300000),
        autoAssignAt: null,
        notified: [{ user: partner._id, at: new Date(), inApp: true, push: false }],
    });
}

async function main() {
    await mongoose.connect(TEST_URI);
    console.log("isolated database: " + TEST_DB);

    const server = app.listen(0, "127.0.0.1");
    await new Promise(function (r) { server.on("listening", r); });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    await Settings.updateOne({ key: "global" }, { $set: { deliveryBroadcastEnabled: true } }, { upsert: true });

    console.log("--- TODO 6: accept / claim routes ---");

    // 6a. canonical route works
    let o = await mkOrder("canon");
    let p = await mkPartner("canon");
    let offer = await openOffer(o, p);
    const r1 = await req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST", headers: tok(p) });
    check("POST /api/delivery/offers/:id/accept succeeds", r1.status === 200, "status=" + r1.status + " body=" + JSON.stringify(r1.json));
    const a1 = await DeliveryAssignment.findOne({ order: o._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    check("canonical accept created the assignment", Boolean(a1));
    const offerAfter = await DeliveryOffer.findById(offer._id).lean();
    check("canonical accept set the offer to CLAIMED", /CLAIMED|ACCEPTED/.test(offerAfter.status), "status=" + offerAfter.status);

    // 6b. alias route works (same handler)
    o = await mkOrder("alias");
    p = await mkPartner("alias");
    offer = await openOffer(o, p);
    const r2 = await req("/api/delivery-ops/offers/" + offer._id + "/accept", { method: "POST", headers: tok(p) });
    check("POST /api/delivery-ops/offers/:id/accept alias succeeds", r2.status === 200, "status=" + r2.status + " body=" + JSON.stringify(r2.json));

    // 6c. legacy claim route preserved
    o = await mkOrder("claim");
    p = await mkPartner("claim");
    offer = await openOffer(o, p);
    const r3 = await req("/api/delivery-ops/offers/" + offer._id + "/claim", { method: "POST", headers: tok(p) });
    check("legacy /claim route still works", r3.status === 200, "status=" + r3.status + " body=" + JSON.stringify(r3.json));

    // 6d. authentication required
    o = await mkOrder("noauth");
    p = await mkPartner("noauth");
    offer = await openOffer(o, p);
    const r4 = await req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST" });
    check("accept without a token is rejected", r4.status === 401, "status=" + r4.status);

    // 6e. authorization: a non-delivery user cannot accept somebody else's offer
    const customer = await User.create({
        name: "Cust",
        email: "http-cust-" + Date.now() + "@example.invalid",
        phone: "0000000002",
        passwordHash: "x",
        role: "customer",
    });
    o = await mkOrder("wrongrole");
    p = await mkPartner("wrongrole");
    offer = await openOffer(o, p);
    const r5 = await req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST", headers: tok(customer) });
    check("non-delivery role cannot accept an offer", r5.status === 403 || r5.status === 401, "status=" + r5.status);
    check("no assignment created by the rejected accept", (await DeliveryAssignment.countDocuments({ order: o._id })) === 0);

    // 6f. duplicate accept is idempotent for the SAME partner (already owns it)
    // 6f. accepting twice by the SAME partner is refused (part14 asserts 409)
    const first = await req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST", headers: tok(p) });
    check("same partner can accept the offer", first.status === 200, "status=" + first.status);
    const r6 = await req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST", headers: tok(p) });
    check("second accept by the same partner is refused with 409", r6.status === 409, "status=" + r6.status);
    check("double accept still produced only one assignment", (await DeliveryAssignment.countDocuments({ order: o._id })) === 1);
    check("still exactly one active assignment", (await DeliveryAssignment.countDocuments({ order: o._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } })) === 1);

    // 6g. body cannot spoof the partner identity
    o = await mkOrder("spoof");
    p = await mkPartner("spoof-win");
    const other = await mkPartner("spoof-other");
    offer = await openOffer(o, p);
    const r7 = await req("/api/delivery/offers/" + offer._id + "/accept", {
        method: "POST",
        headers: tok(p),
        body: { partnerId: String(other._id), deliveryUser: String(other._id), userId: String(other._id) },
    });
    const spoofAssign = await DeliveryAssignment.findOne({ order: o._id }).lean();
    check("body cannot reassign the winner to another partner", r7.status === 200 && spoofAssign && String(spoofAssign.deliveryUser) === String(p._id), JSON.stringify(spoofAssign && spoofAssign.deliveryUser));

    console.log("--- TODO 6 (race over HTTP): simultaneous accepts ---");
    o = await mkOrder("httprace");
    const rp1 = await mkPartner("httprace1");
    const rp2 = await mkPartner("httprace2");
    const rp3 = await mkPartner("httprace3");
    offer = await openOffer(o, rp1, 1);
    const of2 = await openOffer(o, rp2, 1);
    const of3 = await openOffer(o, rp3, 1);
    const raced = await Promise.all([
        req("/api/delivery/offers/" + offer._id + "/accept", { method: "POST", headers: tok(rp1) }),
        req("/api/delivery/offers/" + of2._id + "/accept", { method: "POST", headers: tok(rp2) }),
        req("/api/delivery/offers/" + of3._id + "/accept", { method: "POST", headers: tok(rp3) }),
    ]);
    const winners = raced.filter(function (x) { return x.status === 200; });
    const losers = raced.filter(function (x) { return x.status !== 200; });
    check("exactly one HTTP winner", winners.length === 1, "statuses=" + JSON.stringify(raced.map(function (x) { return x.status; })));
    check("all HTTP losers got ORDER_ALREADY_ASSIGNED", losers.every(function (l) {
        return JSON.stringify(l.json || {}).indexOf("ORDER_ALREADY_ASSIGNED") !== -1;
    }), JSON.stringify(losers.map(function (l) { return l.json; })));
    check("DB holds exactly one active assignment after the HTTP race", (await DeliveryAssignment.countDocuments({ order: o._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } })) === 1);

    console.log("--- TODO 6 (lifecycle over HTTP) ---");
    const a2 = await DeliveryAssignment.findOne({ order: o._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    const winner = winners.length === 1
        ? [rp1, rp2, rp3].filter(function (x) { return true; })
        : [];
    // find which partner holds the assignment
    const holder = await User.findById(a2.deliveryUser);
    const life = [];
    for (const step of ["ACCEPTED", "PICKED_UP", "EN_ROUTE"]) {
        const rr = await req("/api/delivery/status", { method: "PUT", headers: tok(holder), body: { assignmentId: String(a2._id), status: step } });
        life.push(step + "=" + rr.status);
        if (rr.status !== 200) break;
    }
    check("status progression ACCEPTED->PICKED_UP->EN_ROUTE accepted", life.length === 3 && life.every(function (x) { return /=(200|201)$/.test(x); }), life.join(" "));
    const midA = await DeliveryAssignment.findById(a2._id).lean();
    check("assignment reaches EN_ROUTE", midA.status === "EN_ROUTE", "status=" + midA.status);

    // DELIVERED requires the customer OTP, so it must be refused without it.
    const noOtp = await req("/api/delivery/status", { method: "PUT", headers: tok(holder), body: { assignmentId: String(a2._id), status: "DELIVERED" } });
    check("DELIVERED without the customer OTP is refused", noOtp.status >= 400, "status=" + noOtp.status);
    check("assignment still EN_ROUTE after the refused DELIVERED", (await DeliveryAssignment.findById(a2._id)).status === "EN_ROUTE");

    console.log("--- TODO 9: delivery-ops.js mobile controls (driven like the UI) ---");
    // nextStatusFor() in delivery-ops.js is the button driver. Replay it against
    // the same endpoint the UI posts to: PUT /api/delivery/status.
    const o9 = await mkOrder("mobile");
    const m1 = await mkPartner("mobile1");
    const m2 = await mkPartner("mobile2");
    const off9 = await openOffer(o9, m1, 1);
    const off9b = await openOffer(o9, m2, 1);
    const race9 = await Promise.all([
        req("/api/delivery/offers/" + off9._id + "/accept", { method: "POST", headers: tok(m1) }),
        req("/api/delivery/offers/" + off9b._id + "/accept", { method: "POST", headers: tok(m2) }),
    ]);
    check("mobile accept path yields exactly one winner", race9.filter(function (x) { return x.status === 200; }).length === 1);

    const a9 = await DeliveryAssignment.findOne({ order: o9._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    check("mobile flow created the assignment", Boolean(a9));
    const winner9 = await User.findById(a9.deliveryUser);

    // Drive the exact nextStatusFor chain: ASSIGNED->(accept already implies
    // ACCEPTED) then ACCEPTED->PICKED_UP->EN_ROUTE.
    const chain = ["ACCEPTED", "PICKED_UP", "EN_ROUTE"];
    const got = [];
    let cur = a9.status;
    for (const step of chain) {
        if (step === "ACCEPTED" && cur === "ACCEPTED") { got.push("ACCEPTED=present"); continue; }
        const rr = await req("/api/delivery/status", { method: "PUT", headers: tok(winner9), body: { assignmentId: String(a9._id), status: step } });
        got.push(step + "=" + rr.status);
        if (rr.status !== 200) break;
        cur = step;
    }
    check("mobile status buttons drive ACCEPTED->PICKED_UP->EN_ROUTE", got.every(function (x) { return /=(200|201|present)$/.test(x); }), got.join(" "));
    check("assignment sits at EN_ROUTE after the mobile buttons", (await DeliveryAssignment.findById(a9._id)).status === "EN_ROUTE");

    // The UI's nextStatusFor returns DELIVERED from EN_ROUTE; that step needs
    // the customer OTP, so the button must be the only thing gating it.
    const deliverBtn = await req("/api/delivery/status", { method: "PUT", headers: tok(winner9), body: { assignmentId: String(a9._id), status: "DELIVERED" } });
    check("DELIVERED button requires the customer OTP", deliverBtn.status >= 400, "status=" + deliverBtn.status);

    console.log("--- TODO 8: admin dispatch monitoring ---");
    const admin = await User.create({
        name: "Admin", email: "http-admin-" + Date.now() + "@example.invalid",
        phone: "0000000003", passwordHash: "x", role: "admin", adminRole: "superadmin",
    });
    const r8 = await req("/api/delivery-ops/admin/partners", { headers: tok(admin) });
    check("GET /api/delivery-ops/admin/partners returns 200", r8.status === 200, "status=" + r8.status);
    const listBody = JSON.stringify(r8.json || {});
    ["active", "delivered", "online", "stale", "offersToday"].forEach(function (needle) {
        check("admin partners payload exposes '" + needle + "'", listBody.indexOf(needle) !== -1);
    });
    const opsBody = JSON.stringify((r8.json && r8.json.ops) || {});
    check("admin ops settings expose maxDispatchRounds", opsBody.indexOf("maxDispatchRounds") !== -1, opsBody);

    console.log("--- TODO 9: delivery-ops.js + admin-partners.js wiring ---");
    const opsSrc = fs.readFileSync(path.join(REPO, "delivery-ops.js"), "utf8");
    check("delivery-ops.js calls the canonical /accept endpoint", /offers\/\$\{[^}]+\}\/accept/.test(opsSrc) || opsSrc.indexOf("/accept") !== -1);
    ["ACCEPTED", "PICKED_UP", "EN_ROUTE", "DELIVERED"].forEach(function (s) {
        check("delivery-ops.js references " + s, opsSrc.indexOf(s) !== -1);
    });
    check("delivery-ops.js uses the shared status endpoint", opsSrc.indexOf("/delivery/status") !== -1);
    const adminSrc = fs.readFileSync(path.join(REPO, "admin-partners.js"), "utf8");
    check("admin-partners.js renders retry/maxRounds", adminSrc.indexOf("o.retries") !== -1 && adminSrc.indexOf("o.maxRounds") !== -1);
    check("admin-partners.js renders delivery status and assign mode", adminSrc.indexOf("o.deliveryStatus") !== -1 && adminSrc.indexOf("o.assignMode") !== -1);
    check("admin-partners.js renders assignedAt", adminSrc.indexOf("o.assignedAt") !== -1);
    check("admin.html table header matches the rendered columns", (fs.readFileSync(path.join(REPO, "admin.html"), "utf8").match(/<th scope="col">/g) || []).length >= 11);

    console.log("");
    console.log("RESULT: " + pass + "/" + (pass + fail) + " PASS, " + fail + " FAIL");

    await new Promise(function (r) { server.close(r); });
    await mongoose.connection.close();
    process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
    console.error("FATAL: " + (e && e.stack ? e.stack : e));
    process.exit(1);
});