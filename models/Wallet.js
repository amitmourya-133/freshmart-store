// ===============================
// WALLET MODEL
// A customer's spendable balance. Money only ever moves through the immutable
// WalletTransaction ledger; this document is just the denormalized running
// balance so reads stay cheap. Created lazily on first credit.
// ===============================

const mongoose = require("mongoose");

const walletSchema = new mongoose.Schema(
    {
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            unique: true,
            index: true,
        },
        balance: { type: Number, default: 0, min: 0 },
        currency: { type: String, default: "INR" },
        // Tallies kept server-side for admin/reporting convenience.
        totalCredited: { type: Number, default: 0 },
        totalDebited: { type: Number, default: 0 },
        lastActivityAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("Wallet", walletSchema);