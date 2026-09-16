// ===============================
// SETTINGS MODEL
// Singleton configuration document (one global row).
// Used for delivery charges, the free-delivery threshold and the
// admin low-stock warning threshold. No customer/public write access.
// ===============================

const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
    {
        key: { type: String, default: "global", unique: true },
        deliveryCharge: { type: Number, default: 20, min: 0 },
        freeDeliveryThreshold: { type: Number, default: 500, min: 0 },
        lowStockThreshold: { type: Number, default: 20, min: 1 }
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
    return doc;
};

// Sanitized, public-facing delivery policy (safe to show on the checkout page).
settingsSchema.statics.getShippingPolicy = async function () {
    const doc = await this.getSettings();
    return {
        deliveryCharge: doc.deliveryCharge,
        freeDeliveryThreshold: doc.freeDeliveryThreshold
    };
};

module.exports = mongoose.model("Settings", settingsSchema);