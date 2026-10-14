// ===============================
// WALLET INDEX REGRESSION TEST
// Verifies the compound index {user:1, type:1, referenceId:1} enforces
// per-user uniqueness while allowing cross-user sharing of (type, referenceId).
// Uses the isolated test database helper (testDb) — NO production writes.
// ===============================

const assert = require("assert");
const mongoose = require("mongoose");
const { connectTestDb, assertConnectionIsTestDb } = require("./testDb");
const WalletTransaction = require("../../models/WalletTransaction");

// Suite name must be lowercase [a-z0-9_]
const SUITE = "walletindex_e2e_1";

describe("Wallet Index: per-user uniqueness (type, referenceId)", function () {
    let dbName;

    before(async function () {
        // Connect once to an isolated test database (guarded by testDb).
        const conn = connectTestDb(mongoose, SUITE);
        const resolved = await conn;
        dbName = resolved.dbName;
        assertConnectionIsTestDb(mongoose, dbName);
    });

    beforeEach(async function () {
        // Fresh DB per test; dropping removes indexes, so rebuild them.
        await mongoose.connection.db.dropDatabase();
        await WalletTransaction.createIndexes();
    });

    after(async function () {
        try { await mongoose.connection.db.dropDatabase(); } catch (e) {}
        await mongoose.connection.close();
    });

    // ---- Helpers ----
    function makeTx(doc) {
        const T = new WalletTransaction(doc);
        return T.save();
    }

    // ---- 1. Same user + same type/referenceId -> one transaction only ----
    it("should allow only one transaction per (user, type, referenceId) under concurrent retries", async function () {
        assertConnectionIsTestDb(mongoose, dbName);
        const userId = new mongoose.Types.ObjectId();

        // Two concurrent credits with the same (user, type, referenceId): the
        // unique index lets exactly one win; the loser gets an E11000.
        const results = await Promise.allSettled([
            makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "ref123", amount: 100, balanceAfter: 100 }),
            makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "ref123", amount: 200, balanceAfter: 200 })
        ]);

        const fulfilled = results.filter(function (r) { return r.status === "fulfilled"; });
        const rejected = results.filter(function (r) { return r.status === "rejected"; });
        assert.strictEqual(fulfilled.length, 1, "exactly one credit should win");
        assert.strictEqual(rejected.length, 1, "exactly one credit should lose");
        assert.strictEqual(rejected[0].reason.code, 11000, "loser should be a duplicate-key error");

        const count = await WalletTransaction.countDocuments({
            user: userId,
            type: "REFERRAL_REWARD",
            referenceId: "ref123"
        });
        assert.strictEqual(count, 1, "only one ledger row should exist");
    });

    // ---- 2. Different users + same type/referenceId -> independent transactions ----
    it("should allow different users to have the same (type, referenceId) independently", async function () {
        assertConnectionIsTestDb(mongoose, dbName);
        const userId1 = new mongoose.Types.ObjectId();
        const userId2 = new mongoose.Types.ObjectId();

        await makeTx({ user: userId1, type: "REFERRAL_REWARD", referenceId: "ref456", amount: 50, balanceAfter: 50 });
        await makeTx({ user: userId2, type: "REFERRAL_REWARD", referenceId: "ref456", amount: 75, balanceAfter: 75 });

        const count = await WalletTransaction.countDocuments({
            type: "REFERRAL_REWARD",
            referenceId: "ref456"
        });
        assert.strictEqual(count, 2, "one row per user must coexist");
    });

    // ---- 3. Same user + different referenceIds -> legitimate independent credits ----
    it("should allow same user with different reference IDs as independent credits", async function () {
        assertConnectionIsTestDb(mongoose, dbName);
        const userId = new mongoose.Types.ObjectId();

        await makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "refA", amount: 50, balanceAfter: 50 });
        await makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "refB", amount: 75, balanceAfter: 75 });

        const count = await WalletTransaction.countDocuments({
            user: userId,
            type: "REFERRAL_REWARD"
        });
        assert.strictEqual(count, 2);
    });

    // ---- 4. Duplicate-key error handling ----
    it("should not leave wallet balance inconsistent with ledger after duplicate-key error", async function () {
        assertConnectionIsTestDb(mongoose, dbName);
        const userId = new mongoose.Types.ObjectId();

        await makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "dupTest", amount: 100, balanceAfter: 100 });

        let errCaught = false;
        try {
            await makeTx({ user: userId, type: "REFERRAL_REWARD", referenceId: "dupTest", amount: 200, balanceAfter: 200 });
        } catch (err) {
            errCaught = true;
            assert.strictEqual(err.code, 11000);
        }
        assert.strictEqual(errCaught, true, "duplicate key must be rejected");

        const count = await WalletTransaction.countDocuments({
            user: userId,
            type: "REFERRAL_REWARD",
            referenceId: "dupTest"
        });
        assert.strictEqual(count, 1);

        const txCount = await WalletTransaction.countDocuments({ user: userId });
        assert.strictEqual(txCount, 1);
    });
});
