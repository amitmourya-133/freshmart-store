// ===============================
// ORDER ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    createOrder,
    getOrders,
    getMyOrders,
    getOrder,
    updateOrderStatus,
    getOrderByNumber
} = require("../controllers/orderController");
const { protect, admin } = require("../middleware/auth");

// Public
router.post("/", createOrder);
router.get("/track/:number", getOrderByNumber);

// Customer (protected)
router.get("/my", protect, getMyOrders);

// Admin
router.get("/", protect, admin, getOrders);
router.get("/:id", protect, admin, getOrder);
router.patch("/:id/status", protect, admin, updateOrderStatus);

module.exports = router;
