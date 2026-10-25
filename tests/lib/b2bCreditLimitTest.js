// ===============================
// B2B CREDIT LIMIT (DB-backed, C3)
// ===============================

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

describe("B2B credit limit (C3)", function () {
    this.timeout(120000);
    let conn, Order, b2bController;
    const buyerId = new mongoose.Types.ObjectId();
    before(async function () {
        if (!isSafeTestHost()) this.skip("No safe isolated MongoDB (localhost) available.");
        conn = await testDb.connectTestDb(mongoose, "b2bcreditlimit");
        Order = require("../../models/Order");
        b2bController = require("../../controllers/b2bController");
    });
    after(async function () { if (conn) await conn.close(true); });
    beforeEach(async function () { await Order.deleteMany({}); });

    async function seedStatus(status, total) {
        await Order.create({
            orderNumber: "B2B-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
            orderType: "b2b", paymentMode: "credit", status: status, total: total, user: buyerId,
            customer: { name: "T", phone: "9990001111", address: "1 St", city: "Delhi", pincode: "110001" },
            items: [], subtotal: total, delivery: 0, discount: 0
        });
    }

    it("creditUsedFor includes Preparing and excludes Cancelled", async function () {
        await seedStatus("Placed", 100);
        await seedStatus("Confirmed", 100);
        await seedStatus("Preparing", 100);
        await seedStatus("Out for Delivery", 100);
        await seedStatus("Delivered", 100);
        await seedStatus("Cancelled", 100);
        const state = await b2bController.creditUsedFor(buyerId);
        // used = all non-cancelled = 500
        assert.strictEqual(state.used, 500);
        // open = all except Cancelled (including Preparing) = 500
        assert.strictEqual(state.open, 500);
    });

    it("Cancelled orders do not count toward open", async function () {
        await seedStatus("Cancelled", 200);
        const state = await b2bController.creditUsedFor(buyerId);
        assert.strictEqual(state.open, 0);
        assert.strictEqual(state.used, 0);
    });
});