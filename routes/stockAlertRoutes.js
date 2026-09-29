// ===============================
// STOCK ALERT ROUTES
// Mounted at /api/stock-alerts (customer) and /api/admin/stock-alerts (admin).
// ===============================

const express = require("express");
const router = express.Router();
const { subscribe, adminWaiting } = require("../controllers/stockAlertController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

const subscribeLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

router.post("/", protect, subscribeLimiter, subscribe);
router.get("/waiting", protect, admin, adminWaiting);

module.exports = router;