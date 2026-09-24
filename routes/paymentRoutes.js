const express = require("express");
const router = express();
const {
    createRazorpayOrder,
    verifyRazorpaySignature,
    webhookHandler,
    getPaymentStatus,
} = require("../controllers/paymentController");
const { protect } = require("../middleware/auth");

// Create Razorpay order (customer checkout)
router.post("/razorpay/order", protect, createRazorpayOrder);

// Verify Razorpay payment signature (frontend calls after payment)
router.post("/razorpay/verify", protect, verifyRazorpaySignature);

// Razorpay webhook (Razorpay server pushes this)
router.post("/razorpay/webhook", webhookHandler);

// Get payment status for order
router.get("/status/:orderId", protect, getPaymentStatus);

module.exports = router;