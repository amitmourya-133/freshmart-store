// ===============================
// WALLET LEDGER SERVICE
// Server-side-only wallet operations. Credits/debits are represented by a
// single immutable WalletTransaction + an atomically maintained Wallet balance.
// The unique (type, referenceId) index makes one-time payments (referral
// rewards, cashback, refunds) idempotent under retries or duplicate webhooks.
// ===============================

const Wallet = require("../models/Wallet");
const WalletTransaction = require("../models/WalletTransaction");

async function getOrCreateWallet(userId) {
    return Wallet.findOneAndUpdate(
        { user: userId },
        { $setOnInsert: { user: userId } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

// Credit a wallet with a positive amount. Pass referenceType/referenceId to
// make the payment idempotent: a repeated credit for the same
// (type, referenceId) returns the earlier transaction without double-paying.
// Returns { created: boolean, tx, wallet }.
async function credit({ userId, type, amount, referenceType, referenceId, description, createdBy }) {
    if (!userId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        throw Object.assign(new Error("Invalid wallet credit amount"), { status: 400 });
    }
    const money = Math.round(Number(amount) * 100) / 100;

    // Idempotency: when a reference exists, any already-recorded payment for
    // the same (type, referenceId) is the canonical outcome.
    if (referenceType && referenceId) {
        const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
        if (prior) {
            return { created: false, tx: prior, wallet: await getOrCreateWallet(userId) };
        }
    }

    const wallet = await getOrCreateWallet(userId);
    const nextBalance = Math.round((wallet.balance + money) * 100) / 100;

    let tx;
    try {
        tx = await WalletTransaction.create({
            user: userId,
            type: type,
            amount: money,
            balanceAfter: nextBalance,
            referenceType: referenceType || null,
            referenceId: referenceId ? String(referenceId).slice(0, 120) : null,
            description: String(description || "").slice(0, 240),
            createdBy: createdBy || "system",
        });
    } catch (err) {
        // Unique (type, referenceId) race lost -> someone else already paid it.
        if (err && err.code === 11000 && referenceType && referenceId) {
            const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
            return { created: false, tx: prior || null, wallet: await getOrCreateWallet(userId) };
        }
        throw err;
    }

    wallet.balance = nextBalance;
    wallet.totalCredited = Math.round((wallet.totalCredited + money) * 100) / 100;
    wallet.lastActivityAt = new Date();
    await wallet.save();

    return { created: true, tx, wallet };
}

// Debit a wallet (e.g. WALLET_DEBIT). Fails if the balance is not sufficient.
async function debit({ userId, type, amount, referenceType, referenceId, description, createdBy }) {
    if (!userId || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
        throw Object.assign(new Error("Invalid wallet debit amount"), { status: 400 });
    }
    const money = Math.round(Number(amount) * 100) / 100;

    if (referenceType && referenceId) {
        const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
        if (prior) {
            return { created: false, tx: prior, wallet: await getOrCreateWallet(userId) };
        }
    }

    const wallet = await getOrCreateWallet(userId);
    const updated = await Wallet.findOneAndUpdate(
        { user: userId, balance: { $gte: money } },
        { $inc: { balance: -money, totalDebited: money }, $set: { lastActivityAt: new Date() } },
        { new: true }
    );
    if (!updated) {
        throw Object.assign(new Error("Insufficient wallet balance"), { status: 400 });
    }

    let tx;
    try {
        tx = await WalletTransaction.create({
            user: userId,
            type: type,
            amount: -money,
            balanceAfter: updated.balance,
            referenceType: referenceType || null,
            referenceId: referenceId ? String(referenceId).slice(0, 120) : null,
            description: String(description || "").slice(0, 240),
            createdBy: createdBy || "system",
        });
    } catch (err) {
        if (err && err.code === 11000 && referenceType && referenceId) {
            const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
            return { created: false, tx: prior || null, wallet: updated };
        }
        throw err;
    }

    return { created: true, tx, wallet: updated };
}

module.exports = { getOrCreateWallet, credit, debit };