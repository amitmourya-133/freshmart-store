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

// Import routes
const productRoutes = require("./routes/productRoutes");
const orderRoutes = require("./routes/orderRoutes");
const userRoutes = require("./routes/userRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const cartRoutes = require("./routes/cartRoutes");
const reviewRoutes = require("./routes/reviewRoutes");

const app = express();

// Register .jfif as a JPEG MIME type so product images served statically render in the browser
const mime = require("mime");
mime.define({ "image/jpeg": ["jfif"] }, true);

// ===============================
// MIDDLEWARE
// ===============================

app.use(cors());

// Raw body for the Razorpay webhook (needed for HMAC signature verification).
// Must be mounted BEFORE express.json() so the raw buffer is preserved.
app.use("/api/payments/webhook", express.raw({ type: "*/*" }));

app.use(express.json());

// ===============================
// ROUTES
// ===============================

app.use("/api/products", productRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/users", userRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/cart", cartRoutes);
app.use("/api/reviews", reviewRoutes);

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
    "/controllers", "/models", "/routes", "/middleware", "/utils", "/api",
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