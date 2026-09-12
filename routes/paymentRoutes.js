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

// Public (Razorpay checkout + webhook need to be accessible)
router.get("/config", getPaymentConfig);
router.post("/create-order", createPaymentOrder);
router.post("/verify", verifyPayment);
router.post("/webhook", razorpayWebhook);

// Admin
router.post("/refund/:id", protect, admin, refundPayment);

// Customer/Admin receipt
router.get("/receipt/:id", protect, getReceipt);

module.exports = router;
