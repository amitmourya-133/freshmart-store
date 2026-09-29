// ===============================
// AUTOPAY MANDATE MODEL (Phase 3.9)
// A UPI e-mandate the customer explicitly authorizes for recurring charges on
// a subscription. Consent + idempotent provider references only - a mandate
// NEVER stores a UPI PIN, bank account number or any credential. The provider
// leg (WhatsApp Business-style abstraction) is documented in utils/autopay.js;
// without a configured provider a mandate is never "active" and no charge is
// ever pretended to have succeeded.
// ===============================

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const autopayMandateSchema = new mongoose.Schema(
    {
        user: { type: ObjectId, ref: "User", required: true },
        // The subscription this mandate funds (optional until one is linked).
        subscription: { type: ObjectId, ref: "UserSubscription", default: null },
        plan: { type: ObjectId, ref: "SubscriptionPlan", default: null },
        // customer-facing state machine:
        //   PENDING_AUTHORIZATION -> ACTIVE            (provider confirmed)
        //   PENDING_AUTHORIZATION -> REJECTED          (provider refused, no credential stored)
        //   ACTIVE               -> CANCELLED          (owner cancel)
        //   PENDING_AUTHORIZATION/ACTIVE -> BLOCKED_PROVIDER (env not configured - honest)
        //   ACTIVE               -> EXPIRED
        status: {
            type: String,
            enum: ["PENDING_AUTHORIZATION", "ACTIVE", "REJECTED", "CANCELLED", "BLOCKED_PROVIDER", "EXPIRED"],
            default: "PENDING_AUTHORIZATION",
        },
        // The raw expAction the customer agreed to (charged per subscription cycle).
        chargeAmount: { type: Number, min: 0, default: 0 },
        frequencyDays: { type: Number, min: 1, max: 366, default: 30 },
        expiresAt: { type: Date },
        // Provider references (opaque; provider.comes from env, never user input).
        provider: { type: String, default: null },
        providerMandateId: { type: String, trim: true, default: null },
        // Consent disclosures recorded at creation (audit).
        consentAcceptedAt: { type: Date },
        consentInfo: { type: String, trim: true, maxlength: 300 },
        // Bank detail redaction: last 4 only, optional, never the full number.
        bankAccountLast4: { type: String, match: [/^\d{4}$/, "bankAccountLast4 must be exactly 4 digits"], default: null },
        // Failure accounting: a mandate with 3 consecutive failures is blocked.
        consecutiveFailures: { type: Number, default: 0, min: 0 },
        lastChargeAt: { type: Date },
        lastChargeResult: {
            status: { type: String, enum: ["success", "failed", "rejected", "blocked"], default: null },
            at: { type: Date },
            reason: { type: String, trim: true, maxlength: 200 },
        },
    },
    { timestamps: true }
);

autopayMandateSchema.index({ user: 1, status: 1 });
autopayMandateSchema.index({ status: 1 });

module.exports = mongoose.model("AutopayMandate", autopayMandateSchema);