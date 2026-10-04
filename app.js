// ===============================
// FRESHMART - EXPRESS APP
// Builds the Express application (middleware + routes + static files)
// so it can be started locally (server.js) or as a Vercel serverless
// function (api/index.js) without duplicating the setup.
// ===============================

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const cookieParser = require("cookie-parser");
const { rateLimit } = require("./utils/rateLimit");
const { safeErrorMessage, safeErrorStatus, errorLogEntry } = require("./utils/safeError");
const logger = require("./utils/logger");

// Import routes
const productRoutes = require("./routes/productRoutes");
const orderRoutes = require("./routes/orderRoutes");
const userRoutes = require("./routes/userRoutes");
const cartRoutes = require("./routes/cartRoutes");
const reviewRoutes = require("./routes/reviewRoutes");
const settingsRoutes = require("./routes/settingsRoutes");
const couponRoutes = require("./routes/couponRoutes");
const dashboardRoutes = require("./routes/dashboardRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const deliveryRoutes = require("./routes/deliveryRoutes");
const deliveryOpsRoutes = require("./routes/deliveryOpsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const returnRoutes = require("./routes/returnRoutes");
const analyticsRoutes = require("./routes/analyticsRoutes");
const walletRoutes = require("./routes/walletRoutes");
const referralRoutes = require("./routes/referralRoutes");
const stockAlertRoutes = require("./routes/stockAlertRoutes");
const recommendationRoutes = require("./routes/recommendationRoutes");
const groupOrderRoutes = require("./routes/groupOrderRoutes");
const b2bRoutes = require("./routes/b2bRoutes");
const forecastRoutes = require("./routes/forecastRoutes");
const autopayRoutes = require("./routes/autopayRoutes");

const app = express();

// Do not advertise the Express version to scanners.
app.disable("x-powered-by");

// Register .jfif as a JPEG MIME type so product images served statically render in the browser
const mime = require("mime");
mime.define({ "image/jpeg": ["jfif"] }, true);

// ===============================
// MIDDLEWARE
// ===============================

// PROXY TRUST (SEC-03). `trust proxy` decides two security-relevant things:
// `req.ip` (the key every rate limiter uses) and `req.secure` (which decides
// whether the session cookie gets the Secure flag).
//
//   * Behind the Vercel edge (or any real reverse proxy) we must trust exactly
//     the hops in front of us, otherwise every client collapses into one shared
//     rate-limit bucket.
//   * When node/server.js is exposed directly over plain HTTP there is NO proxy.
//     Trusting X-Forwarded-For there would let any client mint an unlimited
//     number of "IP" buckets by rotating one header, and would let a client
//     forge req.secure.
//
// So the hop count is environment-driven instead of hard-coded:
//   TRUST_PROXY=<n|true|false>  explicit override (highest precedence)
//   Vercel runtime               -> 1 hop (default, unchanged behavior)
//   everything else (self-hosted)-> 0 (no proxy is trusted)
const TRUST_PROXY_RAW = process.env.TRUST_PROXY;
function resolveTrustProxy() {
    if (TRUST_PROXY_RAW != null && TRUST_PROXY_RAW !== "") {
        if (TRUST_PROXY_RAW === "true") return true;
        if (TRUST_PROXY_RAW === "false") return false;
        const hops = Number(TRUST_PROXY_RAW);
        return Number.isFinite(hops) && hops >= 0 ? hops : false;
    }
    // Vercel sets VERCEL=1 in every serverless invocation.
    if (process.env.VERCEL) return 1;
    return false;
}
app.set("trust proxy", resolveTrustProxy());

// Restrict cross-origin browsers to known origins. The API only needs to be
// consumed by the deployed site and local dev servers; Vercel preview
// deployments use *.vercel.app. Anything else (e.g. a malicious page trying
// to call these APIs) gets no CORS headers.
const ALLOWED_ORIGINS = [
    "https://freshmartstore.in",
    "https://www.freshmartstore.in",
    "https://freshmart-store-jet.vercel.app",
    "https://freshmart-store-git-main-alexa-65b1.vercel.app",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    /^https:\/\/freshmart-store(-\w+)?\.vercel\.app$/
];
function isAllowedOrigin(origin) {
    if (!origin) return true; // non-browser clients (curl, server-to-server)
    return ALLOWED_ORIGINS.some((rule) => {
        if (rule instanceof RegExp) return rule.test(origin);
        return rule === origin;
    });
}
app.use(cors({
    origin(origin, cb) {
        cb(null, isAllowedOrigin(origin));
    },
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400
}));

// CSRF defense-in-depth for cookie-authenticated state-changing requests:
// browsers always attach Origin to non-GET/HEAD/OPTIONS requests, so any
// cross-site POST/PATCH/DELETE (which would otherwise carry the auth cookie)
// is rejected before it reaches a route. Requests without an Origin header
// (curl, server-to-server) are allowed.
const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];
app.use((req, res, next) => {
    if (SAFE_METHODS.includes(req.method)) return next();
    const origin = req.headers.origin;
    if (origin && !isAllowedOrigin(origin)) {
        return res.status(403).json({ success: false, message: "Origin not allowed" });
    }
    next();
});

// GLOBAL API RATE LIMIT (SEC-03b)
// Most sensitive routers already carry their own tight limiter (auth 30/10min,
// OTP, uploads, B2B, coupons...). What was missing is a FLOOR for the areas
// that had none at all: /api/delivery (partner accept/OTP/proof),
// /api/delivery-ops (admin broadcast + offer creation), /api/reviews,
// /api/returns, /api/payments, /api/notifications and the admin dashboard.
//
// This bucket is deliberately generous (2000 requests / 5 min, ~6.7 req/s
// sustained) because it only has to stop a flood and keep a single client
// from pinning the serverless instance; the abuse-sensitive endpoints keep
// their own strict per-route limits. Mounted before the body parser so a
// flood is rejected before we spend CPU/bandwidth on it.
//
// `keyBy: "user"` — an IP-keyed floor is a liability in production, not a
// safeguard. Grocery traffic concentrates on shared egress: carrier NAT on
// mobile, a society/college or an office behind one address, and (on Vercel)
// `req.ip` is the real client IP, so one bucket is shared by every user behind
// that address. At 1000/5min a busy office or a housing-society cluster starts
// receiving 429s for ordinary browsing/cart/tracking while nobody is attacking
// anything - the failure mode is indistinguishable from an outage and there is
// nothing the affected user can do about it. Keying the floor on the
// authenticated account keeps the flood protection (one abusive account still
// gets 2000/5min, and it burns only its own bucket) while a shared IP can no
// longer exhaust a budget that belongs to other people. Anonymous traffic keeps
// the IP key exactly as before, which is where the flood risk actually is.
//
// Escape hatch for load tests / isolated suites: RATE_LIMIT_GLOBAL_MAX=0.
const GLOBAL_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_GLOBAL_WINDOW_MS) || 5 * 60 * 1000;
const GLOBAL_LIMIT_MAX = Number(process.env.RATE_LIMIT_GLOBAL_MAX) || 2000;
const globalApiLimiter = GLOBAL_LIMIT_MAX > 0
    ? rateLimit({ windowMs: GLOBAL_LIMIT_WINDOW_MS, max: GLOBAL_LIMIT_MAX, keyBy: "user" })
    : function (req, res, next) { next(); };
