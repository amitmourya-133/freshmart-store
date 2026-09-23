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
const { rateLimit } = require("../utils/rateLimit");

// Same shared limiter for all public order endpoints: the key includes the
// matched route path, so each endpoint is counted separately. Soft guard
// against order spam / quote abuse / order-number enumeration. In-memory and
// best-effort on Vercel, matching the existing auth rate limiter.
const publicOrderLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// Public, but attaches the user to the order when the caller is logged in
// (guest checkout still works) so customers can see their own orders later.
router.post("/", publicOrderLimiter, optionalProtect, createOrder);
router.post("/quote", publicOrderLimiter, quoteOrder);
router.get("/track/:number", publicOrderLimiter, getOrderByNumber);

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