// ===============================
// SETTINGS MODEL
// Singleton configuration document (one global row).
// Used for delivery charges, the free-delivery threshold, the
// admin low-stock warning threshold, the minimum order value,
// the delivery radius + store location, and ETA guidance.
// No customer/public write access.
// ===============================

const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: "global", unique: true },
        deliveryCharge: { type: Number, default: 20, min: 0 },
        freeDeliveryThreshold: { type: Number, default: 500, min: 0 },
        lowStockThreshold: { type: Number, default: 20, min: 1 },
        minimumOrderValue: { type: Number, default: 0, min: 0 },
        // Delivery radius in km. 0 (default) = radius service check disabled,
        // so existing address-only customers are never broken. When > 0 the
        // server ENFORCES it: orders without an accepted GPS location are
        // rejected and destinations outside the radius are blocked.
        deliveryRadiusKm: { type: Number, default: 0, min: 0 },
        // Store origin used to measure the delivery radius (admin configured).
        storeLat: { type: Number, default: 0 },
        storeLng: { type: Number, default: 0 },
        storeLocality: { type: String, default: "Store", trim: true, maxlength: 120 },
        // ETA guidance (server-side, derived from real assignment/pipeline data
        // where available; slot label is the last-resort fallback).
        etaBaseMinutes: { type: Number, default: 45, min: 0 },
        etaMinutesPerKm: { type: Number, default: 3, min: 0 },
        // ---- Delivery operations (Phase 1-4) ----
        // Broadcast a real order to every online partner the moment it is
        // placed. Master switch: turning it off restores the old
        // "admin assigns manually" behaviour without touching any code.
        deliveryBroadcastEnabled: { type: Boolean, default: true },
        // How long a broadcast offer stays claimable (seconds).
        deliveryOfferTtlSeconds: { type: Number, default: 90, min: 15, max: 900 },
        // Auto-assign the NEAREST online partner when an offer expires
        // unclaimed. Off by default so a human stays in the loop.
        deliveryAutoAssign: { type: Boolean, default: false },
        // Delay before an unclaimed offer is auto-assigned / escalated.
        deliveryAutoAssignDelaySeconds: { type: Number, default: 90, min: 10, max: 1800 },
        // How many times a delivery OTP may be re-issued per assignment.
        deliveryMaxOtpReissue: { type: Number, default: 2, min: 0, max: 5 },
        // A partner with no location ping for this long is shown as stale.
        deliveryStaleMinutes: { type: Number, default: 15, min: 1, max: 240 },
        // How many broadcast ROUNDS an order may get before the delivery
        // operations give up and escalate to the admin. Bounded on purpose: a
        // fresh round re-alerts every online partner's phone, so an unbounded
        // retry would spam the whole fleet for one unservable address. 1 = the
        // legacy behaviour (one broadcast, then escalate).
        deliveryMaxDispatchRounds: { type: Number, default: 3, min: 1, max: 5 }
    },
    { timestamps: true }
);

// Fetch the singleton settings document, creating it with defaults on first use.
// Never deletes or resets an existing document.
settingsSchema.statics.getSettings = async function () {
    let doc = await this.findOne({ key: "global" });
    if (!doc) {
        doc = await this.create({ key: "global" });
    }
    let changed = false;
    // Backfill new fields for documents created before this schema change.
    if (doc.minimumOrderValue === undefined || doc.minimumOrderValue === null) {
        doc.minimumOrderValue = 0;
        changed = true;
    }
    if (doc.deliveryRadiusKm === undefined || doc.deliveryRadiusKm === null) {
        doc.deliveryRadiusKm = 0;
        changed = true;
    }
    if (doc.storeLat === undefined || doc.storeLat === null) {
        doc.storeLat = 0;
        changed = true;
    }
    if (doc.storeLng === undefined || doc.storeLng === null) {
        doc.storeLng = 0;
        changed = true;
    }
    if (doc.storeLocality === undefined || doc.storeLocality === null) {
        doc.storeLocality = "Store";
        changed = true;
    }
    if (doc.etaBaseMinutes === undefined || doc.etaBaseMinutes === null) {
        doc.etaBaseMinutes = 45;
        changed = true;
    }
    if (doc.etaMinutesPerKm === undefined || doc.etaMinutesPerKm === null) {
        doc.etaMinutesPerKm = 3;
        changed = true;
    }
    if (doc.deliveryBroadcastEnabled === undefined || doc.deliveryBroadcastEnabled === null) {
        doc.deliveryBroadcastEnabled = true;
        changed = true;
    }
    if (doc.deliveryOfferTtlSeconds === undefined || doc.deliveryOfferTtlSeconds === null) {
        doc.deliveryOfferTtlSeconds = 90;
        changed = true;
    }
    if (doc.deliveryAutoAssign === undefined || doc.deliveryAutoAssign === null) {
        doc.deliveryAutoAssign = false;
        changed = true;
    }
    if (doc.deliveryAutoAssignDelaySeconds === undefined || doc.deliveryAutoAssignDelaySeconds === null) {
        doc.deliveryAutoAssignDelaySeconds = 90;
        changed = true;
    }
    if (doc.deliveryMaxOtpReissue === undefined || doc.deliveryMaxOtpReissue === null) {
        doc.deliveryMaxOtpReissue = 2;
        changed = true;
    }
    if (doc.deliveryStaleMinutes === undefined || doc.deliveryStaleMinutes === null) {
        doc.deliveryStaleMinutes = 15;
        changed = true;
    }
    if (doc.deliveryMaxDispatchRounds === undefined || doc.deliveryMaxDispatchRounds === null) {
        doc.deliveryMaxDispatchRounds = 3;
        changed = true;
    }
    if (changed) await doc.save();
    return doc;
};

// Sanitized, public-facing delivery policy (safe to show on the checkout page).
settingsSchema.statics.getShippingPolicy = async function () {
    const doc = await this.getSettings();
    return {
        deliveryCharge: doc.deliveryCharge,
        freeDeliveryThreshold: doc.freeDeliveryThreshold,
        minimumOrderValue: doc.minimumOrderValue || 0,
        // Public-safe coverage info; the exact store coordinates are never
        // exposed to customers (server keeps those private).
        deliveryRadiusKm: Number(doc.deliveryRadiusKm) > 0 ? Number(doc.deliveryRadiusKm) : 0,
        storeLocality: doc.storeLocality || "Store",
        radiusEnabled: Number(doc.deliveryRadiusKm) > 0
    };
};

module.exports = mongoose.model("Settings", settingsSchema);