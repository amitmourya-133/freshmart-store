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
        perUserLimit: { type: Number, default: null, min: 0 },
        // Segment targeting (Phase 2): when set, the coupon is only eligible for
        // users whose current segment (utils/segments.js) contains this value.
        // null = available to every logged-in customer.
        segment: {
            type: String,
            enum: ["NEW_CUSTOMER", "INACTIVE_30_DAYS", "FREQUENT_BUYER", "HIGH_VALUE", "AT_RISK"],
            default: null
        },
        // Optional absolute rupee cap on any discount this coupon can grant.
        // Without it a percentage code on a huge cart is unbounded; the cap keeps
        // segment promotions within the approved margin. null = unlimited.
        maxDiscountAmount: { type: Number, default: null, min: 0 },
        // When the coupon is only visible to the targeted segment (and not
        // listed in the public coupon list).
        segmentOnly: { type: Boolean, default: false }
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
        expiresAt: this.expiryDate,
        segment: this.segment || null,
        maxDiscountAmount: this.maxDiscountAmount || null
    };
};

module.exports = mongoose.model("Coupon", couponSchema);