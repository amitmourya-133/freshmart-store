// ===============================
// STOCK ALERT MODEL
// "Notify Me" subscriptions. One per (user, product): the user asked to be told
// when an out-of-stock product is back. On the next 0 -> available transition
// the alert flips to NOTIFIED exactly once (notification dedupe also guards).
// ===============================

const mongoose = require("mongoose");

const stockAlertSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        product: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Product",
            required: true,
            index: true,
        },
        productName: { type: String, trim: true, default: "" },
        status: {
            type: String,
            enum: ["WAITING", "NOTIFIED"],
            default: "WAITING",
            index: true,
        },
        notifiedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

// A user can subscribe to a product only once; re-subscribing is a no-op.
stockAlertSchema.index(
    { user: 1, product: 1 },
    { unique: true, partialFilterExpression: { status: "WAITING" } }
);

module.exports = mongoose.model("StockAlert", stockAlertSchema);