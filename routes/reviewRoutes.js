// ===============================
// REVIEW ROUTES (admin management)
// Public review endpoints live on /api/products/:id/reviews
// (see productRoutes.js). These are admin-only list/delete routes.
// ===============================

const express = require("express");
const router = express.Router();
const {
    adminListReviews,
    adminDeleteReview
} = require("../controllers/reviewController");
const { protect, admin } = require("../middleware/auth");

// Admin only
router.get("/", protect, admin, adminListReviews);
router.delete("/:id", protect, admin, adminDeleteReview);

module.exports = router;