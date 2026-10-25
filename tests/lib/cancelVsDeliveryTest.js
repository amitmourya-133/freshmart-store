// ===============================
// CANCEL VS DELIVERY RACE + CRASH RECOVERY (DB-backed, C4)
// ===============================
// Covers: (a) cancel and delivery completion are mutually exclusive, and
// (b) an interrupted terminal transition (status claimed, side effects missing,
// finalize marker unset) is completed on retry instead of being left broken.

const assert = require("assert");
const mongoose = require("mongoose");
const testDb = require("./testDb");

function isSafeTestHost() {
    const uri = process.env.MONGODB_URI || "";
    try {
        const u = new URL(uri);
        const h = String(u.hostname || "").toLowerCase();
        return h === "127.0.0.1" || h === "localhost" || h === "::1";
    } catch (e) { return false; }
}

describe("Cancel vs delivery race (C4)", function () {
    this.timeout(120000);
    let conn, Product, Order, DeliveryAssignment, controller, completeOrderDelivery;
    const userId = new mongoose.Types.ObjectId();

    before(async function () {
        if (!isSafeTestHost()) this.skip("No safe isolated MongoDB (localhost) available.");
        conn = await testDb.connectTestDb(mongoose, "cancelvsdelivery");
        Product = require("../../models/Product");
        Order = require("../../models/Order");
        DeliveryAssignment = require("../../models/DeliveryAssignment");
        controller = require("../../controllers/orderController");
        completeOrderDelivery = require("../../utils/deliveryCompletion").completeOrderDelivery;
    });
    after(async function () { if (conn) await conn.close(true); });
    beforeEach(async function () {
        await Promise.all([Product.deleteMany({}), Order.deleteMany({}), DeliveryAssignment.deleteMany({})]);
    });

    function res() { return { code: 200, body: null, status(c){this.code=c;return this;}, json(o){this.body=o;return this;} }; }

    async function seed(status) {
        const p = await Product.create({ name: "RaceProd", price: 30, unit: "kg", category: "Vegetables", stock: 10 });
        const o = await Order.create({
            orderNumber: "FM-RACE-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
            user: userId,
            customer: { name: "Test User", phone: "9990001111", address: "1 St", city: "Delhi", pincode: "110001" },
            items: [{ name: p.name, price: 30, quantity: 2, productId: p._id }],
            subtotal: 60, total: 60,
            status: status || "Out for Delivery",
            paymentStatus: "PENDING", paymentMethod: "cod",
        });
        await Product.updateOne({ _id: p._id }, { $inc: { stock: -2 } });
        return { p, o };
    }

    it("concurrent cancel and delivery: only one wins", async function () {
        const { p, o } = await seed();
        const r1 = res(), r2 = res();
        await Promise.allSettled([
            controller.updateOrderStatus({ params: { id: String(o._id) }, body: { status: "Cancelled" }, user: { _id: userId, role: "admin" } }, r1),
            (async () => { const ord = await Order.findById(o._id); await completeOrderDelivery(ord, null, { by: "admin:test" }); r2.code = 200; })()
        ]);
        const oAfter = await Order.findById(o._id).lean();
        assert.ok(oAfter.status === "Cancelled" || oAfter.status === "Delivered", "final status must be terminal");
        const pAfter = await Product.findById(p._id).lean();
        assert.ok(pAfter.stock === 8 || pAfter.stock === 10, "stock must be 8 (delivered) or 10 (cancelled), got " + pAfter.stock);
    });

    it("delivery on an already-cancelled order is rejected (409)", async function () {
        const { o } = await seed();
        const r1 = res();
        await controller.updateOrderStatus({ params: { id: String(o._id) }, body: { status: "Cancelled" }, user: { _id: userId, role: "admin" } }, r1);
        assert.strictEqual(r1.code, 200);
        const ord = await Order.findById(o._id);
        let threw = null;
        try { await completeOrderDelivery(ord, null, { by: "admin:test" }); } catch (e) { threw = e; }
        assert.ok(threw && threw.status === 409, "expected 409, got " + (threw && threw.status));
    });

    it("resumes an interrupted cancellation: retry restores stock and finalizes", async function () {
        const { p, o } = await seed();
        // Simulate a crash right after the terminal claim: status is Cancelled but
        // no effect ran and the finalize marker is still unset. Stock was already
        // decremented at order time (10 -> 8) and must come back once.
        o.status = "Cancelled";
        o.stockRestored = false;
        o.cancelFinalizedAt = null;
        o.statusHistory = [{ status: "Placed", by: "guest", at: new Date() }, { status: "Cancelled", by: "admin:x", at: new Date() }];
        await o.save();

        const r = res();
        await controller.updateOrderStatus({ params: { id: String(o._id) }, body: { status: "Cancelled" }, user: { _id: userId, role: "admin" } }, r);
        assert.strictEqual(r.code, 200, "resume must succeed: " + JSON.stringify(r.body));

        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 10, "stock must be restored exactly once on resume");
        const oAfter = await Order.findById(o._id).lean();
        assert.ok(oAfter.cancelFinalizedAt, "finalize marker must be set after resume");
        const cancelledEntries = (oAfter.statusHistory || []).filter(function (h) { return h.status === "Cancelled"; });
        assert.strictEqual(cancelledEntries.length, 1, "history must not duplicate the Cancelled entry");
    });

    it("resumes an interrupted delivery: retry consumes assignment, settles COD, finalizes once", async function () {
        const { o } = await seed("Delivered");
        // A crash after the Delivered claim but before the finalize: marker unset,
        // assignment still in flight, COD still PENDING.
        o.deliveryFinalizedAt = null;
        o.statusHistory = [{ status: "Placed", by: "guest", at: new Date() }];
        await o.save();
        const a = await DeliveryAssignment.create({
            order: o._id,
            deliveryUser: userId,
            status: "EN_ROUTE",
        });

        const ord = await Order.findById(o._id);
        await completeOrderDelivery(ord, a, { by: "delivery:" + String(userId) });

        const oAfter = await Order.findById(o._id).lean();
        assert.strictEqual(oAfter.paymentStatus, "PAID", "COD must settle on resume");
        assert.ok(oAfter.deliveryFinalizedAt, "delivery finalize marker must be set");
        const deliveredEntries = (oAfter.statusHistory || []).filter(function (h) { return h.status === "Delivered"; });
        assert.strictEqual(deliveredEntries.length, 1, "history must carry exactly one Delivered entry");

        const aAfter = await DeliveryAssignment.findById(a._id).lean();
        assert.strictEqual(aAfter.status, "DELIVERED", "assignment must be consumed on resume");
    });
});
