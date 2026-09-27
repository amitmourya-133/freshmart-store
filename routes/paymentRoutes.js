const express = require("express");
const router = express();
const { getPaymentStatus } = require("../controllers/paymentController");
const { protect } = require("../middleware/auth");

// Get payment status for order
router.get("/status/:orderId", protect, getPaymentStatus);

module.exports = router;