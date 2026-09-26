// ===============================
// COUPON USAGE MODEL (per-customer redemption tracking)
// One document per (coupon, user) pair. The unique compound index makes the
// first claim for a user atomic, so two concurrent checkouts cannot both get
// the "first use" of a per-user-limited coupon.
// ===============================

const mongoose = require("mongoose");

const couponUsageSchema = new mongoose.Schema(
    {
        coupon: { type: mongoose.Schema.Types.ObjectId, ref: "Coupon", required: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
        // Number of orders this customer has redeemed this coupon on.
        count: { type: Number, default: 0, min: 0 }
    },
    { timestamps: true }
);

// Atomic first-claim: at most one usage document can exist per (coupon, user).
couponUsageSchema.index({ coupon: 1, user: 1 }, { unique: true });

module.exports = mongoose.model("CouponUsage", couponUsageSchema);