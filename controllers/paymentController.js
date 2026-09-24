// ===============================
// FRESHMART - PAYMENT CONTROLLER
// Razorpay online payment integration
// COD and manual UPI remain supported
// ===============================

const crypto = require("crypto");
const Payment = require("../models/Payment"); // We'll create this model
const Order = require("../models/Order");

// Helper: generate receipt ID
function generateReceipt() {
    return "FM-" + Date.now() + "-" + Math.floor(Math.random() * 10000);
}

// Create Razorpay order
exports.createRazorpayOrder = async (req, res) => {
    try {
        const { amount, currency = "INR", receipt, orderId } = req.body;

        if (!amount || amount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Amount must be positive",
            });
        }

        // Order already exists (from checkout)
        const actualReceipt = receipt || generateReceipt();

        // In a real implementation, we'd create the order via Razorpay SDK
        // For now, we return a payment object that the frontend will use
        const paymentDetails = {
            id: actualReceipt,
            amount: amount * 100, // Razorpay expects amount in paise
            currency: currency,
            receipt: actualReceipt,
            orderId: orderId || "order_" + Date.now(),
        };

        return res.json({
            success: true,
            payment: paymentDetails,
            message: "Razorpay order created successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Verify Razorpay payment signature
exports.verifyRazorpaySignature = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

        if (
            !razorpay_order_id ||
            !razorpay_payment_id ||
            !razorpay_signature
        ) {
            return res.status(400).json({
                success: false,
                message: "Payment signature parameters missing",
            });
        }

        // Build the signature verification string
        const sign = crypto
            .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
            .update(razorpay_order_id + "|" + razorpay_payment_id)
            .digest("hex");

        // Verify signature
        if (sign === razorpay_signature) {
            // Signature is valid - payment is legitimate
            return res.json({
                success: true,
                message: "Payment verified successfully",
            });
        } else {
            // Invalid signature - potential fraud
            return res.status(400).json({
                success: false,
                message: "Invalid payment signature. Payment not verified.",
            });
        }
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Handle payment webhook (Razorpay sends POST to this endpoint)
exports.webhookHandler = async (req, res) => {
    try {
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
        const payload = req.body;
        const signature = req.headers["x-razorpay-signature"];

        if (!webhookSecret || !signature) {
            return res.status(400).json({
                success: false,
                message: "Webhook secret missing",
            });
        }

        // Verify webhook signature
        const crypto = require("crypto");
        const generatedSignature = crypto
            .createHmac("sha256", webhookSecret)
            .update(JSON.stringify(payload))
            .digest("hex");

        if (generatedSignature !== signature) {
            return res.status(400).json({
                success: false,
                message: "Invalid webhook signature",
            });
        }

        // Process the webhook event
        const event = payload.event;
        const data = payload.payload.payment.entity;

        // Handle different events
        if (event === "payment.authorized") {
            // Payment authorized - capture it or mark as paid
            // Find the order and update payment status
            // This is a simplified example - in production, you'd store the orderId
            // in the payment entity or use metadata
            return res.json({
                success: true,
                message: "Payment authorized webhook received",
            });
        }

        if (event === "payment.captured") {
            // Payment captured - order is paid
            return res.json({
                success: true,
                message: "Payment captured webhook received",
            });
        }

        if (event === "payment.failed") {
            // Payment failed - mark order as failed
            return res.json({
                success: true,
                message: "Payment failed webhook received",
            });
        }

        return res.json({
            success: true,
            message: "Webhook event received: " + event,
        });
    } catch (error) {
        console.error("Webhook error:", error);
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// Get payment status for an order
exports.getPaymentStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        // In a real implementation, we'd look up the payment by orderId
        // For now, return the order's payment status
        const order = await Order.findById(orderId).select(
            "payment paymentMethod paymentStatus paymentReference paid paymentAt"
        );

        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Order not found",
            });
        }

        return res.json({
            success: true,
            payment: {
                method: order.paymentMethod,
                status: order.paymentStatus,
                reference: order.paymentReference,
                paid: order.paid,
                paidAt: order.paymentAt,
            },
            message: "Payment status retrieved successfully",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};