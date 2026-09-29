// ===============================
// ANALYTICS EVENT MODEL
// Immutable behavioral events for product growth analytics. Frontend events are
// fire-and-forget; the anonymousId/sessionId let the same visitor's steps be
// reconstructed without ever storing any personal data. Events are never used
// for authentication or order data - they are pure product analytics.
// ===============================

const mongoose = require("mongoose");

const analyticsEventSchema = new mongoose.Schema(
    {
        eventName: {
            type: String,
            required: true,
            index: true,
            enum: [
                "signup",
                "login",
                "google_login",
                "product_view",
                "product_search",
                "category_view",
                "add_to_cart",
                "remove_from_cart",
                "wishlist_add",
                "checkout_started",
                "coupon_applied",
                "checkout_completed",
                "order_created",
                "order_confirmed",
                "order_cancelled",
                "order_delivered",
                "repeat_order",
                "referral_signup",
                "referral_reward",
                "review_created",
                "review_photo_added",
                "stock_alert_subscribed",
                "stock_alert_triggered",
                "pwa_install",
                "reminder_sent",
                "reminder_clicked",
                "reminder_converted",
                // ===== Phase 2 — growth engines =====
                "recommendation_impression",
                "recommendation_click",
                "recommendation_add_to_cart",
                "recommendation_purchase",
                "coupon_issued",
                "coupon_viewed",
                "coupon_redeemed",
                "subscription_start",
                "subscription_renewal",
                "subscription_cancellation",
                "group_created",
                "group_joined",
                "group_threshold_reached",
                "whatsapp_opted_in",
                "b2b_order_created",
                "reorder_alert_triggered",
                // ===== Phase 3 — scale & monetization =====
                "autopay_mandate_created",
                "autopay_renewal_success",
                "autopay_renewal_failed",
            ],
        },
        // Real account when the visitor is logged in; otherwise null.
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
        // Client-generated visitor/session identifiers (no personal data).
        anonymousId: { type: String, trim: true, default: null },
        sessionId: { type: String, trim: true, default: null },
        // Optional entity context (product/order/category/coupon code, ...).
        productId: { type: String, default: null },
        orderId: { type: String, default: null },
        orderIdRef: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
        // Free-form secondary context (e.g. { code: "FM10OFF", value: 20 }).
        metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
        // Source device/page so funnel analysis can tell mobile vs desktop.
        device: { type: String, default: null },
        page: { type: String, default: null },
        createdAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// Admin analytics range queries filter by createdAt.
analyticsEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AnalyticsEvent", analyticsEventSchema);