// ===============================
// PAYMENT ROUTES (Razorpay)
// ===============================

const express = require("express");
const router = express.Router();
const {
    createPaymentOrder,
    verifyPayment,
    refundPayment,
    razorpayWebhook,
    getReceipt,
    getPaymentConfig
} = require("../controllers/paymentController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

const verifyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });

// Public (Razorpay checkout + webhook need to be accessible)
router.get("/config", getPaymentConfig);
router.post("/create-order", verifyLimiter, createPaymentOrder);
router.post("/verify", verifyLimiter, verifyPayment);
router.post("/webhook", razorpayWebhook); // NOT rate-limited: Razorpay may batch

// Admin
router.post("/refund/:id", protect, admin, refundPayment);

// Customer/Admin receipt
router.get("/receipt/:id", protect, getReceipt);

module.exports = router;
