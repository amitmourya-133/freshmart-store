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

// ATOMIC $inc that cannot race on the lazy wallet insert.
//
// The first credit for a user has to create the Wallet document, and the natural
// way to write that is a single `findOneAndUpdate({user}, {$inc}, {upsert})`.
// That is exactly where the money went missing: with `user` carrying a UNIQUE
// index, N concurrent first-time credits are N concurrent upserts against the
// same key. MongoDB resolves the insert race, but under real concurrency one
// increment can be dropped from the returned/applied update while the ledger
// row is still written - the customer is short one credit and the balance
// silently disagrees with the ledger (observed: 25 concurrent ₹100 credits
// produced a ₹2400 balance with 25 ledger rows).
//
// So existence and mutation are separated: create-if-missing first (the unique
// index makes losing racers a harmless no-op), then apply a plain atomic $inc to
// a document that is guaranteed to exist. A deleted-in-between wallet is
// re-created and retried instead of losing the money.
async function incrementWallet(userId, inc) {
    for (let attempt = 0; attempt < 3; attempt++) {
        await getOrCreateWallet(userId);
        const updated = await Wallet.findOneAndUpdate(
            { user: userId },
            Object.assign({ $inc: inc, $set: { lastActivityAt: new Date() } }),
            { new: true }
        );
        if (updated) return updated;
    }
    throw new Error("Wallet update failed after retries");
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

    // ATOMIC CREDIT. This used to read `wallet.balance`, add to it in JS and
    // `wallet.save()` the result. Two concurrent credits (a referral reward
    // plus a cashback, or the same webhook delivered twice in parallel) both
    // read the same starting balance, both wrote the same `nextBalance`, and
    // one credit vanished - while BOTH ledger rows recorded the same
    // `balanceAfter`. $inc lets MongoDB do the addition under the document lock,
    // so the balance can never be lost and balanceAfter is always the real
    // post-credit value.
    const updated = await incrementWallet(userId, { balance: money, totalCredited: money });

    let tx;
    try {
        tx = await WalletTransaction.create({
            user: userId,
            type: type,
            amount: money,
            balanceAfter: updated.balance,
            referenceType: referenceType || null,
            referenceId: referenceId ? String(referenceId).slice(0, 120) : null,
            description: String(description || "").slice(0, 240),
            createdBy: createdBy || "system",
        });
    } catch (err) {
        // Unique (type, referenceId) race lost -> someone else already paid it.
        // The $inc above already moved the money, so undo it here; otherwise
        // the loser of the race would leave the balance inflated with no
        // matching ledger row.
        if (err && err.code === 11000 && referenceType && referenceId) {
            await Wallet.updateOne(
                { user: userId },
                { $inc: { balance: -money, totalCredited: -money } }
            );
            const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
            return { created: false, tx: prior || null, wallet: await getOrCreateWallet(userId) };
        }
        throw err;
    }

    return { created: true, tx, wallet: updated };
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
        // Same compensation as credit(): the atomic $inc above already moved the
        // money, so a lost unique-index race has to put it back.
        if (err && err.code === 11000 && referenceType && referenceId) {
            await Wallet.updateOne(
                { user: userId },
                { $inc: { balance: money, totalDebited: -money } }
            );
            const prior = await WalletTransaction.findOne({ type: type, referenceId: String(referenceId) });
            return { created: false, tx: prior || null, wallet: await getOrCreateWallet(userId) };
        }
        throw err;
    }

    return { created: true, tx, wallet: updated };
}

module.exports = { getOrCreateWallet, credit, debit };