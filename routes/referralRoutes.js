// ===============================
// REFERRAL ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const { getMyReferral, claim } = require("../controllers/referralController");
const { protect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

const claimLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

router.get("/me", protect, getMyReferral);
router.post("/claim", protect, claimLimiter, claim);

module.exports = router;