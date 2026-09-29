// ===============================
// INVENTORY FORECAST ROUTES (Phase 3.8)
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const forecastController = require("../controllers/forecastController");

const forecastLimiter = rateLimit({ windowMs: 60 * 1000, max: 12 });

router.get("/inventory/forecast", protect, admin, forecastLimiter, forecastController.getForecast);

module.exports = router;