// ===============================
// WALLET TRANSACTION MODEL
// Immutable wallet ledger. Every credit/debit is one document; the Wallet
// document's balance is derived from these entries only. referenceId makes
// reward payments idempotent: the same (type, referenceId) can never pay twice.
// ===============================

const mongoose = require("mongoose");

const walletTxSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        type: {
            type: String,
            required: true,
            enum: [
                "REFERRAL_REWARD", "CASHBACK", "REFUND", "WALLET_DEBIT",
                "ADMIN_CREDIT",
                // SEC-06: the group-reward engine has always issued
                // "GROUP_REWARD" (and now "GROUP_REWARD_REVERSAL"), but neither
                // value was in this enum. Every credit therefore failed schema
                // validation, the error was swallowed by the caller, and the
                // group was still marked ACHIEVED - so customers silently never
                // received their colony reward. Adding the two values is purely
                // additive: no existing document changes, and documents that
                // already carry other types are untouched.
                "GROUP_REWARD", "GROUP_REWARD_REVERSAL"
            ],
        },
        amount: { type: Number, required: true },
        balanceAfter: { type: Number, default: 0 },
        // Optional link to the source event (order/referral/task reference ids).
        referenceType: { type: String, default: null },
        referenceId: { type: String, default: null },
        description: { type: String, trim: true, maxlength: 240, default: "" },
        createdBy: { type: String, default: null }, // e.g. "system", "admin:<id>", "user:<id>"
    },
    { timestamps: true }
);

// One reward per (type, referenceId) - protects referral / cashback / refund
// payments from double-application on retried requests.
walletTxSchema.index(
    { type: 1, referenceId: 1 },
    { unique: true, partialFilterExpression: { referenceId: { $type: "string" } } }
);

walletTxSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("WalletTransaction", walletTxSchema);