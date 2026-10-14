// ===============================
// RESTOCK EXACTLY-ONCE / IDEMPOTENCY TESTS
// ===============================
// Exercises the REAL adminUpdateReturnStatus controller against an ISOLATED
// throwaway database (fm_restock_e2e_<pid>) on the same cluster. No production
// data is read or written. Requires transaction support (Atlas replica set).
//
// Failure modes covered:
//   * partial failure midway through multiple item increments
//   * retry recovery after a failed restock
//   * concurrent duplicate restock attempts
//   * re-drive after a successful restock (must not double-increment)

const assert = require("assert");
const mongoose = require("mongoose");
const testDb = require("./testDb");

let ReturnRequest;
let Product;
let Order;
let controller;

const adminId = new mongoose.Types.ObjectId();
const dummyOrderId = new mongoose.Types.ObjectId();

function res() {
    return {
        code: 200,
        body: null,
        status: function (c) { this.code = c; return this; },
        json: function (o) { this.body = o; return this; }
    };
}

function adminReq(id, status) {
    return { params: { id: String(id) }, body: { status: status || "REPLACEMENT_DELIVERED" }, user: { _id: adminId, role: "admin" } };
}

async function makeProduct(stock, variants) {
    const p = await Product.create({
        name: "Restock Test " + Math.random().toString(36).slice(2),
        price: 50,
        unit: "kg",
        category: "Vegetables",
        stock: stock,
        variants: variants || []
    });
    return p;
}

async function makeReturn(items, status) {
    return ReturnRequest.create({
        returnNumber: "RR-TEST-" + Math.random().toString(36).slice(2, 10).toUpperCase(),
        order: dummyOrderId,
        user: null,
        customer: { name: "Test", phone: "9990001111" },
        items: items,
        returnType: "replacement",
        reason: "restock test",
        status: status || "REPLACEMENT_INITIATED",
        timeline: [],
        stockRestocked: false
    });
}

