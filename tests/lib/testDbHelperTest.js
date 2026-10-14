// ===============================
// TEST-DB HELPER REGRESSION TESTS
// ===============================
// Guards the destructive helper `dropTestDb` in tests/lib/testDb.js.
//
// Background: dropTestDb() referenced an undefined `assertTestDb(...)` (the real
// helper is `assertTestUri`). Any suite calling it would throw a ReferenceError
// BEFORE the guard ran - and, more importantly, the intent (refuse anything that
// is not an isolated test database) was not actually enforced by a callable
// function. These tests pin the fixed behaviour:
//
//   1. the guard rejects protected production database names outright;
//   2. dropTestDb refuses a protected name (and drops nothing);
//   3. dropTestDb refuses a non-test, unrecognised name;
//   4. dropTestDb DOES drop an explicitly identified, correctly isolated test db.
//
// It only ever connects to and drops an isolated `fm_helper_e2e_<pid>` database.
// It never touches production and never drops a pre-existing orphan database.

const assert = require("assert");
const mongoose = require("mongoose");
const testDb = require("./testDb");

describe("testDb helper: dropTestDb guard (isolated)", function () {
    this.timeout(60000);
    let conn;

    before(async function () {
        conn = await testDb.connectTestDb(mongoose, "helper");
    });

    after(async function () {
        if (conn) await conn.close(true);
    });

    it("assertTestUri rejects every protected production database name", function () {
        const protectedNames = ["freshmart", "production", "prod", "admin", "local", "config"];
        for (const name of protectedNames) {
            const uri = testDb.withDbName(testDb.baseMongoUri(), name);
            assert.throws(
                function () { testDb.assertTestUri(uri); },
                /REFUSING|protected/i,
                "expected assertTestUri to refuse '" + name + "'"
            );
        }
    });

    it("assertTestUri accepts a correctly formed isolated test database name", function () {
        const uri = testDb.withDbName(testDb.baseMongoUri(), "fm_helper_e2e_12345");
        assert.strictEqual(testDb.assertTestUri(uri), "fm_helper_e2e_12345");
    });

    it("dropTestDb refuses a protected production name and drops nothing", async function () {
        await assert.rejects(
            testDb.dropTestDb(mongoose, "freshmart"),
            /REFUSING|protected/i,
            "dropTestDb must refuse the production database name"
        );
        // Our isolated connection must be untouched by the refused call.
        const probe = mongoose.connection.db.collection("probe_refused");
        await probe.insertOne({ keep: true });
        assert.strictEqual(await probe.countDocuments(), 1, "isolated DB must not have been dropped");
        await probe.deleteMany({});
    });

    it("dropTestDb refuses a non-test, unrecognised name", async function () {
        await assert.rejects(
            testDb.dropTestDb(mongoose, "some_random_db"),
            /REFUSING|recognised|test database/i
        );
    });

    it("dropTestDb drops exactly the identified isolated test database", async function () {
        const probe = mongoose.connection.db.collection("probe_drop");
        await probe.insertOne({ drop: true });
        assert.strictEqual(await probe.countDocuments(), 1);

        // This is the exact call that used to throw ReferenceError: assertTestDb is undefined.
        await testDb.dropTestDb(mongoose, conn.dbName);

        const names = (await mongoose.connection.db.listCollections().toArray()).map(function (c) { return c.name; });
        assert.deepStrictEqual(names, [], "all collections must be gone after the drop, got: " + names.join(","));
    });
});
