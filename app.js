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
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
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

app.use(express.json());

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
app.use("/api/admin/dashboard", dashboardRoutes);

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
const SERVED_ONLY_EXT = [".html", ".js", ".css", ".png", ".jpg", ".jpeg", ".jfif", ".webp", ".gif", ".svg", ".ico", ".txt"];
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