describe("Return restock exactly-once (transactional)", function () {
    this.timeout(120000);
    let conn;

    before(async function () {
        conn = await testDb.connectTestDb(mongoose, "restock");
        ReturnRequest = require("../../models/ReturnRequest");
        Product = require("../../models/Product");
        Order = require("../../models/Order");
        controller = require("../../controllers/returnController");

        // Confirm the isolated cluster actually supports transactions.
        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async function () {
                await ReturnRequest.findOne({ _id: new mongoose.Types.ObjectId() }).session(session);
            });
        } catch (e) {
            await session.endSession();
            throw new Error("This cluster does not support transactions: " + (e && e.message));
        }
        await session.endSession();
    });

    after(async function () {
        if (conn) await conn.close(true);
    });

    beforeEach(async function () {
        await Promise.all([
            ReturnRequest.deleteMany({}),
            Product.deleteMany({}),
            Order.deleteMany({})
        ]);
    });

    it("rolls back ALL increments on a mid-loop failure, leaving stock and the flag untouched", async function () {
        const a = await makeProduct(100);
        const b = await makeProduct(200);
        const rt = await makeReturn([
            { productId: a._id, name: a.name, price: 50, quantity: 3, variantId: null },
            { productId: b._id, name: b.name, price: 50, quantity: 5, variantId: null }
        ]);

        const real = Product.findOneAndUpdate.bind(Product);
        let calls = 0;
        Product.findOneAndUpdate = function () {
            calls += 1;
            if (calls === 2) return Promise.reject(new Error("injected mid-loop failure"));
            return real.apply(null, arguments);
        };
        let err = null;
        const r = res();
        try {
            await controller.adminUpdateReturnStatus(adminReq(rt._id), r);
        } catch (e) { err = e; } finally {
            Product.findOneAndUpdate = real;
        }
        assert.strictEqual(err, null, "controller should not throw (it returns 500)");
        assert.strictEqual(r.code, 500, "mid-loop failure must surface as 500");

        const aAfter = await Product.findById(a._id).lean();
        const bAfter = await Product.findById(b._id).lean();
        assert.strictEqual(aAfter.stock, 100, "item 1 increment must be rolled back");
        assert.strictEqual(bAfter.stock, 200, "item 2 must be unchanged");
        const rtAfter = await ReturnRequest.findById(rt._id).lean();
        assert.strictEqual(rtAfter.stockRestocked, false, "claim must be rolled back for a clean retry");
    });

    it("recovers cleanly on retry: each item incremented exactly once", async function () {
        const a = await makeProduct(100);
        const b = await makeProduct(200);
        const rt = await makeReturn([
            { productId: a._id, name: a.name, price: 50, quantity: 3, variantId: null },
            { productId: b._id, name: b.name, price: 50, quantity: 5, variantId: null }
        ]);

        // First attempt fails midway.
        const real = Product.findOneAndUpdate.bind(Product);
        let calls = 0;
        Product.findOneAndUpdate = function () {
            calls += 1;
            if (calls === 2) return Promise.reject(new Error("injected failure"));
            return real.apply(null, arguments);
        };
        const r1 = res();
        await controller.adminUpdateReturnStatus(adminReq(rt._id), r1);
        Product.findOneAndUpdate = real;
        assert.strictEqual(r1.code, 500);

        // Retry succeeds.
        const r2 = res();
        await controller.adminUpdateReturnStatus(adminReq(rt._id), r2);
        assert.strictEqual(r2.code, 200, "retry should succeed: " + JSON.stringify(r2.body));

        const aAfter = await Product.findById(a._id).lean();
        const bAfter = await Product.findById(b._id).lean();
        assert.strictEqual(aAfter.stock, 103, "item 1 incremented exactly once");
        assert.strictEqual(bAfter.stock, 205, "item 2 incremented exactly once");
        const rtAfter = await ReturnRequest.findById(rt._id).lean();
        assert.strictEqual(rtAfter.stockRestocked, true);
    });

    it("does not double-increment under concurrent duplicate attempts", async function () {
        const a = await makeProduct(100);
        const rt = await makeReturn([
            { productId: a._id, name: a.name, price: 50, quantity: 4, variantId: null }
        ]);

        const r1 = res();
        const r2 = res();
        const results = await Promise.allSettled([
            controller.adminUpdateReturnStatus(adminReq(rt._id), r1),
            controller.adminUpdateReturnStatus(adminReq(rt._id), r2)
        ]);
        const codes = [r1.code, r2.code];
        assert.ok(codes.indexOf(200) !== -1, "at least one attempt should succeed, got " + JSON.stringify(codes));

        const aAfter = await Product.findById(a._id).lean();
        assert.strictEqual(aAfter.stock, 104, "stock must be incremented EXACTLY once (got " + aAfter.stock + ")");
        const rtAfter = await ReturnRequest.findById(rt._id).lean();
        assert.strictEqual(rtAfter.stockRestocked, true);
    });

    it("re-drive after a committed restock does not increment again", async function () {
        const a = await makeProduct(100);
        const rt = await makeReturn([
            { productId: a._id, name: a.name, price: 50, quantity: 7, variantId: null }
        ]);

        const r1 = res();
        await controller.adminUpdateReturnStatus(adminReq(rt._id), r1);
        assert.strictEqual(r1.code, 200);
        let aAfter = await Product.findById(a._id).lean();
        assert.strictEqual(aAfter.stock, 107);

        // Force the state machine back so the same return could be re-driven.
        await ReturnRequest.updateOne({ _id: rt._id }, { $set: { status: "REPLACEMENT_INITIATED" } });
        const r2 = res();
        await controller.adminUpdateReturnStatus(adminReq(rt._id), r2);
        assert.strictEqual(r2.code, 200, "re-drive should be accepted");
        aAfter = await Product.findById(a._id).lean();
        assert.strictEqual(aAfter.stock, 107, "stock must NOT be incremented a second time");
    });

    it("restocks a variant item exactly once", async function () {
        const variantId = new mongoose.Types.ObjectId();
        const p = await makeProduct(0, [{ _id: variantId, unit: "500g", price: 30, stock: 10 }]);
        const rt = await makeReturn([
            { productId: p._id, name: p.name, price: 30, quantity: 2, variantId: variantId }
        ]);

        const r1 = res();
        await controller.adminUpdateReturnStatus(adminReq(rt._id), r1);
        assert.strictEqual(r1.code, 200, JSON.stringify(r1.body));
        const pAfter = await Product.findById(p._id).lean();
        const v = pAfter.variants.find(function (x) { return String(x._id) === String(variantId); });
        assert.strictEqual(v.stock, 12, "variant stock must be +2");
        const rtAfter = await ReturnRequest.findById(rt._id).lean();
        assert.strictEqual(rtAfter.stockRestocked, true);
    });
});
