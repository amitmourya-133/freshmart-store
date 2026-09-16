// ===============================
// COUPON ROUTES
// Customer: POST /api/coupons/validate
// Admin:    GET|POST|PUT|DELETE /api/coupons  (admin middleware)
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const couponController = require("../controllers/couponController");

router.post("/validate", protect, couponController.validateCoupon);
router.get("/", protect, admin, couponController.listCoupons);
router.post("/", protect, admin, couponController.createCoupon);
router.put("/:id", protect, admin, couponController.updateCoupon);
router.delete("/:id", protect, admin, couponController.deleteCoupon);

module.exports = router;