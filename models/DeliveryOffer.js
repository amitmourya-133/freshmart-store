// ===============================
// DELIVERY OFFER MODEL
// One broadcast round of a real order to every online delivery partner.
// First partner to claim it wins (Phase 2). If nobody claims before the TTL,
// the offer EXPIRES (or, when auto-assign is enabled, the nearest online
// partner is assigned automatically - Phase 4).
// The offer is the coordination record: it never invents work, it only
// advertises an order that really exists.
// ===============================

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const deliveryOfferSchema = new mongoose.Schema(
    {
        order: { type: ObjectId, ref: "Order", required: true, index: true },
        // Round number lets a re-broadcast (new partner, new zone) be traced.
        round: { type: Number, default: 1, min: 1 },
        status: {
            type: String,
            enum: ["OPEN", "CLAIMED", "EXPIRED", "CANCELLED", "ASSIGNED"],
            default: "OPEN",
            index: true,
        },
        mode: { type: String, enum: ["broadcast", "auto"], default: "broadcast" },
        ttlSeconds: { type: Number, default: 90, min: 15 },
        // End of the partner claim window.
        expiresAt: { type: Date, required: true, index: true },
        // Earliest moment the auto-assigner may intervene. Gives partners a
        // grace period to claim voluntarily before a rider is forced onto the
        // order. Only set when auto-assign is switched on.
        autoAssignAt: { type: Date, index: true },
        // Winner of the claim race. "raced" records an offer that the expiry
        // sweep closed after losing the race to an already-existing assignment.
        claimedBy: { type: ObjectId, ref: "User" },
        claimedAt: { type: Date },
        claimSource: { type: String, enum: ["partner", "admin", "auto", "raced"], default: "partner" },
        // The assignment created by the claim (or by the auto-assigner).
        assignment: { type: ObjectId, ref: "DeliveryAssignment" },
        // Delivery destination snapshot (used to rank partners by distance).
        zone: { type: String, trim: true, maxlength: 60 },
        distanceKm: { type: Number },
        // Who was told about this offer and over which channel.
        notified: [
            {
                user: { type: ObjectId, ref: "User" },
                at: { type: Date, default: Date.now },
                inApp: { type: Boolean, default: false },
                push: { type: Boolean, default: false },
            },
        ],
        // Partners who explicitly declined: never re-notified in this round.
        declinedBy: [{ type: ObjectId, ref: "User" }],
        expiresHandledAt: { type: Date },
    },
    { timestamps: true }
);

deliveryOfferSchema.index({ order: 1, round: 1 });
// Sweep query: open offers whose claim window closed or whose auto-assign
// grace period elapsed.
deliveryOfferSchema.index({ status: 1, expiresAt: 1 });
deliveryOfferSchema.index({ status: 1, autoAssignAt: 1 });
// A partner's open-offer feed.
deliveryOfferSchema.index({ status: 1, notified: 1 });

module.exports = mongoose.model("DeliveryOffer", deliveryOfferSchema);
