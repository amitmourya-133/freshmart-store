'use strict';
// ===============================
// CO-PURCHASE MODEL
// Unordered (a, b) pairs observed together in a delivered order. The pair is
// stored canonically (a < b by string compare) with a monotonically increasing
// count, so "Frequently Bought Together" can be read in one indexed lookup.
// Rebuilt transactionally after every delivery (see utils/coPurchase.js).
// ===============================

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const coPurchaseSchema = new mongoose.Schema(
    {
        a: { type: ObjectId, ref: "Product", required: true },
        b: { type: ObjectId, ref: "Product", required: true },
        count: { type: Number, default: 1, min: 1 },
        lastSeenAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

// One row per unordered pair; a < b so (b,a) never stores a duplicate.
coPurchaseSchema.index({ a: 1, b: 1 }, { unique: true });
// Reads query partner products for a given product: index both columns.
coPurchaseSchema.index({ a: 1, count: -1 });
coPurchaseSchema.index({ b: 1, count: -1 });

module.exports = mongoose.model("CoPurchase", coPurchaseSchema);