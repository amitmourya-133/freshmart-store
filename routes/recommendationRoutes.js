// ===============================
// RECOMMENDATION ROUTES
// POST /api/recommendations  (public; optional auth for personalization)
// ===============================

const express = require("express");
const router = express.Router();
const { optionalProtect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const recommendationController = require("../controllers/recommendationController");

// Guard the expensive-ish aggregation from abusive unauthenticated polling.
const recLimiter = rateLimit({ windowMs: 60 * 1000, max: 40 });

router.post("/", optionalProtect, recLimiter, recommendationController.getRecommendations);

module.exports = router;