// ===============================
// ANALYTICS ROUTES
// This router is mounted twice:
//   * /api/analytics        -> POST /track (public event ingestion)
//   * /api/admin            -> GET  /analytics (admin KPI dashboard)
// ===============================

const express = require("express");
const router = express.Router();
const { track, adminAnalytics } = require("../controllers/analyticsController");
const { protect, admin, optionalProtect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Public event ingestion; generous burst limit, keyed by IP + user id.
const trackLimiter = rateLimit({ windowMs: 60 * 1000, max: 300 });

router.post("/track", trackLimiter, optionalProtect, track);
router.get("/analytics", protect, admin, adminAnalytics);

module.exports = router;