// ===============================
// PRODUCT BULK IMPORT + IMAGE DISCOVERY (DB-backed)
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

describe("Product bulk import & image discovery", function () {
    this.timeout(120000);
    let conn, Product, controller;
    const adminUser = { _id: new mongoose.Types.ObjectId(), role: "admin" };
    const customerUser = { _id: new mongoose.Types.ObjectId(), role: "customer" };

    before(async function () {
        if (!isSafeTestHost()) this.skip("No safe isolated MongoDB (localhost) available.");
        conn = await testDb.connectTestDb(mongoose, "productimport");
        Product = require("../../models/Product");
        controller = require("../../controllers/productImportController");
    });
    after(async function () { if (conn) await conn.close(true); });
    beforeEach(async function () {
        await Product.deleteMany({});
    });

    function res() { return { code: 200, body: null, status(c){this.code=c;return this;}, json(o){this.body=o;return this;} }; }

    it("rejects non-admin users", async function () {
        const r = res();
        await controller.bulkImport({ body: { csv: "name,category,price,unit\nPotato,Vegetables,30,kg" }, user: customerUser }, r);
        assert.strictEqual(r.code, 403);
    });

    it("rejects missing CSV", async function () {
        const r = res();
        await controller.bulkImport({ body: {}, user: adminUser }, r);
        assert.strictEqual(r.code, 400);
    });

    it("imports valid rows and skips duplicates", async function () {
        await Product.create({ name: "Potato", price: 30, category: "Vegetables", unit: "kg", stock: 10 });
        const csv = "name,category,price,unit,stock\nPotato,Vegetables,30,kg,50\nTomato,Vegetables,40,kg,20\nBadRow,Vegetables,abc,kg,5";
        const r = res();
        await controller.bulkImport({ body: { csv: csv }, user: adminUser }, r);
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.summary.inserted, 1);
        assert.strictEqual(r.body.summary.skipped, 1); // Potato duplicate
        assert.strictEqual(r.body.summary.failed, 1); // BadRow bad price
        const count = await Product.countDocuments({});
        assert.strictEqual(count, 2); // original Potato + Tomato
    });

    it("dry run does not insert", async function () {
        const csv = "name,category,price,unit\nOnion,Vegetables,25,kg";
        const r = res();
        await controller.bulkImport({ body: { csv: csv, dryRun: true }, user: adminUser }, r);
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.summary.inserted, 1);
        const count = await Product.countDocuments({});
        assert.strictEqual(count, 0);
    });

    it("handles Hindi/Unicode names", async function () {
        const csv = "name,category,price,unit\nआलू,Vegetables,30,kg\nप्याज,Vegetables,25,kg";
        const r = res();
        await controller.bulkImport({ body: { csv: csv }, user: adminUser }, r);
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.summary.inserted, 2);
        const p = await Product.findOne({ name: "आलू" }).lean();
        assert.ok(p);
    });

    it("rejects invalid category", async function () {
        const csv = "name,category,price,unit\nFoo,NotACategory,10,kg";
        const r = res();
        await controller.bulkImport({ body: { csv: csv }, user: adminUser }, r);
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.summary.failed, 1);
        assert.ok(r.body.results[0].reasons.join(" ").toLowerCase().includes("category"));
    });

    it("detects duplicate rows within CSV", async function () {
        const csv = "name,category,price,unit\nPotato,Vegetables,30,kg\nPotato,Vegetables,30,kg";
        const r = res();
        await controller.bulkImport({ body: { csv: csv }, user: adminUser }, r);
        assert.strictEqual(r.code, 200);
        assert.strictEqual(r.body.summary.inserted, 1);
        assert.strictEqual(r.body.summary.skipped, 1);
    });

    it("rejects oversized CSV", async function () {
        const big = "name,category,price,unit\n" + "Potato,Vegetables,30,kg\n".repeat(600);
        const r = res();
        await controller.bulkImport({ body: { csv: big }, user: adminUser }, r);
        assert.strictEqual(r.code, 413);
    });

    it("image search requires admin", async function () {
        const r = res();
        await controller.searchImages({ body: { query: "potato" }, user: customerUser }, r);
        assert.strictEqual(r.code, 403);
    });

    it("image download requires admin", async function () {
        const r = res();
        await controller.downloadImage({ body: { candidate: {} }, user: customerUser }, r);
        assert.strictEqual(r.code, 403);
    });

    it("image download rejects invalid candidate", async function () {
        const r = res();
        await controller.downloadImage({ body: { candidate: { downloadUrl: "http://evil.com/x.png" } }, user: adminUser }, r);
        assert.strictEqual(r.code, 400);
    });

    it("getAllowedValues returns categories and units", async function () {
        const r = res();
        controller.getAllowedValues({}, r);
        assert.strictEqual(r.code, 200);
        assert.ok(Array.isArray(r.body.data.categories));
        assert.ok(Array.isArray(r.body.data.units));
    });
});
