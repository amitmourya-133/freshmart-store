// ===============================
// SETTINGS ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    getShippingPolicy,
    getSettings,
    updateSettings
} = require("../controllers/settingsController");
const { protect, admin } = require("../middleware/auth");

// Public read-only delivery policy (safe values only).
router.get("/shipping", getShippingPolicy);

// Admin-only configuration endpoints.
router.get("/", protect, admin, getSettings);
router.put("/", protect, admin, updateSettings);

module.exports = router;