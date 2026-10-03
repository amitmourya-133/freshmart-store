// ===============================
// B2B CREDIT LEASE (SEC-05)
// ===============================
// One document per B2B buyer that acts as a short, expiring mutex around the
// "check credit -> reserve stock -> create the credit order" window.
//
// Why this exists: the credit check is an AGGREGATE over the buyer's existing
// orders (creditUsedFor). The old sequence was
//     aggregate -> compare to limit -> reserve stock -> Order.create
// which means two simultaneous orders both read the same exposure, both passed
// the comparison, and both were persisted - so a buyer with a ₹1,00,000 limit
// could place many more than ₹1,00,000 of goods on credit simply by firing
// several requests in parallel.
//
// A `CreditLease` row per buyer turns that window into a critical section: the
// aggregate is re-read while the lease is held, so the second request sees the
// first order. It is deliberately NOT a cached counter, because a cached
// counter has to be decremented on every cancellation/refund path and any
// missed decrement permanently locks a customer out. The order collection stays
// the single source of truth, so there is nothing to drift and nothing to
// migrate.
//
// It also needs no MongoDB transactions, so it behaves identically on a
// standalone mongod (the local dev/CI database) and on Atlas.
//
// Safety properties:
//   * the lease carries an expiry, so a crashed process can never wedge a buyer
//     - the worst case is a few seconds of waiting;
//   * release is best-effort and always scoped to our own owner token, so a
//     slow request can never release someone else's lease;
//   * a busy lease is retried briefly and then answered 409 instead of hanging.

const mongoose = require("mongoose");

const LEASE_MS = Math.max(1000, Number(process.env.B2B_CREDIT_LEASE_MS) || 8000);
const WAIT_MS = Math.max(200, Number(process.env.B2B_CREDIT_LEASE_WAIT_MS) || 2500);

const creditLeaseSchema = new mongoose.Schema(
    {
        buyer: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, unique: true },
        owner: { type: String, default: null },
        expiresAt: { type: Date, default: new Date(0) }
    },
    { timestamps: true }
);

creditLeaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const CreditLease = mongoose.models.CreditLease || mongoose.model("CreditLease", creditLeaseSchema);

function newToken() {
    return String(process.pid) + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

// Try once to take the lease. Returns our token on success, null if someone
// else holds a live one.
async function tryAcquire(buyerId, token) {
    const now = new Date();
    const lease = await CreditLease.findOneAndUpdate(
        {
            buyer: buyerId,
            $or: [{ expiresAt: { $lte: now } }, { owner: token }, { owner: null }]
        },
        { $set: { owner: token, expiresAt: new Date(now.getTime() + LEASE_MS) } },
        { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (!lease) return null;
    return String(lease.owner) === token ? token : null;
}

async function acquire(buyerId, waitMs) {
    const token = newToken();
    const deadline = Date.now() + (waitMs == null ? WAIT_MS : waitMs);
    let delay = 25;
    for (;;) {
        let won = null;
        try {
            won = await tryAcquire(buyerId, token);
        } catch (e) {
            // Concurrent upsert: the unique (buyer) index made someone else win
            // this microsecond. That is a normal race, not an error.
            if (e && e.code === 11000) won = null;
            else throw e;
        }
        if (won) return token;
        if (Date.now() >= deadline) return null;
        await new Promise(function (r) { setTimeout(r, delay); });
        delay = Math.min(delay * 2, 250);
    }
}

async function release(buyerId, token) {
    if (!token) return;
    try {
        await CreditLease.updateOne(
            { buyer: buyerId, owner: token },
            { $set: { owner: null, expiresAt: new Date(0) } }
        );
    } catch (e) { /* best effort: the lease expires on its own */ }
}

// Runs `fn` while holding the buyer's credit lease. Throws a 409-style error
// when the lease cannot be taken within the wait budget.
async function withCreditLease(buyerId, fn) {
    const token = await acquire(buyerId);
    if (!token) {
        throw Object.assign(
            new Error("Another order for your account is being placed right now. Please retry in a moment."),
            { status: 409 }
        );
    }
    try {
        return await fn();
    } finally {
        await release(buyerId, token);
    }
}

module.exports = { withCreditLease, acquire, release, LEASE_MS, WAIT_MS };