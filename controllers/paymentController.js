// ===============================
// PAYMENT CONTROLLER (Razorpay)
// ===============================

const Razorpay = require("razorpay");
const crypto = require("crypto");
const Order = require("../models/Order");
const Product = require("../models/Product");

// Init Razorpay (returns null in demo if keys missing)
function getRazorpay() {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    if (!keyId || !keySecret) {
        return null;
    }
    return new Razorpay({ key_id: keyId, key_secret: keySecret });
}

// ===============================
// PAYMENT CONFIG (frontend decides live vs demo)
// ===============================
exports.getPaymentConfig = (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const configured = !!(keyId && process.env.RAZORPAY_KEY_SECRET);
    res.json({ success: true, configured: configured, key_id: configured ? keyId : null });
};

// ===============================
// CREATE RAZORPAY ORDER (for an existing unpaid order)
// Amount is always taken from the order stored on the server, never trusted from the client.
// ===============================
exports.createPaymentOrder = async (req, res) => {
    try {
        const { orderId } = req.body;
        if (!orderId) {
            return res.status(400).json({ success: false, message: "orderId is required" });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        if (order.paid) {
            return res.status(400).json({ success: false, message: "Order is already paid" });
        }
        if (order.paymentMethod === "cod") {
            return res.status(400).json({ success: false, message: "COD orders cannot be paid online" });
        }

        // Idempotent: reuse an existing Razorpay order for this order
        if (order.razorpay.orderId && !String(order.razorpay.orderId).startsWith("demo_")) {
            return res.json({
                success: true,
                data: { id: order.razorpay.orderId, amount: Math.round(order.total * 100), currency: "INR" },
                key_id: process.env.RAZORPAY_KEY_ID || null
            });
        }

        const rzp = getRazorpay();
        if (!rzp) {
            // Demo mode - no real razorpay available
            return res.json({
                success: true,
                demo: true,
                message: "Razorpay not configured. Using demo mode.",
                data: { id: "demo_" + Date.now(), amount: Math.round(order.total * 100), currency: "INR" }
            });
        }

        const options = {
            amount: Math.round(order.total * 100), // Paise, server-authoritative
            currency: "INR",
            receipt: order.orderNumber,
            notes: { orderNumber: order.orderNumber }
        };

        const rzpOrder = await rzp.orders.create(options);
        order.razorpay.orderId = rzpOrder.id;
        order.razorpay.method = null;
        await order.save();

        res.status(201).json({ success: true, data: rzpOrder, key_id: process.env.RAZORPAY_KEY_ID });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// VERIFY PAYMENT (after successful checkout)
// ===============================
exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, orderId } = req.body;

        // Verify signature to ensure an authentic Razorpay payment
        const keySecret = process.env.RAZORPAY_KEY_SECRET;
        let verified = false;

        if (keySecret && razorpay_order_id && razorpay_payment_id && razorpay_signature) {
            const body = razorpay_order_id + "|" + razorpay_payment_id;
            const expectedSignature = crypto
                .createHmac("sha256", keySecret)
                .update(body.toString())
                .digest("hex");
            verified = expectedSignature === razorpay_signature;
        } else if (!keySecret) {
            // Demo mode auto-verify
            verified = true;
        }

        if (!verified) {
            return res.status(400).json({ success: false, message: "Payment verification failed" });
        }

        // Find order by our order id or razorpay order id
        let order;
        if (orderId) order = await Order.findById(orderId);
        if (!order && razorpay_order_id) order = await Order.findOne({ "razorpay.orderId": razorpay_order_id });

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Ownership: only the order owner (or admin) may confirm it
        if (order.user && req.user && order.user.toString() !== req.user._id.toString() && !req.user.isAdmin && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        // Idempotency / duplicate prevention
        if (order.paid) {
            if (order.razorpay.paymentId && order.razorpay.paymentId === razorpay_payment_id) {
                return res.json({ success: true, data: order, receipt: order.orderNumber, already: true });
            }
            return res.status(400).json({ success: false, message: "Order is already paid" });
        }

        order.paid = true;
        order.paymentAt = new Date();
        order.razorpay.orderId = razorpay_order_id || order.razorpay.orderId;
        order.razorpay.paymentId = razorpay_payment_id || order.razorpay.paymentId;
        order.razorpay.signature = razorpay_signature || order.razorpay.signature;
        order.payment = "Razorpay - " + (order.paymentMethod || "Online");
        await order.save();

        res.json({ success: true, data: order, receipt: order.orderNumber });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// REFUND (admin-initiated)
// ===============================
exports.refundPayment = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Only allocated for paid Razorpay orders
        if (!order.paid) {
            return res.status(400).json({ success: false, message: "Order was not paid online" });
        }

        if (!order.razorpay.paymentId || order.razorpay.paymentId.startsWith("demo")) {
            return res.status(400).json({ success: false, message: "Demo order - no real payment to refund" });
        }

        if (order.refund && order.refund.id) {
            return res.status(400).json({ success: false, message: "Refund already processed for this order" });
        }

        const rzp = getRazorpay();
        if (!rzp) {
            return res.status(400).json({ success: false, message: "Razorpay not configured" });
        }

        const refund = await rzp.payments.refund(order.razorpay.paymentId, {
            amount: Math.round(order.total * 100),
            notes: { orderNumber: order.orderNumber }
        });

        order.refund.id = refund.id;
        order.refund.amount = order.total;
        order.refund.status = refund.status || "processed";
        order.refund.initiatedAt = new Date();
        await order.save();

        res.json({ success: true, data: order, message: "Refund processed" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// RAZORPAY WEBHOOK (payment capture)
// req.body is the raw Buffer (server.js mounts express.raw for this route).
// ===============================
exports.razorpayWebhook = async (req, res) => {
    try {
        const rawBody = req.body;
        if (!rawBody) {
            return res.status(400).json({ success: false, message: "Missing body" });
        }

        const rawBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody));
        const signature = req.headers["x-razorpay-signature"];
        const secret = process.env.RAZORPAY_KEY_SECRET;

        // When keys are configured, every webhook MUST pass signature verification
        if (secret) {
            if (!signature) {
                return res.status(400).json({ success: false, message: "Missing signature" });
            }
            const expected = crypto
                .createHmac("sha256", secret)
                .update(rawBuf)
                .digest("hex");
            if (expected !== signature) {
                return res.status(400).json({ success: false, message: "Invalid signature" });
            }
        }

        const body = JSON.parse(rawBuf.toString("utf8"));
        const event = body.event;
        const payment = body.payload && body.payload.payment && body.payload.payment.entity;

        if (event === "payment.captured" || event === "order.paid") {
            const rzpOrderId = payment && payment.order_id;
            const paymentId = payment && payment.id;
            if (rzpOrderId) {
                const order = await Order.findOne({ "razorpay.orderId": rzpOrderId });
                if (order) {
                    // Idempotent update
                    order.paid = true;
                    order.paymentAt = order.paymentAt || new Date();
                    if (paymentId) order.razorpay.paymentId = paymentId;
                    if (payment.method) order.razorpay.method = payment.method;
                    order.payment = "Razorpay - " + (payment.method || "Online");
                    await order.save();
                }
            }
        } else if (event === "payment.failed") {
            const rzpOrderId = payment && payment.order_id;
            if (rzpOrderId) {
                const order = await Order.findOne({ "razorpay.orderId": rzpOrderId });
                // Leave the order unpaid; payment stays flagged for manual review.
                if (order && !order.paid) {
                    order.razorpay.paymentId = (payment && payment.id) || order.razorpay.paymentId;
                    await order.save();
                }
            }
        }

        res.json({ success: true, received: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// GET RECEIPT / PAYMENT DETAILS
// ===============================
exports.getReceipt = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Owner or admin only
        if (order.user && req.user && order.user.toString() !== req.user._id.toString() && !req.user.isAdmin && req.user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Not authorized" });
        }

        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};