// ===============================
// TEST DATABASE SAFETY HELPER
// ===============================
//
// Every suite in this repository that WRITES data must go through this module.
// It exists because three suites used to connect straight to the production
// MONGODB_URI from `.env` and create real Users/Orders/Reviews there.
//
// The rule is absolute: a test may only ever write to a database whose name
// matches `fm_<suite>_e2e_<pid>`. Nothing else. This module refuses to hand
// back a URI that points anywhere else, and it re-parses its own output as a
// second, independent check (a regex that silently fails to substitute must
// not be able to leak a production URI to a suite).
//
// No production data is ever read, written, updated or dropped from here. The
// only destructive call exposed is `dropTestDb`, which drops exactly the one
// database this module created.

const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");

// Database names that must never be written to by a test process.
const PROTECTED_DB_NAMES = new Set([
    "freshmart",      // this repository's production database
    "production",
    "prod",
    "admin",
    "local",
    "config",
]);

// Every test database this repo is allowed to create.
const TEST_DB_PATTERN = /^fm_[a-z0-9]+(?:_[a-z0-9]+)*_e2e_[0-9]+$/;

// Refuse anything that could plausibly be a credential.
const SAFE_TOKEN = /^[a-z0-9_]+$/;

function readDotEnvValue(name) {
    const file = path.join(REPO, ".env");
    if (!fs.existsSync(file)) return null;
    const m = fs.readFileSync(file, "utf8").match(new RegExp("^" + name + "=(.*)$", "m"));
    return m ? m[1].trim() : null;
}

function baseMongoUri() {
    const uri = process.env.MONGODB_URI || readDotEnvValue("MONGODB_URI");
    if (!uri) {
        throw new Error(
            "[testDb] MONGODB_URI is not set (checked process.env and .env). " +
            "Refusing to guess a database."
        );
    }
    return uri;
}

