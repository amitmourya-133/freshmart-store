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

// Admin routes (must be BEFORE /:id route)
router.get("/admin/all", protect, admin, getAdminProducts);
router.post("/", protect, admin, createProduct);
router.put("/:id", protect, admin, updateProduct);
router.patch("/:id/stock", protect, admin, updateStock);
router.put("/:id/rating", protect, admin, setRating);
router.delete("/:id", protect, admin, deleteProduct);

// Public routes
router.get("/", getProducts);
router.get("/:id", getProduct);
router.post("/:id/rating", addRating);
router.get("/:id/reviews", getProductReviews);
router.post("/:id/reviews", addProductReview);

module.exports = router;
