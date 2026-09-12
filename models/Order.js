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
        customer: {
            name: { type: String, required: true },
            phone: { type: String, required: true },
            address: { type: String, required: true },
            city: { type: String, required: true },
            pincode: { type: String, required: true }
        },
        items: [orderItemSchema],
        payment: { type: String, default: "Cash On Delivery" },
        paymentMethod: { type: String, default: "cod" },
        paid: { type: Boolean, default: false },
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
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Order", orderSchema);
