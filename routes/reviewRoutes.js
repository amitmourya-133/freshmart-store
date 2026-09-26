// ===============================
// REVIEW ROUTES (management + customer ownership actions)
// Public review endpoints live on /api/products/:id/reviews
// (see productRoutes.js). These routes handle admin moderation/list/delete and
// customer edit/delete of their own review.
// ===============================

const express = require("express");
const router = express.Router();
const {
    adminListReviews,
    adminModerateReview,
    deleteReview,
    updateOwnReview
} = require("../controllers/reviewController");
const { protect, admin } = require("../middleware/auth");

// Admin only
router.get("/", protect, admin, adminListReviews);
router.patch("/:id/moderation", protect, admin, adminModerateReview);

// Customer (or admin) — ownership enforced inside the controller.
router.put("/:id", protect, updateOwnReview);
router.delete("/:id", protect, deleteReview);

module.exports = router;