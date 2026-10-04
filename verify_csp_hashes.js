// CSP hash guard (PATH A follow-up).
//
// The inline-handler migration replaced every on* attribute with a data-act hook
// resolved by the shared dispatcher in api.js, which let script-src drop
// 'unsafe-inline'. Three executable inline <script> blocks legitimately remain
// (delivery / profile / signup) and are allow-listed by SHA-256 digest.
//
// That allow-list is the fragile part: editing any of those blocks changes its
// digest and the page silently stops bootstrapping in production, because a CSP
// hash miss is a block, not a visible build error. This suite is the permanent
// guard. It needs no database, no secrets and no network, so it is safe to run
// on every push and pull request.
//
// Fails (non-zero exit) when:
//   1. an executable inline script is missing from script-src;
//   2. an allowed digest does not match the bytes actually served;
//   3. an unexpected executable inline script appears (stale allow-list);
//   4. script-src contains 'unsafe-inline';
//   5. script-src contains 'unsafe-eval'.
// JSON-LD blocks are inert data, not executable, and are ignored.
// style-src keeps its own 'unsafe-inline' on purpose - it is out of scope here.
//
// Usage: node verify_csp_hashes.js

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REPO = __dirname;

let pass = 0;
let fail = 0;

function check(name, cond, extra) {
    if (cond) { pass++; console.log("  [PASS] " + name); }
    else { fail++; console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + String(extra).slice(0, 300) : "")); }
    return !!cond;
}

function readOrFatal(file) {
    const p = path.join(REPO, file);
    if (!fs.existsSync(p)) {
        console.error("FATAL: " + file + " not found in " + REPO);
        process.exit(1);
    }
    return fs.readFileSync(p, "utf8");
}

// --- collect every executable inline script, by digest ---------------------
// A <script> with a src, or a non-executable type such as JSON-LD, is skipped.
function collectInlineScripts() {
    const found = [];
    const htmlFiles = fs.readdirSync(REPO).filter((f) => f.endsWith(".html"));
    for (const file of htmlFiles) {
        const src = fs.readFileSync(path.join(REPO, file), "utf8");
        const re = /<script(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script>/gi;
        let m;
        while ((m = re.exec(src))) {
            const attrs = m[1] || "";
            const type = (attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
            const isData = /ld\+json|application\/(?!javascript|ecmascript)/i.test(type) ||
                /\btype\s*=\s*["']?(importmap|application\/json)/i.test(type);
            const digest = crypto.createHash("sha256").update(m[2], "utf8").digest("base64");
            found.push({ file: file, type: type || "classic", executable: !isData, digest: digest, bytes: m[2].length });
        }
    }
    return found;
}

// --- pull the two shipped policies -----------------------------------------
function policyFromAppJs(src) {
    const m = src.match(/const CSP\s*=\s*"([^"]+)"/);
    return m ? m[1] : null;
}

function policyFromVercel(src) {
    const m = src.match(/"Content-Security-Policy":\s*"([^"]+)"/);
    return m ? m[1] : null;
}

function scriptSrcOf(policy) {
    const m = String(policy).match(/script-src([^;]*)/);
    return m ? m[1] : "";
}

function digestsIn(scriptSrc) {
    return (String(scriptSrc).match(/'sha256-[A-Za-z0-9+/=]+'/g) || []).map((h) => h.replace(/'/g, ""));
}

function main() {
    console.log("=== CSP hash guard ===\n");

    const appJs = readOrFatal("app.js");
    const vercelJson = readOrFatal("vercel.json");

    // A1. policies exist and are readable
    const appPolicy = policyFromAppJs(appJs);
    const vercelPolicy = policyFromVercel(vercelJson);
    check("app.js exposes a CSP string", !!appPolicy);
    check("vercel.json ships a Content-Security-Policy header", !!vercelPolicy);
    if (!appPolicy || !vercelPolicy) { finish(); return; }

    // A2. the two policies cannot drift apart
    check("app.js and vercel.json policies are byte-identical", appPolicy === vercelPolicy,
        appPolicy === vercelPolicy ? "" : "app.js != vercel.json");

    const scriptSrc = scriptSrcOf(appPolicy);
    check("policy declares script-src", !!scriptSrc);

    const allowed = digestsIn(scriptSrc);
    const inline = collectInlineScripts();
    const executable = inline.filter((s) => s.executable);
    const inert = inline.filter((s) => !s.executable);

    console.log("\n  executable inline scripts: " + executable.length +
        "   inert (JSON-LD etc): " + inert.length +
        "   digests allowed by script-src: " + allowed.length + "\n");

    executable.forEach((s) => console.log("    " + s.file + "  " + s.bytes + "B  sha256-" + s.digest));

    // A3. an unexpected executable inline script must fail, or the allow-list
    //     silently rots the next time somebody adds a block.
    executable.forEach((s) => {
        check("executable script in " + s.file + " is allow-listed",
            allowed.indexOf("sha256-" + s.digest) !== -1,
            "no sha256-" + s.digest + " in script-src");
    });

    // A4. every allowed digest still matches real content (stale allow-list).
    const liveDigests = executable.map((s) => "sha256-" + s.digest);
    allowed.forEach((d) => {
        check("allowed digest is not stale: " + d.slice(0, 23) + "...",
            liveDigests.indexOf(d) !== -1,
            "no inline script currently hashes to this");
    });

    // A5. exact arity: extra digests are dead allow-list entries, missing ones
    //     are pages that will fail to bootstrap.
    check("script-src digest count matches executable script count",
        allowed.length === executable.length,
        "script-src has " + allowed.length + ", HTML has " + executable.length);

    // A6. 'unsafe-inline' must never come back to script-src.
    check("script-src does NOT contain 'unsafe-inline'", !/'unsafe-inline'/.test(scriptSrc),
        scriptSrc.trim());

    // A7. 'unsafe-eval' must never be introduced.
    check("script-src does NOT contain 'unsafe-eval'", !/unsafe-eval/.test(scriptSrc),
        scriptSrc.trim());

    // A8. 'unsafe-hashes' would re-open inline handlers; keep it out too.
    check("script-src does NOT contain 'unsafe-hashes'", !/unsafe-hashes/.test(scriptSrc),
        scriptSrc.trim());

    // A9. style-src intentionally keeps 'unsafe-inline' - assert that is still
    //     deliberate rather than accidental, so a future change is conscious.
    const styleSrc = (appPolicy.match(/style-src([^;]*)/) || [])[1] || "";
    console.log("\n  note: style-src " + (/unsafe-inline/.test(styleSrc)
        ? "keeps 'unsafe-inline' (intentional, out of scope)"
        : "no longer has 'unsafe-inline'") + "\n");

    finish();
}

function finish() {
    console.log("\nRESULT: " + pass + "/" + (pass + fail) + " PASS, " + fail + " FAIL");
    process.exit(fail ? 1 : 0);
}

try {
    main();
} catch (e) {
    console.error("SUITE ERROR:", e && e.stack ? e.stack : e);
    process.exit(1);
}