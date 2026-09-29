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
    // ============ Veggie Box runtime (Subscription 2.0) ============
    // Snapshot of the box contents taken at subscribe time (leaf-line details
    // are preserved even if the plan is later edited, so a cycle is always
    // fulfilled from what the customer agreed to).
    boxSnapshot: [{
        productId: {
            type: ObjectId,
            ref: "Product",
        },
        name: { type: String, trim: true },
        unit: { type: String, trim: true, default: "kg" },
        quantity: {
            type: Number,
            min: 0.01,
            default: 1,
        },
        price: {
            type: Number,
            min: 0,
            default: 0,
        },
    }],
    autoRenew: {
        type: Boolean,
        default: true,
    },
    fulfilledCount: {
        type: Number,
        default: 0,
    },
    lastFulfilledAt: {
        type: Date,
    },
    // outcome of the most recent due-cycle run
    lastAttemptStatus: {
        type: String,
        enum: ["ok", "stock_shortfall", "provider_unconfigured", "failed"],
    },
    lastAttemptAt: {
        type: Date,
    },
    lastAttemptMessage: {
        type: String,
        trim: true,
    },
}, { timestamps: true });

// Index for quick user lookup
UserSubscriptionSchema.index({ user: 1, status: 1 });

module.exports = mongoose.model("UserSubscription", UserSubscriptionSchema);