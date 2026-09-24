const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const UserSubscriptionSchema = new mongoose.Schema({
    user: {
        type: ObjectId,
        ref: "User",
        required: [true, "User reference is required"],
    },
    plan: {
        type: ObjectId,
        ref: "SubscriptionPlan",
        required: [true, "Plan reference is required"],
    },
    status: {
        type: String,
        enum: ["active", "paused", "cancelled", "expired"],
        default: "active",
    },
    startDate: {
        type: Date,
        default: Date.now,
    },
    nextDeliveryDate: {
        type: Date,
    },
    lastPaymentDate: {
        type: Date,
    },
    cancelDate: {
        type: Date,
    },
    autoResume: {
        type: Boolean,
        default: false,
    },
    paymentHistory: [{
        amount: {
            type: Number,
            required: true,
        },
        date: {
            type: Date,
            default: Date.now,
        },
        status: {
            type: String,
            enum: ["pending", "success", "failed", "refunded"],
            default: "pending",
        },
        transactionId: {
            type: String,
        },
    }],
    trialEndsAt: {
        type: Date,
    },
    isTrial: {
        type: Boolean,
        default: false,
    },
}, { timestamps: true });

// Index for quick user lookup
UserSubscriptionSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model("UserSubscription", UserSubscriptionSchema);