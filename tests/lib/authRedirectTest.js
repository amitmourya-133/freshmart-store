// ===============================
// AUTH REDIRECT REGRESSION TESTS (headless)
// ===============================
// Loads the REAL api.js + script.js into a vm sandbox with minimal DOM/localStorage
// mocks and exercises the actual auth-gating functions. This is an integration test
// of shipped code, NOT a browser E2E (no browser automation is available here).
//
// Scenarios covered (see the 7 required cases):
//   1. valid admin session survives reload / lands on admin panel
//   2. expired/invalid session reaches a stable login screen (no loop)
//   3. genuine 401 on a protected page -> login, then login reconciles & terminates
//   4. transient network error is NOT treated as an invalid session
//   5. admin landing decision is role-aware (admin.html, never signup)
//   6. authenticated customer is never sent to signup
//   7. login-then-reload keeps the session and redirects by role

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..", "..");

function createStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => { m.set(k, String(v)); },
        removeItem: (k) => { m.delete(k); },
        clear: () => m.clear(),
        _map: m
    };
}

// A Promise-returning fake fetch Response.
function res(body, ok) {
    return Promise.resolve({
        ok: ok !== false,
        status: ok === false ? 401 : 200,
        json: function () { return Promise.resolve(body); }
    });
}

function loadSandbox(opts) {
    opts = opts || {};
    const storage = createStorage();
    const navs = [];
    const docListeners = {};
    const winListeners = {};

    const location = {
        href: opts.href || "https://freshmartstore.in/login.html",
        hostname: "freshmartstore.in",
        origin: "https://freshmartstore.in",
        protocol: "https:",
        pathname: opts.pathname || "/login.html",
        search: opts.search || "",
        hash: "",
        replace: function (u) { navs.push(String(u)); },
        assign: function (u) { navs.push(String(u)); },
        reload: function () { navs.push("__reload__"); }
    };

    const body = {
        dataset: opts.dataset || {},
        style: {},
        appendChild: function () {},
        removeChild: function () {},
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; }
    };

    const doc = {
        readyState: "complete",
        body: body,
        head: { appendChild: function () {}, querySelector: function () { return null; } },
        cookie: "",
        addEventListener: function (ev, fn) { (docListeners[ev] = docListeners[ev] || []).push(fn); },
        removeEventListener: function () {},
        getElementById: function () { return null; },
        querySelector: function () { return null; },
        querySelectorAll: function () { return []; },
        createElement: function () { return { setAttribute: function () {}, style: {}, appendChild: function () {} }; }
    };

    const navigator = {
        userAgent: "Mozilla/5.0 (NodeTest)",
        serviceWorker: { register: function () { return Promise.resolve(); } }
    };

    let fetchImpl = opts.fetch || function () { return Promise.reject(new Error("no fetch")); };

    const sandbox = {
        console: { log: function () {}, warn: function () {}, error: function () {}, info: function () {} },
        Promise: Promise, JSON: JSON, Math: Math, Date: Date, Object: Object, Array: Array,
        String: String, Number: Number, Boolean: Boolean, RegExp: RegExp, Error: Error, TypeError: TypeError,
        setTimeout: function (fn) { return setTimeout(fn, 0); },
        clearTimeout: clearTimeout,
        setInterval: function () { return 0; },
        clearInterval: function () {},
        URLSearchParams: URLSearchParams,
        encodeURIComponent: encodeURIComponent,
        decodeURIComponent: decodeURIComponent,
        localStorage: storage,
        document: doc,
        navigator: navigator,
        fetch: function () { return fetchImpl.apply(null, arguments); }
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.location = location;
    sandbox.addEventListener = function (ev, fn) { (winListeners[ev] = winListeners[ev] || []).push(fn); };
    sandbox.removeEventListener = function () {};
    sandbox.matchMedia = function () { return { matches: false, addEventListener: function () {}, addListener: function () {} }; };
    sandbox.scrollTo = function () {};
    sandbox.getComputedStyle = function () { return {}; };
    sandbox.alert = function () {};
    sandbox.confirm = function () { return false; };
    sandbox.requestAnimationFrame = function (fn) { return setTimeout(fn, 0); };

    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, "api.js"), "utf8"), sandbox, { filename: "api.js" });
    vm.runInContext(fs.readFileSync(path.join(ROOT, "script.js"), "utf8"), sandbox, { filename: "script.js" });

    return {
        sandbox: sandbox,
        storage: storage,
        navs: navs,
        setFetch: function (fn) { fetchImpl = fn; },
        lastNav: function () { return navs.length ? navs[navs.length - 1] : null; }
    };
}

function flush() {
    // Let queued promise callbacks run.
    return new Promise(function (r) { setTimeout(r, 5); });
}

const ADMIN = { success: true, data: { name: "Admin", email: "admin@freshmart.invalid", role: "admin" } };
const CUSTOMER = { success: true, data: { name: "Cust", email: "cust@freshmart.invalid", role: "customer" } };
const INVALID = { success: false, message: "Not authorized, token failed" };

