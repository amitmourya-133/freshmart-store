// ===============================
// PRODUCT MODEL
// ===============================

const mongoose = require("mongoose");

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
        ratingCount: { type: Number, default: 1 }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Product", productSchema);
