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

// Register .jfif as a JPEG MIME type so product images served statically render in the browser
const mime = require("mime");
mime.define({ "image/jpeg": ["jfif"] }, true);

// ===============================
// MIDDLEWARE
// ===============================

// Vercel (and any reverse proxy) terminates TLS in front of this app; trust
// the first proxy hop so req.ip / req.secure reflect the real client connection
// (required for rate limiting and for Secure cookies behind HTTPS).
app.set("trust proxy", 1);

// Restrict cross-origin browsers to known origins. The API only needs to be
// consumed by the deployed site and local dev servers; Vercel preview
// deployments use *.vercel.app. Anything else (e.g. a malicious page trying
// to call these APIs) gets no CORS headers.
const ALLOWED_ORIGINS = [
    "https://freshmart-store-jet.vercel.app",
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
app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://api.postalpincode.in https://nominatim.openstreetmap.org; frame-src 'self' https://www.openstreetmap.org; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=(self)");
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
        return res.status(500).json({ success: false, message: error.message });
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

module.exports = app;