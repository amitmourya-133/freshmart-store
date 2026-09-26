// ===============================
// INVENTORY LOG MODEL (audit trail for every stock change)
// Append-only: order reservations, cancellations and admin adjustments all
// leave a trace of before/after stock so any discrepancy can be investigated.
// ===============================

const mongoose = require("mongoose");

const inventoryLogSchema = new mongoose.Schema(
    {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
        // Pack variant id when the change applied to a variant's stock, else null.
        variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        // Which field changed: "stock" (root) or "variants.$[].stock".
        scope: { type: String, enum: ["stock", "variant"], default: "stock" },
        // Negative = reserved/sold, positive = restocked/returned.
        change: { type: Number, required: true },
        previousStock: { type: Number, default: 0 },
        newStock: { type: Number, default: 0 },
        reason: {
            type: String,
            required: true,
            enum: [
                "order_placed", "order_cancelled", "admin_update", "variant_created",
                "variant_updated", "variant_status", "return_refund", "system"
            ]
        },
        // Optional linkage so an audit can jump to the order/return that caused it.
        order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
        changeRef: { type: String, default: null },
        // Who caused it (admin user id, or "customer:order" for self-service cancellations).
        changedByType: { type: String, enum: ["admin", "customer", "system"], default: "system" },
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        note: { type: String, default: null }
    },
    { timestamps: true }
);

// Admin lookup: stock movements per product, newest first.
inventoryLogSchema.index({ product: 1, createdAt: -1 });

module.exports = mongoose.model("InventoryLog", inventoryLogSchema);