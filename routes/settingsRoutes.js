// ===============================
// SETTINGS ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    getShippingPolicy,
    getDeliveryCoverage,
    getSettings,
    updateSettings
} = require("../controllers/settingsController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Public read-only delivery policy (safe values only).
router.get("/shipping", getShippingPolicy);

// Public coverage check (lat/lng). Returns serviceable + distance (km) only;
// never exposes the store's exact coordinates or any customer/partner data.
const coverageLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });
router.get("/delivery-check", coverageLimiter, getDeliveryCoverage);

// Admin-only configuration endpoints.
router.get("/", protect, admin, getSettings);
router.put("/", protect, admin, updateSettings);

module.exports = router;