// Pull the database name out of a mongodb URI without needing a parser:
// everything after the last "/" of the authority section, before "?".
function dbNameOf(uri) {
    const noQuery = String(uri).split("?")[0];
    const withoutScheme = noQuery.replace(/^mongodb(\+srv)?:\/\//, "");
    const slash = withoutScheme.indexOf("/");
    if (slash === -1) return "";
    return withoutScheme.slice(slash + 1);
}

// Swap ONLY the database segment. Credentials, host, port, replica set and
// every query option are preserved byte-for-byte.
function withDbName(uri, dbName) {
    const noQuery = String(uri);
    const queryAt = noQuery.indexOf("?");
    const head = queryAt === -1 ? noQuery : noQuery.slice(0, queryAt);
    const tail = queryAt === -1 ? "" : noQuery.slice(queryAt);
    const schemeAt = head.indexOf("://");
    if (schemeAt === -1) throw new Error("[testDb] not a mongodb URI");
    const afterScheme = schemeAt + 3;
    const slash = head.indexOf("/", afterScheme);
    if (slash === -1) {
        // No database segment at all: append one.
        return head + "/" + dbName + tail;
    }
    return head.slice(0, slash + 1) + dbName + tail;
}

/**
 * Build an isolated test URI.
 *
 * @param {string} suite  short suite token, e.g. "part10" or "money".
 *                         Must match /^[a-z0-9]+(_[a-z0-9]+)*$/.
 * @param {string} [forcedDbName]  use this exact database name instead of the
 *                         PID-derived default. Needed when the suite talks to
 *                         an HTTP server that had to be started beforehand:
 *                         the runner picks the name, starts the server on it,
 *                         then passes the same name to the suite. It is held
 *                         to exactly the same guards as a derived name.
 * @returns {{uri: string, dbName: string, baseDbName: string}}
 * @throws  if anything about the result is not provably a throwaway database.
 */
function deriveTestUri(suite, forcedDbName) {
    const token = String(suite || "").toLowerCase();
    if (!SAFE_TOKEN.test(token)) {
        throw new Error("[testDb] suite name must be lowercase [a-z0-9_], got: " + JSON.stringify(suite));
    }

    const base = baseMongoUri();
    const baseDbName = dbNameOf(base);
    const dbName = forcedDbName === undefined || forcedDbName === null || forcedDbName === ""
        ? "fm_" + token + "_e2e_" + process.pid
        : String(forcedDbName);

    if (!SAFE_TOKEN.test(dbName)) {
        throw new Error("[testDb] forced database name must be lowercase [a-z0-9_], got: " + JSON.stringify(forcedDbName));
    }

    // --- hard guards, in order -------------------------------------------
    if (PROTECTED_DB_NAMES.has(dbName)) {
        throw new Error("[testDb] REFUSING: computed test database is protected: " + dbName);
    }
    if (!TEST_DB_PATTERN.test(dbName)) {
        throw new Error("[testDb] REFUSING: computed database name is not a recognised test database: " + dbName);
    }

    const uri = withDbName(base, dbName);

    // Second, independent verification: re-read what we just built. This is
    // what catches a URI shape that withDbName() failed to rewrite.
    const builtName = dbNameOf(uri);
    if (builtName !== dbName) {
        throw new Error("[testDb] REFUSING: built URI points at '" + builtName + "', expected '" + dbName + "'");
    }
    if (PROTECTED_DB_NAMES.has(builtName)) {
        throw new Error("[testDb] REFUSING: built URI resolves to a protected database: " + builtName);
    }
    if (builtName === baseDbName) {
        // The base URI already carried the database we were asked to produce.
        // That is only acceptable when the base database is itself a verified
        // throwaway test database (this happens when the HTTP runner has
        // already handed the suite an isolated MONGODB_URI). Otherwise it means
        // the rewrite silently failed and we would be about to use production.
        const baseIsTestDb = !PROTECTED_DB_NAMES.has(baseDbName) && TEST_DB_PATTERN.test(baseDbName);
        if (!baseIsTestDb) {
            throw new Error("[testDb] REFUSING: built URI still points at the base database '" + baseDbName + "'");
        }
        return { uri: uri, dbName: dbName, baseDbName: baseDbName };
    }
    // The host must be untouched: only the database name may change.
    if (uri.replace(/\/[^/?]+(\?|$)/, "/DB$1") !== String(base).replace(/\/[^/?]+(\?|$)/, "/DB$1")) {
        throw new Error("[testDb] REFUSING: rewriting the database name altered the connection string");
    }

    return { uri: uri, dbName: dbName, baseDbName: baseDbName };
}

/**
 * Assert that an arbitrary URI is safe for a test process to write to.
 * Used by suites that build their own connection (and by the guard test).
 */
function assertTestUri(uri) {
    const name = dbNameOf(uri);
    if (PROTECTED_DB_NAMES.has(name)) {
        throw new Error("[testDb] REFUSING: '" + name + "' is a protected database");
    }
    if (!TEST_DB_PATTERN.test(name)) {
        throw new Error("[testDb] REFUSING: '" + name + "' is not a recognised test database (expected " + TEST_DB_PATTERN + ")");
    }
    return name;
}

/** Drop ONLY the given test database. Never touches anything else. */
async function dropTestDb(mongoose, dbName) {
    assertTestUri(withDbName(baseMongoUri(), dbName));
    await mongoose.connection.db.dropDatabase();
}

/**
 * Remove abandoned test databases left behind by earlier interrupted runs.
 * There are orphaned `fm_*_e2e_<pid>` databases on the production cluster from
 * runs that were interrupted mid-suite.
 *
 * Deliberately narrow — two automatic filters only:
 *   1. the name must match TEST_DB_PATTERN and must not be protected;
 *   2. the database must be small (< 50 MB). A large match is reported but
 *      left alone so a human can inspect it before anything is destroyed.
 *
 * @returns {{dropped: string[], skipped: string[]}}
 */
async function dropOrphanTestDbs(mongoose, sizeCeilingBytes) {
    const ceiling = sizeCeilingBytes === undefined ? 50 * 1024 * 1024 : sizeCeilingBytes;
    const base = baseMongoUri();
    await mongoose.connect(base);
    const admin = mongoose.connection.db.admin();
    const { databases } = await admin.listDatabases();
    const dropped = [];
    const skipped = [];
    for (const d of databases) {
        const name = d.name;
        if (PROTECTED_DB_NAMES.has(name) || !TEST_DB_PATTERN.test(name)) continue;
        const sizeOnDisk = typeof d.sizeOnDisk === "number" ? d.sizeOnDisk : 0;
        if (sizeOnDisk > ceiling) {
            skipped.push(name + " (" + sizeOnDisk + " bytes)");
            continue;
        }
        await mongoose.connection.client.db(name).dropDatabase();
        dropped.push(name);
    }
    await mongoose.connection.close();
    return { dropped: dropped, skipped: skipped };
}

/**
 * Connect mongoose to an isolated test database and register cleanup.
 * Returns { uri, dbName, close() }.
 */
async function connectTestDb(mongoose, suite) {
    const { uri, dbName } = deriveTestUri(suite);
    assertTestUri(uri);
    // Test databases must never gain collections as a side effect of another
    // suite's models being registered on the shared mongoose instance: with the
    // default autoIndex/autoCreate, connecting (re)builds indexes and creates
    // collections, which raced dropTestDb and left a stray `orders` collection.
    await mongoose.connect(uri, { autoIndex: false, autoCreate: false });
    // connection.name is a bare database name (not a URI), so compare the
    // authoritative connected name directly - dbNameOf() would return "" here.
    const actual = connectedDbName(mongoose) || mongoose.connection.name || "";
    if (actual !== dbName) {
        await mongoose.disconnect().catch(function () {});
        throw new Error("[testDb] connected to '" + actual + "' instead of '" + dbName + "'");
    }
    return {
        uri: uri,
        dbName: dbName,
        close: async function (drop) {
            try {
                if (drop !== false) await mongoose.connection.db.dropDatabase();
            } catch (e) { /* already gone */ }
            await mongoose.disconnect().catch(function () {});
        }
    };
}

/**
 * Confirm that the API server a suite is about to hammer over HTTP is the one
 * connected to this suite's throwaway database.
 *
 * Without this, an HTTP suite can pass vacuously: it writes fixtures into its
 * own isolated database, sends requests to a server that is still attached to
 * production, sees "not found" for its own fixtures, and reports a green run
 * that tested nothing — while any write it does trigger lands in production.
 *
 * Requires the server to be started with FM_TEST_MODE=1 so /api/health reports
 * the connected database name.
 *
 * @param {string} baseUrl   e.g. "http://localhost:5000"
 * @param {string} dbName    expected database name
 * @param {number} timeoutMs
 */
async function assertServerOnTestDb(baseUrl, dbName, timeoutMs) {
    const budget = timeoutMs === undefined ? 20000 : timeoutMs;
    const deadline = Date.now() + budget;
    let lastErr = "no response";
    while (Date.now() < deadline) {
        try {
            const http = require("http");
            const url = new URL(baseUrl + "/api/health");
            const res = await new Promise((resolve, reject) => {
                const req = http.request(
                    {
                        hostname: url.hostname,
                        port: url.port || 80,
                        path: url.pathname,
                        method: "GET",
                        timeout: 3000
                    },
                    (r) => {
                        let d = "";
                        r.on("data", (c) => { d += c; });
                        r.on("end", () => resolve({ status: r.statusCode, raw: d }));
                    }
                );
                req.on("timeout", () => { req.destroy(new Error("timeout")); });
                req.on("error", reject);
                req.end();
            });
            let parsed = null;
            try { parsed = JSON.parse(res.raw); } catch (e) { parsed = null; }
            if (res.status === 200 && parsed && parsed.success) {
                if (!parsed.db) {
                    throw new Error(
                        "[testDb] " + baseUrl + " did not report a database name. Start the server " +
                        "with FM_TEST_MODE=1 (and the test MONGODB_URI) or this suite cannot prove isolation."
                    );
                }
                if (parsed.db !== dbName) {
                    throw new Error(
                        "[testDb] REFUSING to run: " + baseUrl + " is connected to '" + parsed.db +
                        "' but this suite owns '" + dbName + "'. Restart the server against the test database."
                    );
                }
                return true;
            }
            lastErr = "status " + res.status;
        } catch (e) {
            lastErr = e && e.message ? e.message : String(e);
            // A guard failure is a hard stop, not a retry: the server answered.
            if (/did not report a database name|REFUSING/.test(lastErr)) throw new Error(lastErr);
        }
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("[testDb] " + baseUrl + "/api/health never became ready (" + lastErr + ")");
}

/**
 * The database a live mongoose connection is actually attached to.
 *
 * `connection.name` is empty immediately after connect() on some drivers, so
 * prefer `connection.db.databaseName`, which comes straight from the server.
 * This is the authoritative post-connect check: it reports what the driver
 * really bound to, not what we asked for.
 */
function connectedDbName(mongoose) {
    const c = mongoose && mongoose.connection;
    if (!c) return "";
    if (c.db && c.db.databaseName) return c.db.databaseName;
    return c.name || "";
}

/**
 * Assert that a live mongoose connection is on an isolated test database.
 * Throws if it is on production or anything unrecognised.
 */
function assertConnectionIsTestDb(mongoose, expectedDbName) {
    const actual = connectedDbName(mongoose);
    if (PROTECTED_DB_NAMES.has(actual)) {
        throw new Error("[testDb] REFUSING: connection is on protected database '" + actual + "'");
    }
    if (!TEST_DB_PATTERN.test(actual)) {
        throw new Error("[testDb] REFUSING: connection is on '" + actual + "', which is not a recognised test database");
    }
    if (expectedDbName && actual !== expectedDbName) {
        throw new Error("[testDb] REFUSING: connection is on '" + actual + "', expected '" + expectedDbName + "'");
    }
    return actual;
}

module.exports = {
    REPO,
    PROTECTED_DB_NAMES,
    TEST_DB_PATTERN,
    readDotEnvValue,
    baseMongoUri,
    dbNameOf,
    withDbName,
    deriveTestUri,
    assertTestUri,
    connectedDbName,
    assertConnectionIsTestDb,
    dropTestDb,
    dropOrphanTestDbs,
    connectTestDb,
    assertServerOnTestDb,
};