app.use("/api", globalApiLimiter);

// Parses the httpOnly session cookie (freshmart_token) on every request.
app.use(cookieParser());

// Captures the raw request body for HMAC-verified webhooks (autopay) while
// still parsing JSON normally — the same bytes the provider signed.
app.use(express.json({ limit: "5mb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } }));

// Structured one-line-JSON request logging (see utils/logger.js).
app.use(require("./utils/logger").requestLogger);

// Security headers on every API (and locally-served static) response. On Vercel
// the edge router also adds these for static files; here they guarantee the
// API responses always carry them (and give local dev identical behaviour).
// The CSP mirrors vercel.json so browser + API responses are consistent.
// script-src no longer needs 'unsafe-inline': every on* handler was migrated to
// data-act hooks resolved by the shared dispatcher in api.js, and the three
// remaining executable inline script blocks are allow-listed by digest
// (delivery.html, profile.html, signup.html). Kept as a literal so it stays
// byte-identical to vercel.json and greppable during audits.
const CSP = "default-src 'self'; script-src 'self' 'sha256-5E4kv0yJqsuBA5dWZXMVggBCcQSBYM5EKi0nWRuO2TE=' 'sha256-mkGHCh/CZhIcMe3N5brVBcW+qGcvpJr95hOI/Hzv9/Y=' 'sha256-AjxHWGLAep3r1KftZVXb0d1Iyjpek0SUDCCKmcdUsws='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.postalpincode.in https://nominatim.openstreetmap.org; font-src 'self'; frame-src 'self' https://www.openstreetmap.org; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; worker-src 'self'; manifest-src 'self'; upgrade-insecure-requests";
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self), browsing-topics=(), interest-cohort=(), fullscreen=(self)");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    // Sensitive JSON API responses must never be cached by shared caches.
    if (req.path.startsWith("/api/")) {
        res.setHeader("Cache-Control", "no-store");
    }
    next();
});

// ===============================
// ROUTES
// ===============================

