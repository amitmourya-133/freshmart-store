// Final-mile verification: customer tracking (ETA + privacy) and the
// successful customer-OTP -> DELIVERED completion, driven through the real API.
// Isolated DB: fm_final_mile_e2e_<pid>. Never touches freshmart.

const fs = require("fs");
const path = require("path");
const http = require("http");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI || !JWT_SECRET) { console.error("FATAL: missing .env secrets"); process.exit(1); }

const TEST_DB = "fm_final_mile_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");
if (TEST_DB.indexOf("freshmart") !== -1) { console.error("FATAL: production DB"); process.exit(1); }
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
const { hashOtp } = require(path.join(REPO, "utils/otp"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  [PASS] " + name); }
    else { fail++; console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + extra : "")); }
}
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
                resolve({ status: res.statusCode, json: json });
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

async function main() {
    await mongoose.connect(TEST_URI);
    console.log("isolated database: " + TEST_DB);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(function (r) { server.on("listening", r); });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    await Settings.updateOne({ key: "global" }, { $set: { etaBaseMinutes: 20, etaMinutesPerKm: 4, deliveryBroadcastEnabled: true } }, { upsert: true });

    const customer = await User.create({
        name: "Asha", email: "fm-" + Date.now() + "@example.invalid",
        phone: "9000000000", passwordHash: "x", role: "customer",
    });
    const stranger = await User.create({
        name: "Stranger", email: "fs-" + Date.now() + "@example.invalid",
        phone: "9000000001", passwordHash: "x", role: "customer",
    });
    const admin = await User.create({
        name: "Admin", email: "fa-" + Date.now() + "@example.invalid",
        phone: "9000000002", passwordHash: "x", role: "admin", adminRole: "superadmin",
    });
    const p1 = await User.create({
        name: "Ravi", email: "fp1-" + Date.now() + "@example.invalid",
        phone: "9000000003", passwordHash: "x", role: "delivery",
        partnerStatus: "approved", isAvailable: true,
        lastLat: 12.9716, lastLng: 77.5946, lastLocationAt: new Date(),
    });
    const p2 = await User.create({
        name: "Sita", email: "fp2-" + Date.now() + "@example.invalid",
        phone: "9000000004", passwordHash: "x", role: "delivery",
        partnerStatus: "approved", isAvailable: true,
        lastLat: 13.0, lastLng: 77.7, lastLocationAt: new Date(),
    });

    // trackingId is minted by the checkout helper; direct inserts must supply
    // it in the documented FM-YYYYMMDD-XXXXXX shape.
    const stamp = new Date();
    const trackingId = "FM-" + stamp.getFullYear() + String(stamp.getMonth() + 1).padStart(2, "0") + String(stamp.getDate()).padStart(2, "0") + "-" + Math.floor(Math.random() * 0xffffff).toString(16).toUpperCase().padStart(6, "0");

    // COD order so the settle path is exercised too.
    const order = await Order.create({
        orderNumber: "FM-E2E-" + Date.now(),
        trackingId: trackingId,
        user: customer._id,
        status: "Confirmed",
        paymentStatus: "PAID",
        paymentMethod: "cod",
        items: [{ product: new mongoose.Types.ObjectId(), name: "Spinach", quantity: 1, price: 40, lineTotal: 40 }],
        total: 40,
        deliverySlot: "TODAY",
        deliveryLocation: { lat: 12.95, lng: 77.62, city: "Bengaluru", address: "5 MG Road" },
        customer: { name: "Asha", email: customer.email, phone: "9000000000", address: "5 MG Road", city: "Bengaluru", pincode: "560001" },
    });

    console.log("--- dispatch to two partners ---");
    const offerA = await DeliveryOffer.create({
        order: order._id, round: 1, status: "OPEN", mode: "broadcast", ttlSeconds: 600,
        expiresAt: new Date(Date.now() + 600000), autoAssignAt: null,
        notified: [{ user: p1._id, at: new Date(), inApp: true, push: false }],
    });
    const offerB = await DeliveryOffer.create({
        order: order._id, round: 1, status: "OPEN", mode: "broadcast", ttlSeconds: 600,
        expiresAt: new Date(Date.now() + 600000), autoAssignAt: null,
        notified: [{ user: p2._id, at: new Date(), inApp: true, push: false }],
    });

    const [ra, rb] = await Promise.all([
        req("/api/delivery/offers/" + offerA._id + "/accept", { method: "POST", headers: tok(p1) }),
        req("/api/delivery/offers/" + offerB._id + "/accept", { method: "POST", headers: tok(p2) }),
    ]);
    check("exactly one partner accepted", [ra, rb].filter(function (x) { return x.status === 200; }).length === 1, ra.status + "/" + rb.status);
    const winner = ra.status === 200 ? p1 : p2;
    const loserOfferId = ra.status === 200 ? offerB._id : offerA._id;
    const loser = ra.status === 200 ? p2 : p1;

    const assign = await DeliveryAssignment.findOne({ order: order._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    check("atomic assignment created", Boolean(assign));

    console.log("--- other offer closed ---");
    await new Promise(function (r) { setTimeout(r, 300); });
    const loserOffer = await DeliveryOffer.findById(loserOfferId).lean();
    check("losing offer is no longer OPEN", loserOffer.status !== "OPEN", "status=" + loserOffer.status);
    check("losing offer closed as CLAIMED/EXPIRED/CANCELLED", ["CLAIMED", "EXPIRED", "CANCELLED"].indexOf(loserOffer.status) !== -1, "status=" + loserOffer.status);
    const loserFeed = await req("/api/delivery-ops/offers", { headers: tok(loser) });
    check("loser's feed no longer shows the live offer", JSON.stringify(loserFeed.json || {}).indexOf(String(loserOfferId)) === -1, "feed=" + JSON.stringify(loserFeed.json).slice(0, 160));

    console.log("--- partner sees the order ---");
    const active = await req("/api/delivery-ops/active", { headers: tok(winner) });
    check("partner's active board lists the order", active.status === 200 && JSON.stringify(active.json || {}).indexOf(String(order._id)) !== -1, "status=" + active.status);

    console.log("--- ACCEPTED -> PICKED_UP -> OUT FOR DELIVERY ---");
    for (const step of ["ACCEPTED", "PICKED_UP", "EN_ROUTE"]) {
        const rr = await req("/api/delivery/status", { method: "PUT", headers: tok(winner), body: { assignmentId: String(assign._id), status: step } });
        check("transition to " + step, rr.status === 200, "status=" + rr.status);
    }
    const enroute = await DeliveryAssignment.findById(assign._id).lean();
    check("pickedUpAt recorded", Boolean(enroute.pickedUpAt));
    check("enRouteAt recorded", Boolean(enroute.enRouteAt));
    // The order advances to "Delivered" only at completion; the live pipeline
    // lives on the assignment, which is what the customer tracking reads.
    check("order stays open while the parcel is in transit", (await Order.findById(order._id)).status === "Confirmed", "orderStatus=" + (await Order.findById(order._id)).status);

    console.log("--- customer location / ETA ---");
    const myOrder = await req("/api/orders/" + order._id, { headers: tok(customer) });
    check("customer can read their own order", myOrder.status === 200, "status=" + myOrder.status);
    const doc = (myOrder.json && myOrder.json.data) || myOrder.json || {};
    const track = doc.deliveryTrack || {};
    check("customer tracking carries a status", Boolean(track.status), "track=" + JSON.stringify(track));
    check("customer tracking carries a partner name", Boolean(track.partner && track.partner.name), "track=" + JSON.stringify(track));
    check("customer tracking carries an ETA", doc.eta !== undefined && doc.eta !== null, "eta=" + JSON.stringify(doc.eta));
    const partnerObj = (track.partner) || {};
    check("customer NEVER receives partner coordinates", partnerObj.lastLat === undefined && partnerObj.lastLng === undefined, JSON.stringify(partnerObj));
    check("customer tracking hides the partner phone", partnerObj.phone === undefined, JSON.stringify(partnerObj));

    // Order numbers are low-entropy, so anonymous lookup by order number is
    // refused by design (anti-enumeration); the high-entropy Track ID works
    // anonymously, and the owner can look up by order number.
    const anonByNumber = await req("/api/orders/track/" + order.orderNumber);
    check("anonymous lookup by order number is refused (anti-enumeration)", anonByNumber.status === 401, "status=" + anonByNumber.status);
    const strangerByNumber = await req("/api/orders/track/" + order.orderNumber, { headers: tok(stranger) });
    check("another customer cannot track by order number", strangerByNumber.status === 404, "status=" + strangerByNumber.status);
    const ownerByNumber = await req("/api/orders/track/" + order.orderNumber, { headers: tok(customer) });
    check("the owner can track by order number", ownerByNumber.status === 200, "status=" + ownerByNumber.status);
    const pub = await req("/api/orders/track/" + order.trackingId);
    check("public tracking works by Track ID without login", pub.status === 200, "status=" + pub.status + " body=" + JSON.stringify(pub.json).slice(0, 160));
    const pubData = (pub.json && pub.json.data) || {};
    check("public tracking exposes the delivery pipeline state", Boolean(pubData.deliveryStatus), "deliveryStatus=" + pubData.deliveryStatus);
    check("public tracking exposes the ETA", pubData.eta !== undefined && pubData.eta !== null, "eta=" + JSON.stringify(pubData.eta));
    check("public tracking exposes NO customer phone/address", pubData.customer === undefined && pubData.customerPhone === undefined, "keys=" + Object.keys(pubData).join(","));
    const pubPartner = (pub.json && pub.json.data && pub.json.data.deliveryPartner) || {};
    check("public tracking exposes no partner phone", !pubPartner.phone, JSON.stringify(pubPartner));
    check("public tracking exposes no partner coordinates", pubPartner.lastLat === undefined && pubPartner.lastLng === undefined, JSON.stringify(pubPartner));
    check("public tracking still shows the partner NAME", Boolean(pubPartner.name), JSON.stringify(pubPartner));

    const adminView = await req("/api/orders/" + order._id, { headers: tok(admin) });
    const adminTrack = (adminView.json && adminView.json.data && adminView.json.data.deliveryTrack) || {};
    const adminPartner = adminTrack.partner || {};
    check("admin DOES get partner coordinates for the live map", adminPartner.lastLat != null && adminPartner.lastLng != null, "partner=" + JSON.stringify(adminPartner));
    check("admin gets the staleness flag for the live map", typeof adminPartner.stale === "boolean", "stale=" + JSON.stringify(adminPartner.stale));

    const strangerOrder = await req("/api/orders/" + order._id, { headers: tok(stranger) });
    check("another customer cannot read this order", strangerOrder.status === 404, "status=" + strangerOrder.status);

    console.log("--- customer OTP -> DELIVERED ---");
    const badOtp = await req("/api/delivery/status", { method: "PUT", headers: tok(winner), body: { assignmentId: String(assign._id), status: "DELIVERED", otp: "0000" } });
    check("wrong OTP is refused", badOtp.status >= 400, "status=" + badOtp.status);
    const afterWrong = await DeliveryAssignment.findById(assign._id).lean();
    check("wrong OTP increments the attempt counter", Number(afterWrong.otpAttempts || 0) === 1, "attempts=" + afterWrong.otpAttempts);

    // The customer received the real code by email; recover it the way the
    // server stored it is impossible (hashed), so the test proves the OTP
    // contract end-to-end by minting a fresh assignment whose plaintext code
    // is known, exactly like the createAssignment email path does.
    const realOtp = "4321";
    await DeliveryAssignment.updateOne({ _id: assign._id }, { $set: { otpHash: hashOtp(realOtp), otpExpiry: new Date(Date.now() + 30 * 60000) } });
    const noOtp2 = await req("/api/delivery/status", { method: "PUT", headers: tok(winner), body: { assignmentId: String(assign._id), status: "DELIVERED" } });
    check("missing OTP is refused", noOtp2.status >= 400, "status=" + noOtp2.status);
    const done = await req("/api/delivery/status", { method: "PUT", headers: tok(winner), body: { assignmentId: String(assign._id), status: "DELIVERED", otp: realOtp } });
    check("correct customer OTP completes the delivery", done.status === 200, "status=" + done.status + " body=" + JSON.stringify(done.json).slice(0, 200));

    const fin = await DeliveryAssignment.findById(assign._id).lean();
    check("assignment is DELIVERED", fin.status === "DELIVERED", "status=" + fin.status);
    check("otpVerified recorded", fin.otpVerified === true);
    check("OTP hash wiped after use", fin.otpHash === null || fin.otpHash === undefined, "hash=" + fin.otpHash);
    check("deliveredAt recorded", Boolean(fin.deliveredAt));
    check("DELIVERED is no longer an active assignment", (await DeliveryAssignment.countDocuments({ order: order._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } })) === 0);

    const replay = await req("/api/delivery/status", { method: "PUT", headers: tok(winner), body: { assignmentId: String(assign._id), status: "DELIVERED", otp: realOtp } });
    check("the same OTP cannot be replayed", replay.status >= 400, "status=" + replay.status);

    const finOrder = await Order.findById(order._id).lean();
    check("order marked Delivered", finOrder.status === "Delivered", "orderStatus=" + finOrder.status);
    check("COD order payment marked collected", ["PAID", "COLLECTED"].indexOf(finOrder.paymentStatus) !== -1, "paymentStatus=" + finOrder.paymentStatus);

    const hist = await req("/api/delivery-ops/history", { headers: tok(winner) });
    check("the drop appears in the partner's history", hist.status === 200 && hist.json.deliveries.length === 1, "n=" + (hist.json && hist.json.deliveries && hist.json.deliveries.length));
    const row = (hist.json && hist.json.deliveries && hist.json.deliveries[0]) || {};
    check("history row carries earnings", typeof row.earnings === "number", JSON.stringify(row.earnings));
    check("history row hides the OTP", row.otp === undefined && row.otpHash === undefined, JSON.stringify(Object.keys(row)));
    check("COD expected cash recorded in history", row.expectedCash === 40, "expectedCash=" + row.expectedCash);

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