// ===============================
// RUNNER for the admin + customer authenticated suite (testAdmin.js)
//
// testAdmin.js needs three things that it cannot provide for itself:
//   1. an isolated database (never production),
//   2. a running server on a known port,
//   3. a real OTP email, which requires the SMTP sink to be listening
//      BEFORE the server boots, because utils/emailService.js builds its
//      Nodemailer transport from SMTP_HOST/SMTP_PORT at startup.
//
// So the order here is deliberate: database -> SMTP sink -> server -> tests.
// Cleanup runs on success, on failure and on interrupt.
//
// Usage:  npm run test:admin
// ===============================

"use strict";

require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const { spawn, spawnSync } = require("child_process");
const dbGuard = require("./utils/dbGuard");
const { startSmtpSink } = require("./smtpSink");

const TEST_DB = "fm_testadmin_e2e_" + process.pid;
const BASE_URI = process.env.MONGODB_URI || "";
const ADMIN_EMAIL = "testadmin-" + process.pid + "@freshmart.invalid";
const ADMIN_PASSWORD = "TestAdmin-" + process.pid + "-a1";
const SERVE_PORT = 5000;

function isolatedUriFor(name) {
    return BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + name + "$2");
}

// Refuse to continue if this somehow resolved to production.
const TEST_URI = isolatedUriFor(TEST_DB);
dbGuard.assertSafeDbUri(TEST_URI, { purpose: "run_test_admin" });
if (!/^fm_.*_e2e_\d+$/.test(TEST_DB)) {
    console.error("FATAL: refusing to run, unexpected test database name");
    process.exit(1);
}

function run(script, env) {
    const r = spawnSync(process.execPath, [path.join(__dirname, script)], {
        env: env, encoding: "utf8", cwd: __dirname
    });
    if (r.status !== 0) {
        const out = ((r.stdout || "") + (r.stderr || "")).split("\n").slice(-8).join("\n");
        console.error("  " + script + " failed (exit " + r.status + "):\n" + out);
    }
    return r.status;
}

function waitForHealth(port, tries) {
    return new Promise(function (resolve) {
        let left = tries || 50;
        (function attempt() {
            const req = http.get({ host: "127.0.0.1", port: port, path: "/api/health", timeout: 1500 }, function (res) {
                res.resume();
                resolve(res.statusCode);
            });
            req.on("error", function () { if (left-- <= 0) resolve(null); else setTimeout(attempt, 700); });
            req.on("timeout", function () { req.destroy(); if (left-- <= 0) resolve(null); else setTimeout(attempt, 700); });
        })();
    });
}

function dropIsolated(uri) {
    // dbGuard re-approves the URI immediately before the destructive step.
    dbGuard.assertSafeDbUri(uri, { purpose: "run_test_admin_cleanup" });
    return spawnSync(process.execPath, ["-e", [
        "const m=require(" + JSON.stringify(path.join(__dirname, "node_modules", "mongoose")) + ");",
        "(async()=>{await m.connect(process.env.CLEAN_URI);",
        "await m.connection.dropDatabase();await m.disconnect();",
        "console.log('  dropped isolated test DB');",
        "})().catch(e=>{console.error('  cleanup error: '+e.message);process.exit(1);});"
    ].join("")], {
        env: Object.assign({}, process.env, { CLEAN_URI: uri }),
        encoding: "utf8", cwd: __dirname
    });
}

