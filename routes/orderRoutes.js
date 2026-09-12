// ===============================
// ORDER ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    createOrder,
    quoteOrder,
    getOrders,
    getOverview,
    getMyOrders,
    getOrder,
    updateOrderStatus,
    updatePaymentStatus,
    cancelOrder,
    getOrderByNumber
} = require("../controllers/orderController");
const { protect, admin, optionalProtect } = require("../middleware/auth");

// Public, but attaches the user to the order when the caller is logged in
// (guest checkout still works) so customers can see their own orders later.
router.post("/", optionalProtect, createOrder);
router.post("/quote", quoteOrder);
router.get("/track/:number", getOrderByNumber);

// Customer (protected)
router.get("/my", protect, getMyOrders);
router.post("/:id/cancel", protect, cancelOrder);

// Admin
router.get("/admin/overview", protect, admin, getOverview);
router.get("/", protect, admin, getOrders);
router.get("/:id", protect, getOrder); // owner or admin
router.patch("/:id/status", protect, admin, updateOrderStatus);
router.patch("/:id/payment-status", protect, admin, updatePaymentStatus);

module.exports = router;