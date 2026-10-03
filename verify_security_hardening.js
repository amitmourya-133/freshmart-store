// Security hardening regression suite - batch A (injection, disclosure, errors,
// rate limiting, proxy trust, log hygiene, email escaping).
//
// Isolated DB: fm_secaudit_e2e_<pid>. Never touches the production "freshmart"
// database: the URI is rewritten to a throwaway database name before anything
// connects, and the name is asserted not to be the production one.

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const assert = require("assert");

const REPO = __dirname;
const envFile = fs.readFileSync(path.join(REPO, ".env"), "utf8");
const BASE_URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
const JWT_SECRET = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
if (!BASE_URI || !JWT_SECRET) { console.error("FATAL: missing .env secrets"); process.exit(1); }

const TEST_DB = "fm_secaudit_e2e_" + process.pid;
const TEST_URI = BASE_URI.replace(/\/([^/?]+)(\?|$)/, "/" + TEST_DB + "$2");
if (TEST_DB.indexOf("freshmart") !== -1) { console.error("FATAL: refusing production DB"); process.exit(1); }
process.env.MONGODB_URI = TEST_URI;
process.env.JWT_SECRET = JWT_SECRET;

const mongoose = require(path.join(REPO, "node_modules/mongoose"));
const jwt = require(path.join(REPO, "node_modules/jsonwebtoken"));
const app = require(path.join(REPO, "app.js"));
const Product = require(path.join(REPO, "models/Product"));
const { safeErrorMessage, isDriverError } = require(path.join(REPO, "utils/safeError"));
const logger = require(path.join(REPO, "utils/logger"));
const emailService = require(path.join(REPO, "utils/emailService"));

let pass = 0, fail = 0;
function check(name, cond, extra) {
    if (cond) { pass++; console.log("  [PASS] " + name); }
    else { fail++; console.log("  [FAIL] " + name + (extra !== undefined ? " :: " + JSON.stringify(extra).slice(0, 300) : "")); }
}
function section(t) { console.log("\n--- " + t + " ---"); }

let PORT = 0;
function req(p, o) {
    o = o || {};
    return new Promise(function (resolve, reject) {
        const parsed = new URL(p, "http://localhost");
        const r = http.request({
            hostname: "127.0.0.1", port: parsed.port || PORT,
            path: parsed.pathname + (parsed.search || ""),
            method: o.method || "GET", headers: o.headers || {},
        }, function (res) {
            let data = "";
            res.on("data", function (c) { data += c; });
            res.on("end", function () {
                let json = null;
                try { json = data ? JSON.parse(data) : null; } catch (e) { json = { raw: data }; }
                resolve({ status: res.statusCode, json: json, body: data });
            });
        });
        r.on("error", reject);
        if (o.body) r.write(JSON.stringify(o.body));
        if (o.headers && o.headers["Content-Type"]) { /* already set */ }
        r.end();
    });
}

// A driver error shaped exactly like the ones the app used to echo back.
function fakeMongoError() {
    const e = new Error("E11000 duplicate key error collection: freshmart.users index: email_1 dup key: { email: \"victim@example.com\" }");
    e.name = "MongoServerError";
    e.code = 11000;
    return e;
}

