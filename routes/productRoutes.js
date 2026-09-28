// ===============================
// PRODUCT ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    getProducts,
    getProduct,
    getTrendingProducts,
    getAdminProducts,
    getSuggestions,
    aiSearch,
    createProduct,
    updateProduct,
    updatePrice,
    updateStock,
    deleteProduct,
    setRating,
    addRating,
    uploadImage
} = require("../controllers/productController");
const {
    getProductReviews,
    addProductReview
} = require("../controllers/reviewController");
const { protect, admin, optionalProtect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Public write limiter: stops anonymous rating/review spam inflating a
// product's rating or flooding the review list.
const publicWriteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

// Uploads are expensive (Cloudinary round-trip) so admins get their own
// limiter on the upload endpoint.
const uploadLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

// Suggestions fire per keystroke (debounced on the client); bound each IP so a
// script cannot hammer MongoDB with suggestion queries.
const suggestionsLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });
// AI search hits an external paid provider per call; keep it tight.
const aiSearchLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// Admin routes (must be BEFORE /:id route)
router.get("/admin/all", protect, admin, getAdminProducts);
router.post("/upload", protect, admin, uploadLimiter, uploadImage);
router.post("/", protect, admin, createProduct);
router.put("/:id", protect, admin, updateProduct);
router.patch("/:id/stock", protect, admin, updateStock);
router.patch("/:id/price", protect, admin, updatePrice);
router.put("/:id/rating", protect, admin, setRating);
router.delete("/:id", protect, admin, deleteProduct);

// Public routes
router.get("/", getProducts);
// MUST stay above /:id so "trending" is never treated as an ObjectId.
router.get("/trending", getTrendingProducts);
router.get("/suggestions", suggestionsLimiter, getSuggestions);
router.post("/ai-search", aiSearchLimiter, aiSearch);
router.get("/:id", getProduct);
router.post("/:id/rating", protect, publicWriteLimiter, addRating);
router.get("/:id/reviews", getProductReviews);
router.post("/:id/reviews", protect, publicWriteLimiter, addProductReview);

module.exports = router;
