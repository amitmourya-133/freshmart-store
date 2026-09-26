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
        comment: { type: String, required: true, trim: true, maxlength: 800 },
        // Moderation lifecycle. New customer reviews are created PENDING and
        // only become public after a moderator approves them. Legacy reviews
        // created before moderation existed carry no value; the public listing
        // treats a missing value as APPROVED so nothing disappears.
        moderationStatus: {
            type: String,
            enum: ["PENDING", "APPROVED", "REJECTED", "HIDDEN"],
            default: "APPROVED"
        },
        moderatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        moderatedAt: { type: Date, default: null },
        moderationNote: { type: String, default: null },
        // Customer edits re-queue the review: edited reviews go back to PENDING
        // so the new text is re-checked before re-entering the public rating.
        edited: { type: Boolean, default: false },
        editedAt: { type: Date, default: null }
    },
    { timestamps: true }
);

module.exports = mongoose.model("Review", reviewSchema);