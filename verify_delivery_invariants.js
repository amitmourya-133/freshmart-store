// Isolated verification of delivery invariants (indexes, dedupe, race-safety).
// Uses its own scratch DB: fm_delivery_invariants_e2e_<pid>. Never touches freshmart.

const fs = require("fs");
const path = require("path");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI || !JWT_SECRET) {
    console.error("FATAL: MONGODB_URI / JWT_SECRET not found in .env");
    process.exit(1);
}

const TEST_DB = "fm_delivery_invariants_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");

const mongoose = require(path.join(REPO, "node_modules/mongoose"));

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
    if (cond) {
        pass++;
        console.log("  [PASS] " + name);
    } else {
        fail++;
        console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + extra : ""));
    }
}

async function main() {
    if (TEST_DB.indexOf("freshmart") !== -1) {
        console.error("FATAL: refusing to run against production database");
        process.exit(1);
    }
    process.env.MONGODB_URI = TEST_URI;
    process.env.JWT_SECRET = JWT_SECRET;
    await mongoose.connect(TEST_URI);
    console.log("isolated database: " + TEST_DB);

    const User = require(path.join(REPO, "models/User"));
    const Order = require(path.join(REPO, "models/Order"));
    const DeliveryOffer = require(path.join(REPO, "models/DeliveryOffer"));
    const DeliveryAssignment = require(path.join(REPO, "models/DeliveryAssignment"));
    const Settings = require(path.join(REPO, "models/Settings"));
    const deliveryOpsController = require(path.join(REPO, "controllers/deliveryOpsController"));

    // Force index creation so the test is deterministic.
    await Promise.all([
        DeliveryAssignment.syncIndexes(),
        DeliveryOffer.syncIndexes(),
    ]);

    // ---------- TODO 1: partial unique index ----------
    console.log("--- TODO 1: one active assignment per order ---");
    const idx = await DeliveryAssignment.collection.indexes();
    const uniq = idx.filter(function (i) { return i.name === "one_active_assignment_per_order"; })[0];
    check("index one_active_assignment_per_order exists", Boolean(uniq));
    if (uniq) {
        check("index is unique", uniq.unique === true, JSON.stringify(uniq.key));
        check(
            "index is partial on active statuses",
            JSON.stringify(uniq.partialFilterExpression || {}) === JSON.stringify({ status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } }),
            JSON.stringify(uniq.partialFilterExpression)
        );
    }

    const mkOrder = async function (tag) {
        return Order.create({
            orderNumber: "INV-" + tag + "-" + Date.now(),
            user: new mongoose.Types.ObjectId(),
            status: "Confirmed",
            paymentStatus: "PAID",
            items: [],
            total: 100,
            customer: {
                name: "Test",
                email: "inv-" + tag + "@example.invalid",
                phone: "0000000000",
                address: "1 Test Street",
                city: "Bengaluru",
                pincode: "560001",
            },
        });
    };
    const mkPartner = async function (tag) {
        return User.create({
            name: "Partner " + tag,
            email: "inv-partner-" + tag + "-" + Date.now() + "@example.invalid",
            phone: "0000000001",
            passwordHash: "x",
            role: "delivery",
            partnerStatus: "approved",
            isAvailable: true,
        });
    };

    const o1 = await mkOrder("idx");
    const p1 = await mkPartner("idx");
    await DeliveryAssignment.create({ order: o1._id, deliveryUser: p1._id, assignedBy: p1._id, status: "ASSIGNED" });
    let dupBlocked = false;
    try {
        await DeliveryAssignment.create({ order: o1._id, deliveryUser: p1._id, assignedBy: p1._id, status: "ASSIGNED" });
    } catch (e) {
        dupBlocked = e && e.code === 11000;
    }
    check("second ACTIVE assignment for same order rejected with E11000", dupBlocked);

    // Terminal status must fall outside the partial filter.
    await DeliveryAssignment.create({ order: o1._id, deliveryUser: p1._id, assignedBy: p1._id, status: "CANCELLED" });
    const afterTerminal = await DeliveryAssignment.countDocuments({ order: o1._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    check("terminal row does not block history rows", afterTerminal === 1, "active=" + afterTerminal);

    // ---------- TODO 2: offer dedupe / no duplicate OPEN offers ----------
    console.log("--- TODO 2: offer dedupe ---");
    const oIdx = await DeliveryOffer.collection.indexes();
    const offerIdx = oIdx.filter(function (i) {
        return JSON.stringify(i.key) === JSON.stringify({ order: 1, status: 1, expiresAt: 1 });
    })[0];
    check("offer guard index {order,status,expiresAt} exists", Boolean(offerIdx));

    const o2 = await mkOrder("dedupe");
    const pa = await mkPartner("dedupe-a");
    const pb = await mkPartner("dedupe-b");
    await User.updateOne({ _id: pa._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });
    await User.updateOne({ _id: pb._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });

    await Settings.updateOne({ key: "global" }, { $set: { deliveryBroadcastEnabled: true } }, { upsert: true });
    const settings = await Settings.getSettings();
    check("broadcast enabled for dedupe run", settings.deliveryBroadcastEnabled === true);

    const b1 = await deliveryOpsController.broadcastNewOrder(o2, { trigger: "verify" });
    const b2 = await deliveryOpsController.broadcastNewOrder(o2, { trigger: "verify" });
    const openOffers = await DeliveryOffer.countDocuments({ order: o2._id, status: "OPEN" });
    check("second broadcast is idempotent (only one OPEN offer)", openOffers === 1, "open=" + openOffers + " b1=" + JSON.stringify(b1) + " b2=" + JSON.stringify(b2));
    check("duplicate dispatch reported, not re-created", b2.broadcast === false, JSON.stringify(b2));

    // Each offer must target each partner at most once.
    const offerDoc = await DeliveryOffer.findOne({ order: o2._id, status: "OPEN" }).lean();
    const targeted = Array.isArray(offerDoc.partnerIds) ? offerDoc.partnerIds.map(String) : [];
    check("no partner targeted twice in one offer", new Set(targeted).size === targeted.length);

    // ---------- TODO 3: getAvailableDeliveryPartners eligibility ----------
    console.log("--- TODO 3: partner eligibility ---");
    const busyPartner = await mkPartner("busy");
    const pendingPartner = await mkPartner("pending");
    const offlinePartner = await mkPartner("offline");
    await User.updateOne({ _id: pendingPartner._id }, { partnerStatus: "pending" });
    await User.updateOne({ _id: offlinePartner._id }, { isAvailable: false });
    const wrongRole = await mkPartner("wrongrole");
    await User.updateOne({ _id: wrongRole._id }, { role: "customer" });
    const o3 = await mkOrder("elig");
    await DeliveryAssignment.create({ order: await mkOrder("other"), deliveryUser: busyPartner._id, assignedBy: busyPartner._id, status: "ACCEPTED" });

    const eligible = await deliveryOpsController.getAvailableDeliveryPartners({ orderId: o3._id });
    const eligibleIds = eligible.map(function (x) { return String(x._id); });
    check("available partner included", eligibleIds.indexOf(String(pa._id)) !== -1 || eligibleIds.indexOf(String(pb._id)) !== -1);
    check("busy partner excluded", eligibleIds.indexOf(String(busyPartner._id)) === -1);
    check("pending partner excluded", eligibleIds.indexOf(String(pendingPartner._id)) === -1);
    check("offline partner excluded", eligibleIds.indexOf(String(offlinePartner._id)) === -1);
    check("non-delivery role excluded", eligibleIds.indexOf(String(wrongRole._id)) === -1);

    // A partner already active on THIS order must not be offered again.
    const o4 = await mkOrder("selfoffer");
    const selfP = await mkPartner("self");
    await DeliveryAssignment.create({ order: o4._id, deliveryUser: selfP._id, assignedBy: selfP._id, status: "ASSIGNED" });
    const elig2 = (await deliveryOpsController.getAvailableDeliveryPartners({ orderId: o4._id })).map(function (x) { return String(x._id); });
    check("partner already active on this order excluded", elig2.indexOf(String(selfP._id)) === -1);

    // requireFreshLocation must drop partners without a recent ping.
    const noLoc = await mkPartner("noloc");
    const withLoc = await mkPartner("withloc");
    await User.updateOne({ _id: withLoc._id }, { lastLat: 12.97, lastLng: 77.59, lastLocationAt: new Date() });
    const o5 = await mkOrder("fresh");
    const fresh = (await deliveryOpsController.getAvailableDeliveryPartners({ orderId: o5._id, requireFreshLocation: true })).map(function (x) { return String(x._id); });
    check("fresh-location filter drops partner without ping", fresh.indexOf(String(noLoc._id)) === -1);
    check("fresh-location filter keeps partner with recent ping", fresh.indexOf(String(withLoc._id)) !== -1);

    // ---------- TODO 4: structured delivery events, no secrets ----------
    console.log("--- TODO 4: structured delivery events ---");
    const src = fs.readFileSync(path.join(REPO, "controllers/deliveryOpsController.js"), "utf8");
    const eventNames = ["ORDER_CREATED", "AUTO_DISPATCH_STARTED", "OFFER_CREATED", "OFFER_PUSH_SENT", "OFFER_PUSH_FAILED", "OFFER_ACCEPT_ATTEMPT", "ORDER_ASSIGNED", "OFFER_WON", "OFFER_LOST", "OFFER_EXPIRED", "AUTO_DISPATCH_RETRY", "AUTO_DISPATCH_SKIPPED"];
    const missingEvents = eventNames.filter(function (n) { return src.indexOf('"' + n + '"') === -1; });
    check("all delivery event names declared", missingEvents.length === 0, missingEvents.join(","));
    check("event allowlist enforced in logDeliveryEvent", src.indexOf("DELIVERY_EVENTS.indexOf(name)") !== -1);

    // ---------- TODO 5: race-safe assignment, exactly one winner ----------
    console.log("--- TODO 5: concurrent accept race ---");
    const o6 = await mkOrder("race");
    const r1 = await mkPartner("race1");
    const r2 = await mkPartner("race2");
    const r3 = await mkPartner("race3");
    await User.updateOne({ _id: r1._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });
    await User.updateOne({ _id: r2._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });
    await User.updateOne({ _id: r3._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });

    const attempts = await Promise.all([
        deliveryOpsController.createAssignmentResult({ order: o6, partner: r1, byUserId: r1._id, mode: "claim" }),
        deliveryOpsController.createAssignmentResult({ order: o6, partner: r2, byUserId: r2._id, mode: "claim" }),
        deliveryOpsController.createAssignmentResult({ order: o6, partner: r3, byUserId: r3._id, mode: "claim" }),
    ]);
    const winners = attempts.filter(function (a) { return a.ok === true; });
    const losers = attempts.filter(function (a) { return a.ok === false; });
    check("exactly one winner", winners.length === 1, "winners=" + winners.length);
    check("all losers report ORDER_ALREADY_ASSIGNED", losers.every(function (l) { return l.reason === "ORDER_ALREADY_ASSIGNED"; }), JSON.stringify(losers.map(function (l) { return l.reason; })));
    const activeRows = await DeliveryAssignment.countDocuments({ order: o6._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } });
    check("database holds exactly one active assignment", activeRows === 1, "rows=" + activeRows);
    check("advisory fast-path blocks a later 4th attempt", (await deliveryOpsController.createAssignmentResult({ order: o6, partner: r1, byUserId: r1._id, mode: "claim" })).reason === "ORDER_ALREADY_ASSIGNED");

    // ---------- TODO 7: bounded retry-first ----------
    console.log("--- TODO 7: bounded retry rounds ---");
    const settings2 = await Settings.getSettings();
    check("deliveryMaxDispatchRounds present with default 3", settings2.deliveryMaxDispatchRounds === 3, "value=" + settings2.deliveryMaxDispatchRounds);
    // Bound enforcement: schema validation rejects out-of-range on save, and
    // the controller clamps again when reading, so neither path can loop.
    let schemaBounded = false;
    try {
        const s = await Settings.getSettings();
        s.deliveryMaxDispatchRounds = 99;
        await s.save();
    } catch (e) {
        schemaBounded = true;
    }
    check("schema rejects deliveryMaxDispatchRounds above 5", schemaBounded);

    let tooLowRejected = false;
    try {
        const s = await Settings.getSettings();
        s.deliveryMaxDispatchRounds = 0;
        await s.save();
    } catch (e) {
        tooLowRejected = true;
    }
    check("schema rejects deliveryMaxDispatchRounds below 1", tooLowRejected);

    await Settings.updateOne({ key: "global" }, { $set: { deliveryMaxDispatchRounds: 3 } });

    // Behavioural proof that retry-first stops at the budget: give the order a
    // fresh round-5 offer that nobody claims, with maxRounds forced to 1 via
    // the schema-bounded path, and assert the sweep escalates instead of
    // re-broadcasting.
    const retryPartner = await mkPartner("retry");
    await User.updateOne({ _id: retryPartner._id }, { role: "delivery", partnerStatus: "approved", isAvailable: true });
    await Settings.updateOne({ key: "global" }, { $set: { deliveryMaxDispatchRounds: 1 } });
    const o7 = await mkOrder("retrybudget");
    await DeliveryOffer.create({
        order: o7._id,
        round: 5,
        status: "OPEN",
        mode: "broadcast",
        ttlSeconds: 15,
        expiresAt: new Date(Date.now() - 1000),
        autoAssignAt: null,
    });
    const before = await DeliveryOffer.countDocuments({ order: o7._id });
    const sweep = await deliveryOpsController.sweepExpiredOffers(20);
    const after = await DeliveryOffer.countDocuments({ order: o7._id });
    check(
        "exhausted round budget escalates instead of opening round 6",
        after === before,
        "before=" + before + " after=" + after + " sweep=" + JSON.stringify(sweep)
    );
    await Settings.updateOne({ key: "global" }, { $set: { deliveryMaxDispatchRounds: 3 } });

    console.log("");
    console.log("RESULT: " + pass + "/" + (pass + fail) + " PASS, " + fail + " FAIL");
    await mongoose.connection.close();
    await mongoose.disconnect().catch(function () {});
    try {
        await mongoose.connection.db.dropDatabase();
    } catch (e) { /* already closed */ }
    process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
    console.error("FATAL: " + (e && e.stack ? e.stack : e));
    process.exit(1);
});