app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/users", userRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reviews", reviewRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/coupons", couponRoutes);
app.use("/api/returns", returnRoutes);
app.use("/api/admin/dashboard", dashboardRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/delivery", deliveryRoutes);
app.use("/api/delivery-ops", deliveryOpsRoutes);
app.use("/api/notifications", notificationRoutes);
// Analytics router is mounted twice: /api/analytics for the public tracking
// endpoint and /api/admin for the admin KPI aggregation (GET /admin/analytics).
app.use("/api/analytics", analyticsRoutes);
app.use("/api/admin", analyticsRoutes);
// Wallet & referral: customer subpaths live under /api/wallet and /api/referral,
// admin operations under /api/admin/wallet.
app.use("/api/wallet", walletRoutes);
app.use("/api/admin/wallet", walletRoutes);
app.use("/api/referral", referralRoutes);
// Back-in-stock alerts: customer subscribe under /api/stock-alerts, the admin
// waiting-count view under /api/admin/stock-alerts.
app.use("/api/stock-alerts", stockAlertRoutes);
app.use("/api/admin/stock-alerts", stockAlertRoutes);
app.use("/api/recommendations", recommendationRoutes);
app.use("/api/groups", groupOrderRoutes);
app.use("/api/b2b", b2bRoutes.router);
app.use("/api/admin", b2bRoutes.adminRouter);
app.use("/api/admin", forecastRoutes);
app.use("/api/autopay", autopayRoutes.router);
app.use("/api/admin", autopayRoutes.adminRouter);

// Scheduled maintenance hook for delivery offers. Serverless has no in-process
// timer, so an external scheduler (Vercel Cron on a paid plan, or any cron
// service) can hit this endpoint to expire/auto-assign offers on time instead
// of waiting for a partner or admin to open a dashboard.
// Secured with a bearer token (CRON_SECRET). It is refused when the secret is
// not configured, so it can never become an open endpoint by accident.
app.get("/api/ops/cron/delivery-sweep", async (req, res) => {
    const secret = process.env.CRON_SECRET;
    if (!secret) {
        return res.status(503).json({ success: false, message: "CRON_SECRET is not configured" });
    }
    const auth = String(req.headers.authorization || "");
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    const provided = String(req.query.token || "");
    // Length-safe, timing-safe compare so the secret cannot be brute-forced by
    // measuring response times.
    const ok = (a, b) => {
        if (!a) return false;
        const ba = Buffer.from(a, "utf8");
        const bb = Buffer.from(b, "utf8");
        return ba.length === bb.length && require("crypto").timingSafeEqual(ba, bb);
    };
    // Either credential source is enough on its own: Vercel Cron sends only the
    // Authorization header, most other schedulers can only send ?token=.
    if (!ok(token, secret) && !ok(provided, secret)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    try {
        const deliveryOps = require("./controllers/deliveryOpsController");
        const result = await deliveryOps.sweepExpiredOffers(Number(req.query.limit) || 50);
        return res.json({ success: true, ...result });
    } catch (error) {
        logger.error({ ev: "cron_delivery_sweep_failed", err: (error && error.message) || "unknown" });
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
});

// Health check
app.get("/api/health", (req, res) => {
    res.json({ success: true, message: "FreshMart API is running" });
});

// ===============================
// SERVE STATIC FILES (frontend)
// ===============================

// SERVED-ONLY FILES are the static frontend (html/js/css/images).
// Everything server-side (config, secrets, backend source, dependencies)
// must NEVER be downloadable from the browser. This guard runs BEFORE
// express.static and blocks any request that targets such files.
const SERVED_ONLY_EXT = [".html", ".js", ".css", ".json", ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".svg", ".ico", ".txt", ".xml"];
const NEVER_SERVE_PREFIX = [
    "/.env", "/.git", "/node_modules", "/server.js", "/app.js", "/seed.js",
    "/seedAdmin.js", "/package.json", "/package-lock.json", "/vercel.json",
    "/controllers", "/models", "/routes", "/middleware", "/utils", "/api/",
    "/.vercel", "/\.db"
];
app.use("/", (req, res, next) => {
    const p = req.path;
    if (p === "/" || p === "") return next();
    const ext = path.extname(p).toLowerCase();
    if (NEVER_SERVE_PREFIX.some((prefix) => p.startsWith(prefix)) || (ext && !SERVED_ONLY_EXT.includes(ext))) {
        return res.status(404).json({ success: false, message: "Not found" });
    }
    next();
});

app.use(express.static(path.join(__dirname, ".")));

// ===============================
// TERMINAL HANDLERS (SEC-04a)
// ===============================
// Registered LAST so they only ever see a request that no route matched or
// that threw past its own handler.

// Unknown /api path -> JSON 404. Without this, an unmatched /api/... request
// fell through to the static handler and came back as Express's HTML
// "Cannot GET /api/nope", which leaked nothing but was inconsistent with every
// other API response (and 404'd with 200-ish HTML semantics for some clients).
app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    return res.status(404).json({ success: false, message: "Not found" });
});

// Last-resort error handler. Any error that reaches here was NOT caught by the
// route's own try/catch, so before this existed Express answered with its
// default HTML body — which in development mode prints a full stack trace and
// in production still echoes `err.message` verbatim (a Mongo driver's text for
// most failures). Everything internal is now logged server-side and answered
// with a generic message; deliberate 4xx messages from our own validation still
// pass through via utils/safeError.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const entry = errorLogEntry(err, req.originalUrl ? req.path : null);
    entry.reqid = res.getHeader("x-request-id") || undefined;
    logger.error(entry);
    if (res.headersSent) return next(err);
    const status = safeErrorStatus(err, 500);
    return res.status(status).json({ success: false, message: safeErrorMessage(err) });
});

module.exports = app;