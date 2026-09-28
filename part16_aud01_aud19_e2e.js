'use strict';
// FRESHMART PART 16 — AUD-01 / AUD-19 E2E
// ===============================
// AUD-01: the DB safety guard. Seed/test helper scripts must refuse to open
// the production database. Section A exercises the guard's decision logic
// (pure URI parsing — no connection is ever made) and statically confirms the
// guard is wired into every known helper script.
// AUD-19: JWTs are pinned to the credential version. A token minted before the
// account's password was last changed must be rejected. Section B runs the app
// against a DEDICATED Mongo database (fm_aud01_aud19_e2e_<pid>) — the real
// `freshmart` database is never read or written and the test database is
// dropped on exit. Run with:  node part16_aud01_aud19_e2e.js
// ===============================

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawnSync } = require("child_process");
const REPO = __dirname;

const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI) { console.error("MONGODB_URI not found in .env"); process.exit(1); }
if (!JWT_SECRET) { console.error("JWT_SECRET not found in .env"); process.exit(1); }

const TEST_DB = "fm_aud01_aud19_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");

// The app and every model must see the test database BEFORE anything is required.
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;
process.env.NODE_ENV = "test";

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));
const User = require(path.join(REPO, "models/User"));

let passed = 0, failed = 0;
const failures = [];
function check(ok, label, extra) {
    if (ok) { passed++; console.log("  [PASS] " + label); }
    else { failed++; failures.push(label); console.log("  [FAIL] " + label + (extra !== undefined ? "  " + JSON.stringify(extra) : "")); }
}
function section(title) { console.log("\n--- " + title + " ---"); }

const sleep = (ms) => new Promise(function (r) { setTimeout(r, ms); });

// Run a tiny node snippet (the audit scripts' exact guard call pattern) in a
// child process so refusals (process.exit(1)) are observable and nothing is
// ever connected to.
function guardRun(code, env) {
    const res = spawnSync(process.execPath, ["-e", code], {
        cwd: REPO,
        encoding: "utf8",
        env: Object.assign({}, process.env, env || {}),
    });
    return { status: res.status === null ? -1 : res.status, out: ((res.stdout || "") + (res.stderr || "")).toString() };
}

const PROD_URI_CODE = "const fs=require('fs');" +
    "const g=require('./utils/dbGuard');" +
    "const uri=(fs.readFileSync('.env','utf8').match(/^MONGODB_URI=(.+)$/m)||[])[1];" +
    "g.assertSafeDbUri(uri,{purpose:'audit_16'});";

let PORT = 0;
function req(pathname, opts) {
    return new Promise((resolve, reject) => {
        const o = Object.assign({ hostname: "127.0.0.1", port: PORT, path: pathname, method: "GET" }, opts || {});
        const payload = o.body === undefined ? null : JSON.stringify(o.body);
        delete o.body;
        if (payload !== null) o.headers = Object.assign({ "Content-Type": "application/json" }, o.headers || {});
        const r = http.request(o, (res) => {
            let data = "";
            res.on("data", (c) => { data += c; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) {}
                resolve({ status: res.statusCode, json: json, raw: data });
            });
        });
        r.on("error", reject);
        if (payload !== null) r.write(payload);
        r.end();
    });
}

const GUARDED_SCRIPTS = [
    "part10_security_e2e.js",
    "part11_reviews_e2e.js",
    "part12_phase1_e2e.js",
    "seed.js",
    "seedAdmin.js",
    "testAdmin.js",
    "create_users.js",
    "setup_users.js",
];

