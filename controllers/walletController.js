// ===============================
// WALLET CONTROLLER
// Customer: balance + immutable transaction history (own wallet only).
// Admin: credit an account (idempotent via optional referenceId) + totals.
// ===============================

const Wallet = require("../models/Wallet");
const { safeErrorMessage } = require("../utils/safeError");
const WalletTransaction = require("../models/WalletTransaction");
const wallet = require("../utils/wallet");

function isBadObjectId(id) {
    return !(require("mongoose").Types.ObjectId.isValid(String(id || "")));
}

// GET /api/wallet — my balance + recent ledger.
exports.getMyWallet = async (req, res) => {
    try {
        const w = await wallet.getOrCreateWallet(req.user._id);
        const recent = await WalletTransaction.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .limit(20);
        return res.json({
            success: true,
            data: {
                balance: Math.round(w.balance * 100) / 100,
                currency: w.currency,
                totalCredited: Math.round(w.totalCredited * 100) / 100,
                totalDebited: Math.round(w.totalDebited * 100) / 100,
                recentTransactions: recent,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET /api/wallet/transactions?limit&skip — paginated ledger (own wallet).
exports.getMyTransactions = async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
        const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
        const total = await WalletTransaction.countDocuments({ user: req.user._id });
        const rows = await WalletTransaction.find({ user: req.user._id })
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit);
        return res.json({ success: true, total, count: rows.length, data: rows });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/admin/wallet/credit — admin credits a customer wallet.
exports.adminCredit = async (req, res) => {
    try {
        const { userId, amount, description, referenceId } = req.body || {};
        if (!userId || isBadObjectId(userId)) {
            return res.status(400).json({ success: false, message: "Valid userId required" });
        }
        if (!Number.isFinite(Number(amount)) || Number(amount) <= 0) {
            return res.status(400).json({ success: false, message: "Amount must be a positive number" });
        }
        const target = await require("../models/User").findById(userId);
        if (!target) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        const result = await wallet.credit({
            userId,
            type: "ADMIN_CREDIT",
            amount: Number(amount),
            referenceType: referenceId ? "AdminCredit" : null,
            referenceId: referenceId ? "admin_credit:" + String(referenceId) : null,
            description: String(description || "Admin credit").slice(0, 240),
            createdBy: "admin:" + String(req.user._id),
        });
        return res.json({
            success: true,
            created: result.created,
            data: { balance: Math.round(result.wallet.balance * 100) / 100, transaction: result.tx },
            message: result.created ? "Wallet credited" : "Already applied (idempotent)",
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET /api/admin/wallet/overview — balances + totals for admins.
exports.adminOverview = async (req, res) => {
    try {
        const [rows, totals] = await Promise.all([
            Wallet.find({ balance: { $gt: 0 } }).sort({ balance: -1 }).limit(50).populate("user", "name email phone"),
            Wallet.aggregate([
                { $group: { _id: null, totalBalance: { $sum: "$balance" }, wallets: { $sum: 1 } } },
            ]),
        ]);
        const t = totals[0];
        return res.json({
            success: true,
            data: {
                totalBalance: t ? Math.round(t.totalBalance * 100) / 100 : 0,
                fundedWallets: t ? t.wallets : 0,
                topWallets: rows.map((w) => ({
                    user: w.user ? { name: w.user.name, email: w.user.email, phone: w.user.phone } : null,
                    balance: round2(w.balance),
                    lastActivityAt: w.lastActivityAt,
                })),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

function round2(n) { return Math.round(n * 100) / 100; }