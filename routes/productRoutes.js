// ===============================
// PRODUCT ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    getProducts,
    getProduct,
    getAdminProducts,
    createProduct,
    updateProduct,
    updatePrice,
    updateStock,
    deleteProduct,
    setRating,
    addRating
} = require("../controllers/productController");
const {
    getProductReviews,
    addProductReview
} = require("../controllers/reviewController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Public write limiter: stops anonymous rating/review spam inflating a
// product's rating or flooding the review list.
const publicWriteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

// Admin routes (must be BEFORE /:id route)
router.get("/admin/all", protect, admin, getAdminProducts);
router.post("/", protect, admin, createProduct);
router.put("/:id", protect, admin, updateProduct);
router.patch("/:id/stock", protect, admin, updateStock);
router.patch("/:id/price", protect, admin, updatePrice);
router.put("/:id/rating", protect, admin, setRating);
router.delete("/:id", protect, admin, deleteProduct);

// Public routes
router.get("/", getProducts);
router.get("/:id", getProduct);
router.post("/:id/rating", publicWriteLimiter, addRating);
router.get("/:id/reviews", getProductReviews);
router.post("/:id/reviews", publicWriteLimiter, addProductReview);

module.exports = router;
