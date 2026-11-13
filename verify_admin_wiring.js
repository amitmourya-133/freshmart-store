// ===============================
// STATIC WIRING GUARD (regression test)
// ===============================
// Catches the class of bug that stopped the admin product grid from rendering:
// admin.html loads api.js, script.js (deferred), chromeNotifications.js,
// notifications.js, admin.js and admin-partners.js. They all share ONE global
// scope, so a duplicate top-level declaration in a bundle that runs later
// silently overwrites the earlier one (deferred script.js used to overwrite
// admin.js's renderProducts()).
//
// Also verifies that every data-act handler referenced by admin.html resolves
// to a real global, so a renamed function cannot leave a dead button behind.
//
// Pure static analysis: reads files, never connects to a database or the
// network, never writes anything. Run directly (`node verify_admin_wiring.js`)
// or via `npm run test:admin`, which invokes it before the DB work.
// ===============================

"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PAGE = "admin.html";

// Pseudo-actions implemented by the delegated dispatcher in api.js.
const BUILTIN_PREFIX = "$";

function scriptBundles(html) {
    const srcs = [];
    const re = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
        const src = m[1].trim();
        if (!src || /^(https?:)?\/\//i.test(src) || src.startsWith("data:")) continue;
        const local = src.replace(/^\.?\//, "").split("?")[0];
        if (fs.existsSync(path.join(ROOT, local))) srcs.push(local);
    }
    return srcs;
}

function globalsOf(file) {
    const text = fs.readFileSync(path.join(ROOT, file), "utf8");
    const declared = new Set(); // function / var-level declaration: CLASHES are real bugs
    const assigned = new Set(); // window.fn = ... : deliberate wrapper, does not clash

    for (const m of text.matchAll(/^function\s+([A-Za-z_$][\w$]*)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/^(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\([^)]*\)\s*=>)/gm)) declared.add(m[1]);
    for (const m of text.matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) assigned.add(m[1]);
    return { declared, assigned };
}

function handlerNames(html) {
    const names = new Set();
    const legacy = [];
    for (const m of html.matchAll(/data-act\s*=\s*["']([^"']*)["']/g)) {
        const raw = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
        if (!raw.trim()) continue;
        if (raw.trim().startsWith("[")) {
            try {
                const plan = JSON.parse(raw);
                (Array.isArray(plan) ? plan : [plan]).forEach((step) => {
                    if (Array.isArray(step) && typeof step[0] === "string") names.add(step[0]);
                });
            } catch (e) {
                legacy.push("unparsable data-act: " + raw.slice(0, 60));
            }
        } else {
            const fn = raw.trim().match(/^([A-Za-z_$][\w$]*)/);
            if (fn) names.add(fn[1]);
        }
    }
    return { names, legacy };
}

function run() {
    const results = [];
    const check = (label, ok, detail) => {
        results.push({ label, ok, detail: detail || "" });
        console.log((ok ? "[PASS] " : "[FAIL] ") + label + (detail ? " :: " + detail : ""));
    };

    const html = fs.readFileSync(path.join(ROOT, PAGE), "utf8");
    const bundles = scriptBundles(html);
    check("admin.html bundles resolved", bundles.length > 0, bundles.join(", "));

    const declared = {};
    const assigned = {};
    for (const b of bundles) {
        const g = globalsOf(b);
        declared[b] = g.declared;
        assigned[b] = g.assigned;
    }

    // Load order matters: the LAST declaration of a name wins at runtime.
    const owners = {};
    for (const b of bundles) {
        for (const n of declared[b]) (owners[n] = owners[n] || []).push(b);
    }
    const collisions = Object.keys(owners).filter((n) => owners[n].length > 1);
    check("No duplicate global declaration across admin.html bundles", collisions.length === 0,
        collisions.slice(0, 8).map((n) => n + " <- " + owners[n].join(" + ")).join("; "));

    // A later bundle may wrap an earlier global (window.fn = ...), but the
    // wrapper must run AFTER the declaration, never a redeclaration.
    const clobbered = Object.keys(owners).filter((n) =>
        bundles.some((b) => declared[b].has(n) && assigned[n] && bundles.indexOf(b) > bundles.indexOf(assigned[n])));
    check("Window wrappers do not clobber declarations", clobbered.length === 0, clobbered.join(", "));

    const adminGlobals = declared["admin.js"] || new Set();
    check("admin.js declares admin renderers", adminGlobals.has("renderAdminProducts"),
        "renderAdminProducts=" + adminGlobals.has("renderAdminProducts"));

    // The storefront renderer must stay out of admin.js and vice versa.
    const storefront = declared["script.js"] || new Set();
    const sharedRender = ["renderProducts", "renderCustomers"]
        .filter((n) => adminGlobals.has(n) && storefront.has(n));
    check("Storefront/admin renderers are not shared", sharedRender.length === 0,
        sharedRender.join(", "));

    const { names, legacy } = handlerNames(html);
    const known = new Set();
    for (const b of bundles) {
        [declared[b], assigned[b]].forEach((set) => set.forEach((n) => known.add(n)));
    }
    const unresolved = [...names].filter((n) => !n.startsWith(BUILTIN_PREFIX) && !known.has(n));
    check("All data-act handlers resolve to a global", unresolved.length === 0 && legacy.length === 0,
        (unresolved.length ? "unresolved: " + unresolved.join(", ") : "") +
        (legacy.length ? " " + legacy.join("; ") : ""));

    const inline = [...html.matchAll(/\son(?:click|error|load|change|submit|input|mouseover)\s*=/gi)];
    check("No inline event handlers in admin.html", inline.length === 0, inline.length + " found");

    const failed = results.filter((r) => !r.ok);
    console.log("\nWIRING GUARD: " + (results.length - failed.length) + "/" + results.length +
        " PASS, " + failed.length + " FAIL");
    if (failed.length) {
        const err = new Error("admin wiring guard failed: " + failed.map((f) => f.label).join("; "));
        err.wiringFailures = failed;
        throw err;
    }
    return results;
}

module.exports = run;

if (require.main === module) {
    try {
        run();
    } catch (e) {
        console.error(e.message);
        process.exit(1);
    }
}
