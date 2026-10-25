// ===============================
// ORDER-CREATE RETRY REGRESSION TESTS (DB-backed, C1)
// ===============================
// Exercises the real createOrder controller against an ISOLATED throwaway DB.
// BLOCKED in this environment: no safe isolated MongoDB available.

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

// A coupon needs an expiry in the future (required field) and no per-user cap /
// segment so it is usable by the synthetic user id used below.
function couponFixture(code) {
    return {
        code: code,
        discountType: "fixed",
        discountValue: 5,
        active: true,
        usageLimit: 5,
        usageCount: 0,
        expiryDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
    };
}

describe("Order creation retry accounting (C1)", function () {
    this.timeout(120000);
    let conn, Product, Coupon, CouponUsage, Order, controller;
    const userId = new mongoose.Types.ObjectId();
    let originalCreate = null;

    before(async function () {
        if (!isSafeTestHost()) this.skip("No safe isolated MongoDB (localhost) available.");
        conn = await testDb.connectTestDb(mongoose, "ordercreateretry");
        Product = require("../../models/Product");
        Coupon = require("../../models/Coupon");
        CouponUsage = require("../../models/CouponUsage");
        Order = require("../../models/Order");
        controller = require("../../controllers/orderController");
        originalCreate = Order.create.bind(Order);
    });
    after(async function () {
        if (originalCreate) Order.create = originalCreate;
        if (conn) await conn.close(true);
    });
    afterEach(async function () {
        if (originalCreate) Order.create = originalCreate;
    });

    beforeEach(async function () {
        await Promise.all([Product.deleteMany({}), Coupon.deleteMany({}), CouponUsage.deleteMany({}), Order.deleteMany({})]);
        if (originalCreate) Order.create = originalCreate;
    });

    function res() { return { code: 200, body: null, status(c){this.code=c;return this;}, json(o){this.body=o;return this;} }; }

    async function seed() {
        const p = await Product.create({ name: "RetryProd", price: 30, unit: "kg", category: "Vegetables", stock: 10 });
        const c = await Coupon.create(couponFixture("RETRY10"));
        return { p, c };
    }

    function body(p, c) {
        return {
            body: {
                customer: { name: "Test User", phone: "9990001111", address: "1 St", city: "Delhi", pincode: "110001" },
                items: [{ productId: p._id, quantity: 2 }],
                couponCode: c.code,
                paymentMethod: "cod",
            },
            user: { _id: userId },
        };
    }

    it("normal order decrements stock and counts coupon exactly once", async function () {
        const { p, c } = await seed();
        const r = res();
        await controller.createOrder(body(p, c), r);
        assert.strictEqual(r.code, 201, "expected 201, got " + r.code + ": " + JSON.stringify(r.body));
        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 8);
        const cAfter = await Coupon.findById(c._id).lean();
        assert.strictEqual(cAfter.usageCount, 1);
        const orders = await Order.countDocuments({});
        assert.strictEqual(orders, 1);
    });

    it("a duplicate-key collision retries without double-compensating", async function () {
        const { p, c } = await seed();
        let calls = 0;
        Order.create = async function (doc) {
            calls++;
            if (calls === 1) {
                const err = new Error("dup");
                err.code = 11000;
                throw err;
            }
            return originalCreate(doc);
        };
        const r = res();
        await controller.createOrder(body(p, c), r);
        assert.strictEqual(r.code, 201, "expected 201, got " + r.code + ": " + JSON.stringify(r.body));
        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 8, "stock must be decremented exactly once");
        const cAfter = await Coupon.findById(c._id).lean();
        assert.strictEqual(cAfter.usageCount, 1, "coupon must be counted exactly once");
        const orders = await Order.countDocuments({});
        assert.strictEqual(orders, 1, "exactly one order");
    });

    it("terminal failure restores reservations exactly once", async function () {
        const { p, c } = await seed();
        Order.create = async function () {
            const err = new Error("boom");
            err.code = 99999;
            throw err;
        };
        const r = res();
        await controller.createOrder(body(p, c), r);
        assert.notStrictEqual(r.code, 201);
        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 10, "stock must be restored");
        const cAfter = await Coupon.findById(c._id).lean();
        assert.strictEqual(cAfter.usageCount, 0, "coupon must be released");
        const orders = await Order.countDocuments({});
        assert.strictEqual(orders, 0, "no order persisted");
    });
});