async function main() {
    console.log("=== FRESHMART PART 16: AUD-01 / AUD-19 E2E ===");
    console.log("test database: " + TEST_DB + " (the real database is never touched)");

    // ---------------------------------------------------------------
    section("A. AUD-01: DB safety guard (pure logic, no connections)");
    // ---------------------------------------------------------------
    check(fs.existsSync(path.join(REPO, "utils/dbGuard.js")), "utils/dbGuard.js exists");
    GUARDED_SCRIPTS.forEach(function (name) {
        if (!fs.existsSync(path.join(REPO, name))) return;
        const src = fs.readFileSync(path.join(REPO, name), "utf8");
        check(
            src.indexOf("dbGuard") !== -1 && src.indexOf("assertSafeDbUri") !== -1,
            name + " is guarded",
        );
    });

    const prods = guardRun(PROD_URI_CODE);
    check(prods.status === 1 && prods.out.indexOf("PROD_DB") !== -1,
        "production .env URI is REFUSED (exit 1, PROD_DB)", { status: prods.status });

    const local = guardRun("const g=require('./utils/dbGuard');g.assertSafeDbUri('mongodb://127.0.0.1:27017/freshmart_dev',{purpose:'audit_16'});");
    check(local.status === 0, "local mongod is allowed", { status: local.status });

    const isolated = guardRun("const g=require('./utils/dbGuard');g.assertSafeDbUri('mongodb+srv://u:p@h.mongodb.net/fm_isolation_e2e_1234?retryWrites=true',{purpose:'audit_16'});");
    check(isolated.status === 0, "dedicated fm_*_e2e_* database is allowed", { status: isolated.status });

    const unknown = guardRun("const g=require('./utils/dbGuard');g.assertSafeDbUri('mongodb+srv://u:p@some-random-remote.mongodb.net/bogusdb',{purpose:'audit_16'});");
    check(unknown.status === 1 && unknown.out.indexOf("UNKNOWN_DB") !== -1,
        "unrecognised remote database is REFUSED", { status: unknown.status });

    const forced = guardRun(PROD_URI_CODE, { FM_DB_FORCE: "1" });
    check(forced.status === 0 && forced.out.indexOf("FM_DB_FORCE") !== -1,
        "FM_DB_FORCE=1 override is explicit and loud", { status: forced.status });

    const gcls = require(path.join(REPO, "utils/dbGuard"));
    const masked = gcls.classifyUri("mongodb+srv://robot:supersecretpw@h.mongodb.net/freshmart");
    check(masked && masked.masked.indexOf("supersecretpw") === -1 && masked.masked.indexOf(":****@") !== -1,
        "credentials are masked in guard output");
    check(gcls.classifyUri("mongodb://localhost:27017/x").isLocal === true, "localhost classified local");

    // ---------------------------------------------------------------
    section("B. AUD-19: JWT pinned to the credential version (isolated DB)");
    // ---------------------------------------------------------------
    await mongoose.connect(TEST_URI);

    const u = await User.create({
        email: "pin." + process.pid + "@freshmart.test",
        name: "Pin User",
        phone: "9891" + String(100000 + (process.pid % 900000)).slice(0, 6),
        role: "customer",
        emailVerified: true,
        password: "OldPass#123",
    });
    const pwdAt0 = new Date(u.pwdChangedAt).getTime();
    check(Number.isFinite(pwdAt0), "creating a user sets pwdChangedAt");

    const server = await new Promise((resolve) => {
        const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    const T1 = jwt.sign({ id: String(u._id) }, JWT_SECRET, { expiresIn: "7d" });
    const meWith = (token) => req("/api/users/me", { headers: { Authorization: "Bearer " + token } });

    const me1 = await meWith(T1);
    check(me1.status === 200, "token minted after the password change works (GET /users/me)", me1.status);

    await sleep(1100);
    u.password = "NewPass#123";
    await u.save();
    const bumped = new Date(u.pwdChangedAt).getTime() > pwdAt0;
    check(bumped, "changing the password bumps pwdChangedAt");

    const me2 = await meWith(T1);
    check(me2.status === 401 && me2.json && me2.json.success === false,
        "pre-change token is REJECTED after the password change", me2.status);

    const login = (pw, extraHeaders) => req("/api/users/login", {
        method: "POST",
        headers: Object.assign({ "X-Request-Token": "1" }, extraHeaders || {}),
        body: { email: u.email, password: pw },
    });
    const lNew = await login("NewPass#123");
    check(lNew.status === 200 && typeof lNew.json.token === "string",
        "login with the NEW password issues a fresh token", lNew.status);
    const T2 = lNew.json && lNew.json.token;
    const me3 = await meWith(T2);
    check(me3.status === 200, "fresh token works", me3.status);

    const lOld = await login("OldPass#123");
    check(lOld.status === 400, "login with the OLD password is refused", lOld.status);

    const track = await req("/api/orders/track/FM-20260101-ABC123", { headers: { Authorization: "Bearer " + T1 } });
    check(track.status === 404 && track.status !== 401,
        "optionalProtect tolerates a stale token (treated anonymous, not 401)", track.status);

    const upd = await req("/api/users/me", {
        method: "PUT",
        headers: { Authorization: "Bearer " + T2 },
        body: { name: "Pin Renamed" },
    });
    check(upd.status === 200, "non-password profile update with the fresh token works", upd.status);
    const me4 = await meWith(T2);
    check(me4.status === 200, "session survives a non-password save", me4.status);

    try { await mongoose.connection.dropDatabase(); } catch (e) { /* ignore */ }
    await mongoose.disconnect();
    server.close();

    console.log("");
    console.log("=== PART 16 RESULT: " + passed + " passed, " + failed + " failed ===");
    if (failures.length) {
        console.log("failures:");
        failures.forEach(function (f) { console.log("  - " + f); });
        process.exit(1);
    }
    process.exit(0);
}

main().catch(function (err) {
    console.error("FATAL: " + ((err && err.stack) || err));
    try { mongoose.disconnect(); } catch (e) {}
    process.exit(1);
});