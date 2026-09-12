// ===============================
// REVIEW MODEL
// ===============================

const mongoose = require("mongoose");

const reviewSchema = new mongoose.Schema(
    {
        product: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
        productName: { type: String, index: true },
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        userName: { type: String, default: "Anonymous" },
        rating: { type: Number, required: true, min: 1, max: 5 },
        comment: { type: String, required: true, trim: true, maxlength: 800 }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Review", reviewSchema);