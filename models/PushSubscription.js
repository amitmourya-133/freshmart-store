// ===============================
// PUSH SUBSCRIPTION MODEL
// Web Push subscriptions are persisted in MongoDB (NOT on the filesystem):
// serverless filesystems are ephemeral and per-instance, so a file-backed
// store loses every subscription between invocations. One subscription per
// browser endpoint; a re-subscribe on the same endpoint updates the owner.
// ===============================

const mongoose = require("mongoose");

const pushSubscriptionSchema = new mongoose.Schema(
    {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        // The browser-generated push endpoint. Globally unique: an endpoint
        // belongs to exactly one browser, so it identifies its owner.
        // `unique` already creates the index - no separate `index: true`.
        endpoint: { type: String, required: true, unique: true },
        keys: {
            p256dh: { type: String },
            auth: { type: String },
        },
        userAgent: { type: String, trim: true, maxlength: 200 },
        // A dead endpoint (404/410) is deactivated instead of deleted so the
        // history stays auditable; re-subscribing flips it back to active.
        active: { type: Boolean, default: true, index: true },
        failureCount: { type: Number, default: 0, min: 0 },
        lastError: { type: String, trim: true, maxlength: 300 },
        lastSentAt: { type: Date },
        lastSuccessAt: { type: Date },
    },
    { timestamps: true }
);

// Fan-out query for one recipient: active subscriptions only.
pushSubscriptionSchema.index({ user: 1, active: 1 });

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