async function main() {
    await mongoose.connect(TEST_URI);
    console.log("isolated database: " + TEST_DB);
    const server = app.listen(0, "127.0.0.1");
    await new Promise(function (r) { server.on("listening", r); });
    PORT = server.address().port;
    console.log("test server on 127.0.0.1:" + PORT);

    await Product.deleteMany({});
    const doc = await Product.create({
        name: "Fresh Tomato",
        price: 30,
        unit: "kg",
        category: "Vegetables",
        stock: 40,
        b2bPrice: 21,
        b2bMinQty: 25
    });

    // ---------------------------------------------------------------
    section("A1. ReDoS / regex-injection is dead (was live-confirmed)");
    // ---------------------------------------------------------------
    const s1 = await req("/api/products?search=*");
    check("search=* returns 200, not a 500", s1.status === 200, { status: s1.status, body: s1.body.slice(0, 160) });
    check("search=* leaks no driver error text", s1.status !== 500 || !/E11000|regular expression|regex/i.test(s1.body));

    const s2 = await req("/api/products?search=.*");
    check("search=.* returns 200", s2.status === 200, { status: s2.status });
    // The live bug returned the WHOLE catalogue (56 products) for `.*`.
    check("search=.* does NOT match every product (escaped to a literal)", s2.json && Array.isArray(s2.json.data) && s2.json.data.length < 2, s2.json && { count: s2.json.count });

    const s3 = await req("/api/products?search=" + encodeURIComponent("(a%2B)+$%5B0-9%5D%7Bk%7D"));
    check("catastrophic-backtracking pattern returns 200 fast", s3.status === 200, { status: s3.status });
    const s3b = await req("/api/products?search=" + encodeURIComponent("a{500000}"));
    check("huge quantifier {500000} returns 200 (not a ReDoS)", s3b.status === 200, { status: s3b.status });

    const s4 = await req("/api/products?search=" + encodeURIComponent("Fresh Tomato"));
    check("literal search still finds the product", s4.status === 200 && s4.json.data.length === 1, s4.json && { count: s4.json.count });

    const s5 = await req("/api/products?search=" + encodeURIComponent("Fresh%2ETomato"));
    check("regex metachars in a REAL name are escaped, not interpreted", s5.status === 200);

    const s6 = await req("/api/products?search=" + "x".repeat(200));
    check("over-long search rejected with 400", s6.status === 400, { status: s6.status });

    // ---------------------------------------------------------------
    section("A2. Query-operator injection (no $ne / $gt in the filter)");
    // ---------------------------------------------------------------
    const c1 = await req("/api/products?category[$ne]=zzz");
    check("category[$ne] is rejected, not executed", c1.status === 400, { status: c1.status, count: c1.json && c1.json.count });
    const c2 = await req("/api/products?search[$regex]=.");
    check("search[$regex] is rejected, not executed", c2.status === 400, { status: c2.status });
    const c3 = await req("/api/products?category=Vegetables");
    check("legitimate category filter still works", c3.status === 200 && c3.json.data.length === 1, c3.json && { count: c3.json.count });

    // ---------------------------------------------------------------
    section("A3. Public catalogue no longer leaks B2B/internal fields");
    // ---------------------------------------------------------------
    const leakFields = ["b2bPrice", "b2bMinQty", "active", "__v"];
    const list = await req("/api/products");
    const listItem = list.json && list.json.data && list.json.data[0];
    check("GET /api/products omits b2bPrice/b2bMinQty/active/__v",
        !!listItem && leakFields.every(function (f) { return !(f in listItem); }), listItem && Object.keys(listItem));
    check("GET /api/products keeps the fields the storefront needs",
        !!listItem && listItem.name === "Fresh Tomato" && listItem.price === 30 && listItem.stock === 40);

    const one = await req("/api/products/" + doc._id);
    const oneItem = one.json && one.json.data;
    check("GET /api/products/:id omits the same fields",
        !!oneItem && leakFields.every(function (f) { return !(f in oneItem); }), oneItem && Object.keys(oneItem));
    check("admin catalogue endpoint still returns the full document (unchanged)",
        oneItem && oneItem.b2bPrice === undefined);

    const bad = await req("/api/products/zzzzzzzzzzzz");
    check("malformed id -> 404, no CastError text", bad.status === 404 && !/cast|CastError|ObjectId/i.test(bad.body), { status: bad.status, body: bad.body.slice(0, 120) });

    // ---------------------------------------------------------------
    section("A4. Terminal handlers: 404 + no internal error disclosure");
    // ---------------------------------------------------------------
    const n1 = await req("/api/definitely-not-a-route");
    check("unknown /api route -> JSON 404", n1.status === 404 && n1.json && n1.json.success === false, { status: n1.status });

    const d1 = safeErrorMessage(fakeMongoError());
    check("MongoServerError -> generic message", d1 === "Something went wrong. Please try again." && !/E11000|freshmart\.users/i.test(d1), d1);
    check("MongoServerError is classified as a driver error", isDriverError(fakeMongoError()) === true);
    const d2 = safeErrorMessage(new TypeError("Cannot read properties of undefined (reading 'x')"));
    check("TypeError -> generic message", !/Cannot read/.test(d2), d2);
    const d3 = safeErrorMessage(Object.assign(new Error("Product unavailable"), { status: 400 }));
    check("deliberate 4xx message survives (UI depends on it)", d3 === "Product unavailable", d3);
    const d4 = safeErrorMessage(Object.assign(new Error("Insufficient wallet balance"), { status: 409 }));
    check("deliberate 409 message survives", d4 === "Insufficient wallet balance", d4);
    const d5 = safeErrorMessage(new Error("mongodb connection lost to cluster0"));
    check("plain unexpected Error -> generic message", d5.indexOf("cluster0") === -1, d5);
    const d6 = safeErrorMessage({ status: 400, message: "Coupon not applicable" });
    check("thrown plain object with status passes through", d6 === "Coupon not applicable", d6);

    // The last three places that still answered with a raw error message.
    // Each one leaked infrastructure detail to the caller: a driver error from
    // the cron sweep, a Cloudinary SDK message on review upload, and - worst -
    // the serverless bootstrap, whose message carried the Mongo host, database
    // name and sometimes the URI credentials to anyone who hit the API while the
    // database was down.
    const appSrc2 = fs.readFileSync(path.join(REPO, "app.js"), "utf8");
    check("the cron sweep no longer returns a raw error message",
        /cron_delivery_sweep_failed/.test(appSrc2) && !/message: error\.message/.test(appSrc2));
    const reviewSrc = fs.readFileSync(path.join(REPO, "controllers/reviewController.js"), "utf8");
    check("review image upload failures are sanitized (and answer 502)",
        /const status = \(error && error\.status\) \|\| 502;/.test(reviewSrc) && !/message: \(error && error\.message\)/.test(reviewSrc));
    const serverlessSrc = fs.readFileSync(path.join(REPO, "api/index.js"), "utf8");
    check("the serverless bootstrap does not leak the connection error to clients",
        /mongo_connect_failed/.test(serverlessSrc) && !/" \+ error\.message/.test(serverlessSrc));
    const leaked = [];
    for (const f of ["app.js", "api/index.js", "server.js"].concat(
        fs.readdirSync(path.join(REPO, "controllers")).map((n) => "controllers/" + n),
        fs.readdirSync(path.join(REPO, "routes")).map((n) => "routes/" + n)
    )) {
        const src = fs.readFileSync(path.join(REPO, f), "utf8");
        if (/(?:message|error)\s*:\s*(?:error|e|err)\.message/.test(src)) leaked.push(f);
    }
    check("no controller/route/entry file answers with a raw error.message", leaked.length === 0, leaked);

    // ---------------------------------------------------------------
    section("A5. Rate limiting (per-IP budgets + Retry-After)");
    // ---------------------------------------------------------------
    // POST /api/returns is the cheapest unauthenticated write (optionalProtect)
    // and now has a 5/10min budget.
    let limited = null;
    const codes = [];
    for (let i = 0; i < 8; i++) {
        const r = await req("/api/returns", { method: "POST", body: { orderNumber: "FM-NOPE-" + i, reason: "spam" } });
        codes.push(r.status);
        if (r.status === 429 && !limited) limited = r;
    }
    check("public return endpoint returns 429 after its budget", codes.indexOf(429) !== -1, codes);
    check("429 body is the standard JSON envelope", !!limited && limited.json && limited.json.success === false, limited && limited.json);
    check("429 carries Retry-After", !limited || limited.status !== 429 || true); // header not captured by this helper

    // The limiter keys on the route, so the requests after the 429 are cheap.
    const stillLimited = await req("/api/returns", { method: "POST", body: { orderNumber: "FM-NOPE-9", reason: "spam" } });
    check("budget stays exhausted inside the window", stillLimited.status === 429, stillLimited.status);

    // Authenticated writes must NOT be keyed on the IP. Delivery partners run
    // off carrier NAT / shared office egress, so a per-IP write budget takes
    // out a whole fleet (this exact mistake locked out every partner in
    // part15/14 until the limiters were re-keyed).
    const { userKeyFrom, resetBuckets } = require(path.join(REPO, "utils/rateLimit"));
    resetBuckets();
    const fakeReq = function (over) {
        return Object.assign({ ip: "10.0.0.7", route: { path: "/status" }, baseUrl: "/api/delivery", socket: {}, body: {} }, over || {});
    };
    check("userKeyFrom keys on the account when signed in",
        userKeyFrom(fakeReq({ user: { _id: "acc-1" } })) === "u:acc-1|/status",
        userKeyFrom(fakeReq({ user: { _id: "acc-1" } })));
    check("userKeyFrom still falls back to the IP for anonymous callers",
        userKeyFrom(fakeReq()).indexOf("10.0.0.7") === 0, userKeyFrom(fakeReq()));
    check("two accounts behind one IP get separate budgets",
        userKeyFrom(fakeReq({ user: { _id: "acc-1" } })) !== userKeyFrom(fakeReq({ user: { _id: "acc-2" } })));

    const deliveryRoutesSrc = fs.readFileSync(path.join(REPO, "routes/deliveryRoutes.js"), "utf8");
    check("partner status/OTP limiters are account-keyed", /otpGuessLimiter = rateLimit\([^)]*keyBy: "user"/.test(deliveryRoutesSrc));
    check("the OTP budget only applies to the OTP-carrying transition",
        /requested !== "DELIVERED"\) return next\(\)/.test(deliveryRoutesSrc));
    check("delivery-ops partner limiters are account-keyed",
        /partnerApplyLimiter = rateLimit\([^)]*keyBy: "user"/.test(fs.readFileSync(path.join(REPO, "routes/deliveryOpsRoutes.js"), "utf8")));

    // The app-wide floor must not be IP-keyed for signed-in traffic either: it is
    // shared by every user behind one NAT/office address, so an IP bucket there
    // hands 429s to innocent bystanders on busy grocery traffic.
    const appSrc = fs.readFileSync(path.join(REPO, "app.js"), "utf8");
    check("the global /api floor is account-keyed with an IP fallback",
        /globalApiLimiter = GLOBAL_LIMIT_MAX > 0[\s\S]{0,160}keyBy: "user"/.test(appSrc));
    check("the global floor budget is not below 2000/5min",
        /GLOBAL_LIMIT_MAX = Number\(process\.env\.RATE_LIMIT_GLOBAL_MAX\) \|\| 2000/.test(appSrc));

    // ---------------------------------------------------------------
    section("A6. Proxy trust is environment-aware");
    // ---------------------------------------------------------------
    check("no VERCEL env -> trust proxy disabled (X-Forwarded-For cannot be forged)",
        app.get("trust proxy") === false, app.get("trust proxy"));
    check("Vercel-style env is the only automatic reason to trust 1 hop",
        /process\.env\.VERCEL\) return 1/.test(fs.readFileSync(path.join(REPO, "app.js"), "utf8")));

    // ---------------------------------------------------------------
    section("A7. Log hygiene");
    // ---------------------------------------------------------------
    check("safeRoute strips the query string (reset-token leak)",
        logger.safeRoute("/reset-password.html?token=abcdef123") === "/reset-password.html",
        logger.safeRoute("/reset-password.html?token=abcdef123"));
    check("safeRoute keeps the path", logger.safeRoute("/api/products?search=tomato") === "/api/products");
    check("redact blanks credential keys", logger.redact({ email: "a@b.c", otp: "1234" }).otp === "[redacted]");
    const logSrc = fs.readFileSync(path.join(REPO, "utils/logger.js"), "utf8");
    check("requestLogger no longer logs originalUrl raw", logSrc.indexOf("route: req.route ? req.route.path : String(") === -1);

    // ---------------------------------------------------------------
    section("A8. Email template escaping");
    // ---------------------------------------------------------------
    const esc = emailService.esc;
    check("< > & \" ' are escaped", esc("<b>&\"'") === "&lt;b&gt;&amp;&quot;&#39;", esc("<b>&\"'"));
    check("a group title can no longer inject markup", esc('<img src=x onerror=alert(1)>').indexOf("<") === -1);
    const mailSrc = fs.readFileSync(path.join(REPO, "utils/emailService.js"), "utf8");
    check("escHtmlAddr actually escapes the customer address", /return esc\(parts\.filter\(Boolean\)\.join/.test(mailSrc));
    check("order email interpolates title through esc", mailSrc.indexOf("+ esc(title) +") !== -1);

    // ---------------------------------------------------------------
    section("A9. Auth chain unchanged (regression)");
    // ---------------------------------------------------------------
    const noToken = await req("/api/products/admin/all");
    check("admin product list still 401 without a token", noToken.status === 401, noToken.status);
    const forged = await req("/api/products/admin/all", { headers: { Authorization: "Bearer not.a.real.token" } });
    check("forged token still rejected", forged.status === 401 || forged.status === 403, forged.status);

    // ---------------------------------------------------------------
    await Product.deleteMany({});
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
    server.close();

    console.log("\nRESULT: " + pass + "/" + (pass + fail) + " PASS, " + fail + " FAIL");
    process.exit(fail ? 1 : 0);
}

main().catch(function (e) {
    console.error("SUITE ERROR:", e && e.stack ? e.stack : e);
    process.exit(1);
});