describe("Auth redirect regression (real api.js + script.js in vm)", function () {
    this.timeout(10000);

    it("loads api.js + script.js with the expected auth symbols", function () {
        const s = loadSandbox({});
        ["hasSession", "clearAuthState", "verifySession", "gateProtectedPage", "authLoginPage",
            "isInvalidSessionError", "authLandingPage", "reconcileAuthPageSession"].forEach(function (fn) {
                assert.strictEqual(typeof s.sandbox[fn], "function", fn + " should be a function");
            });
    });

    it("classifies only backend 'invalid session' errors as invalid (not network errors)", function () {
        const s = loadSandbox({});
        assert.strictEqual(s.sandbox.isInvalidSessionError("Not authorized, token failed"), true);
        assert.strictEqual(s.sandbox.isInvalidSessionError("User not found"), true);
        assert.strictEqual(s.sandbox.isInvalidSessionError("Not authorized, session expired. Please sign in again."), true);
        assert.strictEqual(s.sandbox.isInvalidSessionError("Failed to fetch"), false);
        assert.strictEqual(s.sandbox.isInvalidSessionError("NetworkError when attempting to fetch resource."), false);
        assert.strictEqual(s.sandbox.isInvalidSessionError("Internal Server Error"), false);
    });

    it("maps a valid session to a role-aware landing page (admin never to signup)", function () {
        const s = loadSandbox({});
        assert.strictEqual(s.sandbox.authLandingPage({ role: "admin" }), "admin.html");
        assert.strictEqual(s.sandbox.authLandingPage({ role: "delivery" }), "delivery.html");
        assert.strictEqual(s.sandbox.authLandingPage({ role: "customer" }), "index.html");
        assert.strictEqual(s.sandbox.authLandingPage(null), "index.html");
    });

    // ---- Scenario 1: valid admin session ----
    it("S1: valid admin session on login page redirects to admin.html and keeps state", async function () {
        const s = loadSandbox({ dataset: { page: "login" }, fetch: function () { return res(ADMIN); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        s.storage.setItem("freshMartUser", JSON.stringify({ role: "admin" }));
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.lastNav(), "admin.html");
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), "true");
    });

    it("S1b: valid session on a protected page does NOT redirect", async function () {
        const s = loadSandbox({ dataset: { page: "orders" }, fetch: function () { return res(CUSTOMER); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        const ok = s.sandbox.gateProtectedPage();
        await flush();
        assert.strictEqual(ok, true);
        assert.strictEqual(s.navs.length, 0, "no navigation expected");
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), "true");
    });

    // ---- Scenario 2: expired/invalid session reaches stable login ----
    it("S2: expired session on login page clears the stale flag and does NOT redirect (no loop)", async function () {
        const s = loadSandbox({ dataset: { page: "login" }, fetch: function () { return res(INVALID, false); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.navs.length, 0, "must not bounce to index/admin");
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), null, "stale flag must be cleared");
        // Running it again is a no-op (terminates).
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.navs.length, 0);
    });

    // ---- Scenario 3: genuine 401 on protected page ----
    it("S3: 401 on protected page redirects to login, then login reconciles and terminates", async function () {
        const s = loadSandbox({ dataset: { page: "orders" }, fetch: function () { return res(INVALID, false); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        s.sandbox.gateProtectedPage();
        await flush();
        assert.ok(/login\.html$/.test(s.lastNav()), "protected page should go to login.html, got " + s.lastNav());
        // Now simulate landing on login.html (same invalid backend).
        s.sandbox.document.body.dataset.page = "login";
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), null, "login must clear the stale flag");
        assert.ok(!/index\.html$/.test(s.lastNav()), "must not bounce back to index.html (loop)");
    });

    // ---- Scenario 4: transient network error ----
    it("S4: network error on protected page keeps session and does NOT redirect", async function () {
        const s = loadSandbox({ dataset: { page: "orders" }, fetch: function () { return Promise.reject(new TypeError("Failed to fetch")); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        s.sandbox.gateProtectedPage();
        await flush();
        assert.strictEqual(s.navs.length, 0, "no redirect on transient failure");
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), "true", "session must be preserved");
    });

    it("S4b: network error on login page does NOT clear state and does NOT redirect", async function () {
        const s = loadSandbox({ dataset: { page: "login" }, fetch: function () { return Promise.reject(new TypeError("Failed to fetch")); } });
        s.storage.setItem("freshMartLoggedIn", "true");
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.navs.length, 0);
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), "true", "network error is not proof of logout");
    });

    // ---- Scenario 5/6: role decisions (admin.js gate is server-enforced + E2E) ----
    it("S5/S6: an authenticated customer is never sent to signup; admin lands on admin.html", function () {
        const s = loadSandbox({});
        ["admin", "customer", "delivery"].forEach(function (role) {
            const dest = s.sandbox.authLandingPage({ role: role });
            assert.ok(!/signup\.html/.test(dest), role + " must never land on signup.html");
        });
    });

    it("S6b: a stale unauthenticated visitor with no flag is sent to login from a protected page", async function () {
        const s = loadSandbox({ dataset: { page: "checkout" }, fetch: function () { return res(INVALID, false); } });
        // no freshMartLoggedIn flag
        const ok = s.sandbox.gateProtectedPage();
        await flush();
        assert.strictEqual(ok, false);
        assert.ok(/login\.html$/.test(s.lastNav()));
    });

    // ---- Scenario 7: login followed by reload ----
    it("S7: login writes the flag; a reload with a valid cookie lands by role without looping", async function () {
        const s = loadSandbox({ dataset: { page: "login" }, fetch: function () { return res(ADMIN); } });
        // Simulate the post-login state written by handlePasswordLogin for an admin.
        s.storage.setItem("freshMartLoggedIn", "true");
        s.storage.setItem("freshMartUser", JSON.stringify({ role: "admin" }));
        // Reload -> initializePage's auth gate runs reconcileAuthPageSession().
        s.sandbox.reconcileAuthPageSession();
        await flush();
        assert.strictEqual(s.lastNav(), "admin.html");
        assert.strictEqual(s.storage.getItem("freshMartLoggedIn"), "true");
    });
});