(async function main() {
    let sink = null;
    let server = null;
    let interrupted = false;

    const cleanup = async function () {
        if (server) { try { server.kill(); } catch (e) {} server = null; }
        if (sink) {
            try { await sink.close(); } catch (e) {}
            try { fs.rmSync(sink.dir, { recursive: true, force: true }); } catch (e) {}
            sink = null;
            console.log("  closed SMTP sink");
        }
        const d = dropIsolated(TEST_URI);
        if (d.stdout) console.log(d.stdout.trim());
    };

    process.on("SIGINT", function () { interrupted = true; });

    try {
        console.log("isolated test DB : " + dbGuard.classifyUri(TEST_URI).masked);
        console.log("admin under test : " + ADMIN_EMAIL + " (throwaway, isolated DB only)");

        sink = await startSmtpSink({ port: 0 });
        console.log("SMTP sink        : 127.0.0.1:" + sink.port + " (loopback only)");

        const childEnv = Object.assign({}, process.env, {
            MONGODB_URI: TEST_URI,
            PORT: String(SERVE_PORT),
            SMTP_HOST: "127.0.0.1",
            SMTP_PORT: String(sink.port),
            SMTP_SECURE: "false",
            ADMIN_EMAIL: ADMIN_EMAIL,
            ADMIN_PASSWORD: ADMIN_PASSWORD,
            NODE_ENV: "test"
        });

        console.log("\n--- seeding isolated fixtures ---");
        run("seed.js", childEnv);
        if (run("seedAdmin.js", childEnv) !== 0) throw new Error("seedAdmin.js failed");

        console.log("\n--- starting server with SMTP -> local sink ---");
        server = spawn(process.execPath, [path.join(__dirname, "server.js")], {
            env: childEnv, cwd: __dirname, stdio: ["ignore", "pipe", "pipe"]
        });
        let boot = "";
        server.stdout.on("data", function (d) { boot += d; });
        server.stderr.on("data", function (d) { boot += d; fullLog += d; });
        let fullLog = "";
        // re-attach with full capture
        server.stdout.removeAllListeners && server.stdout.removeAllListeners('data');
        server.stderr.removeAllListeners && server.stderr.removeAllListeners('data');
        server.stdout.on('data', function(d){ boot+=d; fullLog+=d; });
        server.stderr.on('data', function(d){ boot+=d; fullLog+=d; });

        const health = await waitForHealth(SERVE_PORT, 50);
        if (!health) {
            console.error("server did not come up:\n" + boot.replace(/mongodb\+srv:\/\/[^@\s]+@/g, "mongodb+srv://***@").slice(0, 1500));
            throw new Error("server health check failed");
        }
        console.log("server health    : HTTP " + health);

        console.log("\n--- running testAdmin.js ---");
        const testEnv = Object.assign({}, childEnv, {
            TEST_BASE_URL: "http://127.0.0.1:" + SERVE_PORT,
            SMTP_SINK_DIR: sink.dir
        });
        // Run the suite ASYNCHRONOUSLY. spawnSync would block THIS process's
        // event loop, which is exactly where the SMTP sink lives; the server's
        // OTP mail would then time out (ETIMEDOUT) and every signup would fail.
        const r = await new Promise(function (resolve) {
            const child = spawn(process.execPath, [path.join(__dirname, "testAdmin.js")], {
                env: testEnv, cwd: __dirname, stdio: ["ignore", "pipe", "pipe"]
            });
            child.stdout.on("data", function (d) { process.stdout.write(d); });
            child.stderr.on("data", function (d) { process.stderr.write(d); });
            child.on("exit", function (code) { resolve({ status: code }); });
            child.on("error", function () { resolve({ status: 1 }); });
        });

        // Diagnostics: how much mail the sink actually caught. Counts and file
        // names only - message bodies can contain OTPs and are never printed.
        console.log("\n--- SMTP sink captured " + sink.count() + " message(s) ---");
        try { console.log("  files: " + fs.readdirSync(sink.dir).join(", ")); } catch (e) {}

        if (r.status !== 0) {
            // Surface why, without leaking secrets or message bodies.
            console.log("\n--- server log (email/smtp/error lines) ---");
            boot.split("\n")
                .filter(function (l) { return /email|smtp|otp|err|fail|warn|user|signup|order/i.test(l); })
                .slice(0, 40)
                .forEach(function (l) {
                    console.log("  " + l.replace(/mongodb\+srv:\/\/[^@\s]+@/g, "mongodb+srv://***@").trim());
                });
            // also dump last 20 raw
            console.log("\n--- server log tail ---");
            fullLog.split("\n").filter(function(l){return l.trim();}).slice(-30).forEach(function(l){
                console.log("  "+l.replace(/mongodb\+srv:\/\/[^@\s]+@/g,"mongodb+srv://***@").trim());
            });
        }

        await cleanup();
        if (interrupted) process.exit(130);
        process.exit(r.status === 0 ? 0 : 1);
    } catch (err) {
        console.error("\nFATAL: " + err.message);
        await cleanup();
        process.exit(1);
    }
})();