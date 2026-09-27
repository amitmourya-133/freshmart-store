// ===============================
// FRESHMART - PAYMENT CONTROLLER
// COD and manual UPI only. The former Razorpay gateway integration (order /
// verify / webhook endpoints, HMAC verification and Payment documents) was
// fully removed: no gateway SDK, keys, endpoints or webhooks remain.
// Online (manual UPI) orders stay PENDING until an admin verifies the
// transfer — never treated as paid by the client or any endpoint here.
// ===============================

const Order = require("../models/Order");

// GET /api/payments/status/:orderId — ownership-protected payment status.
// A customer may only view their own order; admins may view any.
exports.getPaymentStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!orderId || !/^[0-9a-fA-F]{24}$/.test(String(orderId))) {
            return res.status(400).json({ success: false, message: "Valid order ID required" });
        }

        const order = await Order.findById(orderId).select(
            "_id user payment paymentMethod paymentStatus paymentReference paid paymentAt"
        );

        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const isAdmin = req.user && req.user.role === "admin";
        const isOwner = order.user && req.user && String(order.user) === String(req.user._id);
        if (!isAdmin && !isOwner) {
            return res.status(403).json({ success: false, message: "Not authorized to view this order's payment status" });
        }

        return res.json({
            success: true,
            payment: {
                method: order.paymentMethod,
                status: order.paymentStatus,
                reference: order.paymentReference,
                paid: order.paid,
                paidAt: order.paymentAt
            },
            message: "Payment status retrieved successfully"
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: "Could not retrieve payment status" });
    }
};