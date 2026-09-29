const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const NotificationSchema = new mongoose.Schema(
    {
        user: {
            type: ObjectId,
            ref: "User",
            required: [true, "Notification recipient is required"],
        },
        type: {
            type: String,
            // Every value the app actually sends. A missing entry here does not
            // throw at the call site - the notification is silently dropped - so
            // this list must stay in step with the controllers.
            enum: [
                "order_status",
                "delivery_assignment",
                "delivery_offer",
                "delivery_offer_closed",
                "delivery_otp",
                "delivery_unclaimed",
                "delivery_unattended",
                "partner_application",
                "partner_status",
                "low_stock",
                "subscription",
                "payment",
                "review",
                "reminder",
                "stock_alert",
                "referral",
                "wallet",
                "system",
            ],
            default: "system",
        },
        title: {
            type: String,
            required: [true, "Notification title is required"],
            trim: true,
        },
        message: {
            type: String,
            trim: true,
            default: "",
        },
        data: {
            type: mongoose.Schema.Types.Mixed,
            default: {},
        },
        read: {
            type: Boolean,
            default: false,
        },
        readAt: {
            type: Date,
        },
        // Optional idempotency key: when provided, notifyBase only creates the
        // notification once per (user, dedupeKey), preventing duplicate inbox
        // entries for the same event (e.g. repeated delivery status POSTs).
        dedupeKey: {
            type: String,
            trim: true,
        },
    },
    { timestamps: true }
);

// Per-recipient inbox queries (unread badge, list ordering)
NotificationSchema.index({ user: 1, read: 1 });
NotificationSchema.index({ user: 1, createdAt: -1 });
// Exactly-once enforcement for dedupeKey-bearing notifications.
NotificationSchema.index(
    { user: 1, dedupeKey: 1 },
    { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } }
);

module.exports = mongoose.model("Notification", NotificationSchema);