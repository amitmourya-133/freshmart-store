// ===============================
// COUPON MODEL
// Server-authoritative discount codes (WELCOME50 etc).
// Codes are normalized to uppercase; discounts are computed by the backend
// from these recorded values, never from client-sent figures.
// ===============================

const mongoose = require("mongoose");

const couponSchema = new mongoose.Schema(
    {
        code: {
            type: String,
            required: true,
            unique: true,
            trim: true,
            uppercase: true,
            match: /^[A-Z0-9_-]+$/
        },
        // percentage | fixed (absolute rupee discount)
        discountType: { type: String, enum: ["percentage", "fixed"], required: true },
        // percentage: 1..100  |  fixed: rupees > 0
        discountValue: { type: Number, required: true, min: 0 },
        // cart subtotal must be >= this value to use the coupon (0 = no minimum)
        minimumOrderValue: { type: Number, default: 0, min: 0 },
        expiryDate: { type: Date, required: true },
        active: { type: Boolean, default: true },
        // null = unlimited uses
        usageLimit: { type: Number, default: null, min: 0 },
        // successful eligible uses (incremented only when an order is created)
        usageCount: { type: Number, default: 0, min: 0 },
        // Per-customer redemption cap (null = each customer may use it unlimited
        // times). Enforced server-side against the CouponUsage collection.
        perUserLimit: { type: Number, default: null, min: 0 }
    },
    { timestamps: true }
);

// Sanitized view for the public (coupon application during checkout).
// Never exposes usageCount / usageLimit / expiry internals to the customer.
couponSchema.methods.publicView = function () {
    return {
        code: this.code,
        discountType: this.discountType,
        discountValue: this.discountValue,
        minimumOrderValue: this.minimumOrderValue,
        expiresAt: this.expiryDate
    };
};

module.exports = mongoose.model("Coupon", couponSchema);