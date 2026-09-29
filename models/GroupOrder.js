// ===============================
// GROUP / COLONY ORDER MODEL (Phase 2.6)
// Neighbours coordinate to hit a participants threshold and share a real
// reward. Design rules:
//   * Everyone owns their own individual Order + payment (group orders never
//     merge carts or payment records).
//   * The reward is applied by the server AFTER the threshold is reached, as an
//     idempotent wallet credit ("GROUP_REWARD") per linked order — no order or
//     invoice is ever retroactively rewritten.
//   * Rewards are capped and auditable; a group can never unlock more than what
//     the admin-configured reward declares.
// ===============================

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const groupOrderSchema = new mongoose.Schema(
    {
        host: { type: ObjectId, ref: "User", required: true },
        title: { type: String, required: [true, "Group title is required"], trim: true, maxlength: 90 },
        description: { type: String, default: "", trim: true, maxlength: 300 },
        area: { type: String, trim: true, maxlength: 60 },
        minParticipants: { type: Number, required: true, min: 2, max: 100 },
        maxParticipants: { type: Number, required: true, min: 2, max: 200 },
        rewardType: { type: String, enum: ["discount_percent", "free_delivery"], default: "free_delivery" },
        // For discount_percent: the cap is 25%; the wallet credit is discounted
        // from the member's OWN order subtotal only.
        rewardPercent: { type: Number, default: 10, min: 1, max: 25 },
        expiresAt: { type: Date, required: true },
        status: {
            type: String,
            enum: ["OPEN", "ACHIEVED", "EXPIRED", "CLOSED"],
            default: "OPEN",
        },
        participants: [
            {
                user: { type: ObjectId, ref: "User", required: true },
                joinedAt: { type: Date, default: Date.now },
            },
        ],
        // Orders that physically bought into the group (each is an individual,
        // real order). Threshold counts these.
        orders: [{ type: ObjectId, ref: "Order" }],
        thresholdReachedAt: { type: Date, default: null },
        rewardsIssuedAt: { type: Date, default: null },
        rewardNote: { type: String, default: "", trim: true, maxlength: 400 },
    },
    { timestamps: true }
);

groupOrderSchema.index({ status: 1, expiresAt: 1 });
groupOrderSchema.index({ createdAt: -1 });

module.exports = mongoose.model("GroupOrder", groupOrderSchema);