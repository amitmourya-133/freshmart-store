// ===============================
// PRODUCT MODEL
// ===============================

const mongoose = require("mongoose");

// Selling-unit variant (e.g. "500g", "1kg"). Products that sell in fixed
// pack sizes list them here; the legacy root price/unit/stock stays usable as
// the fallback for weight-multiplier pricing (e.g. loose "per kg" produce).
const variantSchema = new mongoose.Schema(
    {
        unit: { type: String, required: true, trim: true, maxlength: 24 },
        price: { type: Number, required: true, min: 0 },
        stock: { type: Number, default: 0, min: 0 },
        active: { type: Boolean, default: true }
    },
    { timestamps: false }
);

const productSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        price: { type: Number, required: true, min: 0 },
        unit: { type: String, default: "kg" },
        category: { type: String, required: true, index: true },
        emoji: { type: String, default: "🥬" },
        gradient: { type: String, default: "linear-gradient(135deg, #56ab2f, #a8e063)" },
        description: { type: String, default: "" },
        nutrition: { type: String, default: "" },
        tips: { type: String, default: "" },
        origin: { type: String, default: "" },
        stock: { type: Number, default: 50, min: 0 },
        active: { type: Boolean, default: true },
        rating: { type: Number, default: 4.0, min: 0, max: 5 },
        ratingCount: { type: Number, default: 1 },
        image: { type: String, default: "" },
        // Pack-size variants (empty = classic weight-multiplier product).
        variants: { type: [variantSchema], default: [] }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
