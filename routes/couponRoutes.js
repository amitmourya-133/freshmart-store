// ===============================
// COUPON ROUTES
// Customer: POST /api/coupons/validate
// Admin:    GET|POST|PUT|DELETE /api/coupons  (admin middleware)
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const couponController = require("../controllers/couponController");

// Limiter on validation so coupon codes cannot be brute-forced.
const couponValidateLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

router.post("/validate", protect, couponValidateLimiter, couponController.validateCoupon);
router.get("/", protect, admin, couponController.listCoupons);
router.post("/", protect, admin, couponController.createCoupon);
router.put("/:id", protect, admin, couponController.updateCoupon);
router.delete("/:id", protect, admin, couponController.deleteCoupon);

module.exports = router;