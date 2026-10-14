// ===============================
// STORE-CREDIT REFUND SERVICE
// ===============================
//
// One shared path for "the money goes back into the customer's wallet".
//
// Why this exists: refunds could be recorded on an Order/ReturnRequest as
// `store_credit` without any wallet credit ever happening - the ledger said
// "refunded" while the customer's balance never moved (BIZ-01).
//
// Every caller MUST pass a (referenceType, referenceId) pair that uniquely
// identifies the refund event. The wallet ledger's unique (type, referenceId)
// index then makes the credit exactly-once under retries, duplicate admin
// clicks, webhook replays and concurrent requests:
//   * order-level refunds  -> ("order",  "<orderId>")
//   * return-level refunds -> ("return", "<returnId>")
// A retried refund for the same event returns { created: false } and moves
// no money.
//
// The credit happens BEFORE the caller persists its "REFUNDED" state. If the
// process dies in between, the state still says PAID/PENDING_REFUND and a
// retry re-runs the (idempotent) credit - never the other way around, which
// would record a refund that never paid out.

const wallet = require("./wallet");
const logger = require("./logger");

const REFUND_TYPE = "REFUND";

function normalizeAmount(amount) {
    const n = Number(amount);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.round(n * 100) / 100;
}

/**
 * Credit a customer's wallet for a store-credit refund, exactly once.
 *
 * Returns:
 *   { ok: true,  created: boolean, amount, tx }   - credited (or already credited)
 *   { ok: false, reason: "no_account" }           - no user/wallet can receive it
 *   { ok: false, reason: "invalid_amount" }       - non-positive / non-finite amount
 *   { ok: false, reason: "missing_reference" }    - caller omitted the idempotency key
 *
 * Throws only on real infrastructure/ledger failures - callers treat a throw
 * as "refund NOT delivered, safe to retry".
 */
async function creditStoreCredit({ userId, amount, referenceType, referenceId, description, createdBy }) {
    const money = normalizeAmount(amount);
    if (money === null) {
        return { ok: false, reason: "invalid_amount", created: false, amount: 0 };
    }
    if (!userId) {
        return { ok: false, reason: "no_account", created: false, amount: 0 };
    }
    if (!referenceType || !referenceId) {
        // Never issue an unkeyed refund credit: without the idempotency key a
        // retry would double-credit.
        return { ok: false, reason: "missing_reference", created: false, amount: 0 };
    }

    const result = await wallet.credit({
        userId: userId,
        type: REFUND_TYPE,
        amount: money,
        referenceType: String(referenceType),
        referenceId: String(referenceId),
        description: description || "Store credit refund",
        createdBy: createdBy || "system",
    });

    if (result.created) {
        logger.info({
            ev: "store_credit_issued",
            reference: String(referenceType) + ":" + String(referenceId),
            userId: String(userId),
            amount: money,
        });
    }
    return { ok: true, created: !!result.created, amount: money, tx: result.tx || null };
}

module.exports = { creditStoreCredit, normalizeAmount };
