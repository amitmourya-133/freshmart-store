// ===============================
// ISOLATED HTTP SUITE RUNNER
// ===============================
//
// Boots the real FreshMart server against a throwaway `fm_*_e2e_<n>` database,
// runs a suite that talks to it over HTTP, then kills the server and drops the
// database. The production database is never involved at any step.
//
//   node tests/lib/runHttpSuite.js part10 [part11 ...]
//
// This exists because the HTTP suites could not previously be run safely:
// they expected a server already listening on port 5000, connected to whatever
// database that server happened to be using — usually production.

const cp = require("child_process");
const path = require("path");
const mongoose = require(path.join(__dirname, "..", "..", "node_modules", "mongoose"));
const testDb = require("./testDb");

const REPO = path.join(__dirname, "..", "..");
const PORT = Number(process.env.FM_TEST_PORT || 5123);
const BASE_URL = "http://127.0.0.1:" + PORT;

function randomSuffix() {
    // 5 digits: keeps the name inside TEST_DB_PATTERN and makes accidental
    // collisions with another concurrent run very unlikely.
    return String(10000 + Math.floor(Math.random() * 89999));
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function waitForHealth(expectedDb, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 45000);
    const http = require("http");
    let last = "not started";
    while (Date.now() < deadline) {
        try {
            const res = await new Promise((resolve, reject) => {
                const req = http.request(
                    { hostname: "127.0.0.1", port: PORT, path: "/api/health", method: "GET", timeout: 2000 },
                    (r) => {
                        let d = "";
                        r.on("data", (c) => { d += c; });
                        r.on("end", () => resolve({ status: r.statusCode, raw: d }));
                    }
                );
                req.on("timeout", () => req.destroy(new Error("timeout")));
                req.on("error", reject);
                req.end();
            });
            let parsed = null;
            try { parsed = JSON.parse(res.raw); } catch (e) { parsed = null; }
            if (res.status === 200 && parsed && parsed.success) {
                if (parsed.db !== expectedDb) {
                    throw new Error("server is on '" + parsed.db + "', expected '" + expectedDb + "'");
                }
                return true;
            }
            last = "status " + res.status;
        } catch (e) {
            last = e.message;
            if (/expected/.test(last)) throw e;
        }
        await sleep(400);
    }
    throw new Error("server never became healthy (" + last + ")");
}

async function runSuite(suite) {
    const file = path.join(REPO, suite + ".js");
    // "part10_security_e2e" -> "part10_security", so the database reads
    // fm_part10_security_e2e_<n> rather than repeating "_e2e".
    const token = suite.replace(/_e2e$/, "").toLowerCase();
    const dbName = "fm_" + token + "_e2e_" + randomSuffix();
    const { uri } = testDb.deriveTestUri(token, dbName);
    testDb.assertTestUri(uri);

    console.log("\n=========================================================");
    console.log(" " + suite + "  ->  database " + dbName);
    console.log("=========================================================");

    const server = cp.spawn(process.execPath, [path.join(REPO, "server.js")], {
        cwd: REPO,
        env: Object.assign({}, process.env, {
            MONGODB_URI: uri,
            PORT: String(PORT),
            NODE_ENV: "test",
            // Makes /api/health report the connected database so both the
            // runner and the suite can prove they are not on production.
            FM_TEST_MODE: "1",
            FM_DB_FORCE: ""
        }),
        stdio: ["ignore", "pipe", "pipe"]
    });

    const serverLog = [];
    server.stdout.on("data", (d) => { serverLog.push(d.toString()); });
    server.stderr.on("data", (d) => { serverLog.push(d.toString()); });

    let code = 1;
    try {
        await waitForHealth(dbName);
        console.log("server up on " + BASE_URL + " / " + dbName);
        const r = cp.spawnSync(process.execPath, [file], {
            cwd: REPO,
            stdio: "inherit",
            env: Object.assign({}, process.env, {
                MONGODB_URI: uri,
                FM_TEST_DB_NAME: dbName,
                FM_TEST_BASE_URL: BASE_URL,
                FM_DB_FORCE: ""
            })
        });
        code = r.status === null ? 1 : r.status;
    } catch (e) {
        console.error("RUNNER ERROR: " + e.message);
        console.error("--- server output ---");
        console.error(serverLog.join("").split("\n").slice(-40).join("\n"));
    } finally {
        server.kill("SIGTERM");
        await sleep(800);
        if (server.exitCode === null) { try { server.kill("SIGKILL"); } catch (e) {} }
        // Drop the throwaway database even if the suite failed.
        try {
            await mongoose.connect(uri);
            await mongoose.connection.db.dropDatabase();
            await mongoose.disconnect();
            console.log("dropped " + dbName);
        } catch (e) {
            console.error("could not drop " + dbName + ": " + e.message);
        }
    }
    return { suite: suite, dbName: dbName, code: code };
}

async function main() {
    const suites = process.argv.slice(2).filter((a) => !a.startsWith("-"));
    if (!suites.length) {
        console.error("usage: node tests/lib/runHttpSuite.js <suite.js-basename> [...]");
        console.error("example: node tests/lib/runHttpSuite.js part10_security_e2e");
        process.exit(2);
    }

    const results = [];
    for (const s of suites) {
        results.push(await runSuite(s.replace(/\.js$/, "")));
    }

    console.log("\n=========================================================");
    console.log(" HTTP SUITE SUMMARY");
    console.log("=========================================================");
    let bad = 0;
    for (const r of results) {
        console.log((r.code === 0 ? "  PASS  " : "  FAIL  ") + r.suite + "  (" + r.dbName + ")");
        if (r.code !== 0) bad++;
    }
    process.exit(bad === 0 ? 0 : 1);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
