// ===============================
// COUPON COMPENSATION ON STOCK FAILURE (DB-backed, C2)
// ===============================
// Exercises the reservation-failure branch of createOrder. A generous stock
// level is seeded so computeServerTotals passes, then Product.updateOne is
// stubbed to report "nothing reserved" (the observable result of losing the
// atomic stock race). The controller must then give the coupon use back instead
// of leaving usageCount consumed with no order.

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

describe("Coupon compensation on stock failure (C2)", function () {
    this.timeout(120000);
    let conn, Product, Coupon, CouponUsage, Order, controller;
    let originalUpdateOne = null;
    const userId = new mongoose.Types.ObjectId();

    before(async function () {
        if (!isSafeTestHost()) this.skip("No safe isolated MongoDB (localhost) available.");
        conn = await testDb.connectTestDb(mongoose, "couponstockfailure");
        Product = require("../../models/Product");
        Coupon = require("../../models/Coupon");
        CouponUsage = require("../../models/CouponUsage");
        Order = require("../../models/Order");
        controller = require("../../controllers/orderController");
        originalUpdateOne = Product.updateOne;
    });
    after(async function () { if (conn) await conn.close(true); });
    beforeEach(async function () {
        await Promise.all([Product.deleteMany({}), Coupon.deleteMany({}), CouponUsage.deleteMany({}), Order.deleteMany({})]);
        Product.updateOne = originalUpdateOne;
    });
    afterEach(function () { Product.updateOne = originalUpdateOne; });

    function res() { return { code: 200, body: null, status(c){this.code=c;return this;}, json(o){this.body=o;return this;} }; }

    it("reservation failure releases coupon and creates no order", async function () {
        const p = await Product.create({ name: "RaceProd", price: 30, unit: "kg", category: "Vegetables", stock: 50 });
        const c = await Coupon.create({
            code: "C2CODE",
            discountType: "fixed",
            discountValue: 5,
            active: true,
            usageLimit: 5,
            usageCount: 0,
            expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });

        // Simulate losing the atomic stock claim (another checkout took it).
        Product.updateOne = async function () { return { matchedCount: 0, modifiedCount: 0 }; };

        const r = res();
        await controller.createOrder({
            body: {
                customer: { name: "Test User", phone: "9990001111", address: "1 St", city: "Delhi", pincode: "110001" },
                items: [{ productId: p._id, quantity: 2 }],
                couponCode: c.code,
                paymentMethod: "cod",
            },
            user: { _id: userId },
        }, r);

        assert.notStrictEqual(r.code, 201, "order must not be created when reservation fails");
        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 50, "stock must be untouched");
        const cAfter = await Coupon.findById(c._id).lean();
        assert.strictEqual(cAfter.usageCount, 0, "coupon global use must be released");
        const perUser = await CouponUsage.findOne({ coupon: c._id, user: userId }).lean();
        assert.strictEqual(perUser, null, "per-user coupon use must be released");
        const orders = await Order.countDocuments({});
        assert.strictEqual(orders, 0, "no order persisted");
    });
});
