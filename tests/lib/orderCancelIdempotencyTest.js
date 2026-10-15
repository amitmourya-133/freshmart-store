// ===============================
// ORDER-CANCEL STOCK EXACTLY-ONCE TESTS
// ===============================
// Exercises the REAL customer cancelOrder controller (which shares
// applyCancellation with the admin path) against an ISOLATED throwaway
// database (fm_ordercancel_e2e_<pid>) on the same cluster. No production data
// is read or written.
//
// Background: cancellation reads the order, checks status in memory, and then
// restores stock. Two concurrent cancels (a double-click, or the customer and
// an admin at the same moment) both read status !== "Cancelled" and would EACH
// re-increment inventory. applyCancellation now claims an atomic `stockRestored`
// flag first, so exactly one request restores stock. These tests pin that.

const assert = require("assert");
const mongoose = require("mongoose");
const testDb = require("./testDb");

let Order;
let Product;
let controller;

const userId = new mongoose.Types.ObjectId();

function res() {
    return {
        code: 200,
        body: null,
        status: function (c) { this.code = c; return this; },
        json: function (o) { this.body = o; return this; }
    };
}

function cancelReq(orderId) {
    return { params: { id: String(orderId) }, user: { _id: userId } };
}

async function makeProduct(stock, variants) {
    return Product.create({
        name: "Cancel Test " + Math.random().toString(36).slice(2),
        price: 30,
        unit: "kg",
        category: "Vegetables",
        stock: stock,
        variants: variants || []
    });
}

async function makeOrder(product, quantity, variantId) {
    return Order.create({
        orderNumber: "FM-TEST-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
        user: userId,
        customer: { name: "Test", phone: "9990001111", address: "1 Test St", city: "Delhi", pincode: "110001" },
        items: [{ name: product.name, price: 30, quantity: quantity, productId: product._id, variantId: variantId || null }],
        subtotal: 30 * quantity,
        total: 30 * quantity,
        status: "Placed",
        paymentStatus: "PENDING"
    });
}

describe("Order cancellation restocks exactly once (concurrent)", function () {
    this.timeout(120000);
    let conn;

    before(async function () {
        conn = await testDb.connectTestDb(mongoose, "ordercancel");
        Order = require("../../models/Order");
        Product = require("../../models/Product");
        controller = require("../../controllers/orderController");
    });

    after(async function () {
        if (conn) await conn.close(true);
    });

    beforeEach(async function () {
        await Promise.all([Order.deleteMany({}), Product.deleteMany({})]);
    });

    it("a double cancellation increments stock EXACTLY once", async function () {
        const p = await makeProduct(45);
        const order = await makeOrder(p, 5);

        const r1 = res();
        const r2 = res();
        await Promise.allSettled([
            controller.cancelOrder(cancelReq(order._id), r1),
            controller.cancelOrder(cancelReq(order._id), r2)
        ]);

        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 50, "stock must increase by exactly 5 (got " + pAfter.stock + ")");

        const oAfter = await Order.findById(order._id).lean();
        assert.strictEqual(oAfter.status, "Cancelled");
        assert.strictEqual(oAfter.stockRestored, true, "the stock claim flag must be set");
    });

    it("a repeated cancellation after success does not increment stock again", async function () {
        const p = await makeProduct(10);
        const order = await makeOrder(p, 3);

        const r1 = res();
        await controller.cancelOrder(cancelReq(order._id), r1);
        assert.strictEqual(r1.code, 200, "first cancel should succeed");

        const r2 = res();
        await controller.cancelOrder(cancelReq(order._id), r2);
        assert.notStrictEqual(r2.code, 200, "second cancel must be rejected");

        const pAfter = await Product.findById(p._id).lean();
        assert.strictEqual(pAfter.stock, 13, "stock must increase by exactly 3 (got " + pAfter.stock + ")");
    });

    it("a double cancellation of a variant item increments the variant EXACTLY once", async function () {
        const variantId = new mongoose.Types.ObjectId();
        const p = await makeProduct(0, [{ _id: variantId, unit: "500g", price: 30, stock: 20 }]);
        const order = await makeOrder(p, 4, variantId);

        const r1 = res();
        const r2 = res();
        await Promise.allSettled([
            controller.cancelOrder(cancelReq(order._id), r1),
            controller.cancelOrder(cancelReq(order._id), r2)
        ]);

        const pAfter = await Product.findById(p._id).lean();
        const v = pAfter.variants.find(function (x) { return String(x._id) === String(variantId); });
        assert.strictEqual(v.stock, 24, "variant stock must increase by exactly 4 (got " + v.stock + ")");
    });
});
