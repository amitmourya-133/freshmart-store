// ===============================
// ORDER MODEL
// ===============================

const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema(
    {
        name: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 },
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" }
    },
    { _id: false }
);

const orderSchema = new mongoose.Schema(
    {
        orderNumber: { type: String, required: true, unique: true },
        // Public human-readable tracking reference (FM-YYYYMMDD-XXXXXX).
        // Kept absent (not null) so the sparse unique index stays clean.
        trackingId: { type: String, unique: true, sparse: true },
        // Client-generated idempotency key: retrying the same checkout never
        // creates a second order (prevents duplicates from double-click/retry).
        clientRef: { type: String, unique: true, sparse: true },
        customer: {
            name: { type: String, required: true, trim: true },
            phone: { type: String, required: true },
            address: { type: String, required: true },
            city: { type: String, required: true },
            state: { type: String, default: null },
            pincode: { type: String, required: true }
        },
        items: [orderItemSchema],
        payment: { type: String, default: "Cash On Delivery" },
        paymentMethod: { type: String, default: "cod" }, // cod | online
        paymentMode: { type: String, default: "cod" },   // cod | razorpay | manual
        // Manual UPI/QR transaction reference supplied by the customer
        paymentReference: { type: String, default: null },
        paid: { type: Boolean, default: false },
        // Payment lifecycle independent from delivery status.
        // PENDING | PAID | FAILED | CANCELLED | REFUNDED | PENDING_REFUND
        paymentStatus: {
            type: String,
            enum: ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED", "PENDING_REFUND"],
            default: "PENDING"
        },
        paymentAt: { type: Date, default: null },
        razorpay: {
            orderId: { type: String, default: null },
            paymentId: { type: String, default: null },
            signature: { type: String, default: null },
            method: { type: String, default: null }
        },
        refund: {
            id: { type: String, default: null },
            amount: { type: Number, default: 0 },
            status: { type: String, default: null },
            reference: { type: String, default: null },
            initiatedAt: { type: Date, default: null }
        },
        subtotal: { type: Number, default: 0 },
        delivery: { type: Number, default: 20 },
        deliverySlot: { type: String, default: "Morning (8-11 AM)" },
        subscription: { type: Boolean, default: false },
        subscriptionPlan: { type: String, default: null },
        total: { type: Number, default: 0 },
        status: {
            type: String,
            enum: ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"],
            default: "Placed"
        },
        // Timeline used by order tracking / admin
        statusHistory: [
            {
                status: { type: String },
                by: { type: String, default: null }, // who performed the change
                at: { type: Date, default: Date.now }
            }
        ],
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
    },
    { timestamps: true }
);

// Indexes for the common query patterns:
// customer order history (user + recency), admin status filters, tracking lookup.
orderSchema.index({ user: 1, createdAt: -1 });
orderSchema.index({ status: 1 });
orderSchema.index({ paymentStatus: 1 });
orderSchema.index({ "customer.phone": 1 });

module.exports = mongoose.model("Order", orderSchema);