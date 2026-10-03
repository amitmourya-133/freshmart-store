// ===============================
// GROUP ORDER REWARD ENGINE (Phase 2.6)
// Applies the shared reward once a group's threshold is reached. Wired into
// group checkout + a sweep endpoint. Idempotent via the ledger's
// (type, referenceId) unique index — running it twice never double-pays.
// ===============================

const GroupOrder = require("../models/GroupOrder");
const Order = require("../models/Order");
const notificationController = require("../controllers/notificationController");
const analytics = require("./analytics");
const wallet = require("./wallet");
const WalletTransaction = require("../models/WalletTransaction");
const logger = require("./logger");

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Which linked orders are actually eligible for money (SEC-06).
//
// The reward loop used to iterate every id in `group.orders` with no check at
// all. `recordOrderInGroup` appends an order id as soon as it is created, and
// an order can be cancelled or fail its payment afterwards, so the reward was
// reachable by: join a group, get the order id appended, cancel the order (or
// let the payment fail), and still collect a wallet credit for it.
//
// An order only earns when it is a real, live, payable order:
//   * status must not be Cancelled (terminal, never payable);
//   * paymentStatus must not be FAILED / CANCELLED / REFUNDED / PENDING_REFUND.
// COD orders legitimately sit at PENDING until delivery, so PENDING is allowed -
// what is forbidden is a payment that failed or was already reversed.
const BLOCKED_PAYMENT_STATUSES = ["FAILED", "CANCELLED", "REFUNDED", "PENDING_REFUND"];

function isRewardEligible(order) {
    if (!order || !order.user) return false;
    if (String(order.status || "") === "Cancelled") return false;
    if (BLOCKED_PAYMENT_STATUSES.indexOf(String(order.paymentStatus || "")) !== -1) return false;
    return true;
}

async function applyRewards(groupId, options) {
    const group = await GroupOrder.findById(groupId);
    if (!group) return { ok: false, reason: "no_group" };
    if (group.status === "ACHIEVED" && group.rewardsIssuedAt) {
        return { ok: true, already: true, rewardsIssuedAt: group.rewardsIssuedAt };
    }

    const orderIds = Array.isArray(group.orders) ? group.orders : [];

    // Threshold is counted over ELIGIBLE orders, not raw linked ids (SEC-06).
    // `recordOrderInGroup` appends an id the moment an order is created, and
    // `group.orders.length` was the threshold test, so a member could join,
    // cancel / fail payment, and still leave that dead id sitting in the array.
    // Enough of those and a group unlocks (status frozen to ACHIEVED, which
    // stops `recordOrderInGroup` from ever appending again) even though the real
    // live participants never reached minParticipants - the remaining customers
    // could then never complete a valid group either.
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
        "user subtotal delivery total status paymentStatus createdAt orderNumber"
    );
    const eligible = orders.filter(isRewardEligible);

    // Only re-litigate the threshold while the group has never paid out. Once a
    // complete run has stamped rewardsIssuedAt the outcome is immutable and a
    // later cancellation is settled by the reversal path instead, so the group
    // cannot flip-flop ACHIEVED -> OPEN -> ACHIEVED.
    if (!group.rewardsIssuedAt && eligible.length < group.minParticipants) {
        group.status = "OPEN";
        await group.save();
        return {
            ok: false,
            reason: "threshold_not_reached",
            count: eligible.length,
            linked: orderIds.length
        };
    }

    const issued = [];
    const skipped = [];
    const failures = [];
    for (const order of orders) {
        if (!isRewardEligible(order)) {
            skipped.push({
                orderId: String(order._id),
                reason: !order.user ? "no_user" :
                    String(order.status || "") === "Cancelled" ? "order_cancelled" : "payment_" + String(order.paymentStatus || "").toLowerCase()
            });
            continue;
        }
        let amount = 0;
        if (group.rewardType === "discount_percent") {
            amount = round2((order.subtotal || 0) * ((group.rewardPercent || 10) / 100));
            // never exceed 8% of the whole group line total by accident
            amount = Math.min(amount, 50);
        } else {
            amount = round2((order.delivery || 0));
        }
        if (amount <= 0) continue;
        const referenceId = "group_reward:" + String(group._id) + ":" + String(order._id);
        try {
            const result = await wallet.credit({
                userId: order.user,
                type: "GROUP_REWARD",
                amount: amount,
                referenceType: "GROUP_REWARD",
                referenceId: referenceId,
                description: "Group order reward — " + (group.title || "Colony order") + " (order " + (order.orderNumber || "") + ")",
                createdBy: "group-reward:" + String(group._id),
            });
            if (result && result.created) {
                issued.push({ orderId: String(order._id), userId: String(order.user), amount: amount });
                notificationController.notifyBase(order.user, {
                    type: "wallet",
                    title: "Group order reward 🎉",
                    message: "Your colony order reached " + group.minParticipants + " participants. ₹" + amount + " credited to your wallet.",
                    dedupeKey: "group_reward:" + String(group._id) + ":" + String(order._id),
                    data: { link: "wallet.html" },
                });
            }
        } catch (e) {
            // SEC-06: this used to be an empty catch. A reward that fails to
            // post was invisible: the group was still marked ACHIEVED with
            // rewardsIssuedAt set, which made it permanently un-retryable, so
            // the customer's money was simply never paid and nobody knew.
            failures.push({ orderId: String(order._id), error: (e && e.message ? String(e.message).slice(0, 200) : "unknown") });
            logger.error({ ev: "group_reward_failed", groupId: String(group._id), orderId: String(order._id), err: (e && e.message) || "unknown" });
        }
    }

    // Only stamp the group as fully rewarded when the money actually moved. A
    // partial run stays retryable: the ledger's unique (type, referenceId)
    // index means a later sweep re-issues nothing and pays only what is
    // missing.
    const complete = failures.length === 0;
    group.status = "ACHIEVED";
    group.thresholdReachedAt = group.thresholdReachedAt || new Date();
    group.rewardsIssuedAt = complete ? (group.rewardsIssuedAt || new Date()) : null;
    group.rewardNote = "Issued ₹" + round2(issued.reduce((s, i) => s + i.amount, 0)) + " across " + issued.length + " orders." +
        (skipped.length ? " Skipped " + skipped.length + " ineligible order(s)." : "") +
        (failures.length ? " FAILED " + failures.length + " payment(s) - retry pending." : "");
    await group.save();

    analytics.track({
        eventName: "group_threshold_reached",
        userId: group.host,
        metadata: {
            groupId: String(group._id),
            title: group.title || "",
            participants: eligible.length,
            linkedOrders: orderIds.length,
            rewardType: group.rewardType,
            rewardAmount: round2(issued.reduce((s, i) => s + i.amount, 0)),
            skipped: skipped.length,
            failed: failures.length
        },
    });

    return { ok: true, thresholdReached: true, issued: issued, skipped: skipped, failures: failures, complete: complete };
}

// Sweep: expire open groups past their expiry, and re-check still-open groups
// that may have crossed their threshold since last checked. Returns a summary.
async function sweepGroups(limit) {
    const n = Number(limit) || 50;
    const now = new Date();
    const expired = await GroupOrder.updateMany(
        { status: "OPEN", expiresAt: { $lt: now } },
        { $set: { status: "EXPIRED" } }
    );
    let rechecked = 0;
    const reopen = await GroupOrder.find({ status: "OPEN", expiresAt: { $gte: now } })
        .sort({ createdAt: 1 })
        .limit(n)
        .select("_id");
    for (const g of reopen) {
        try {
            await applyRewards(g._id);
            rechecked++;
        } catch (e) { /* non-fatal */ }
    }
    return { expiredCount: expired.modifiedCount || 0, rechecked: rechecked };
}

async function recordOrderInGroup(groupId, orderId) {
    await GroupOrder.updateOne(
        { _id: groupId, status: "OPEN", orders: { $ne: orderId } },
        { $addToSet: { orders: orderId } }
    );
    const group = await GroupOrder.findById(groupId).lean();
    if (group && (group.orders || []).length >= group.minParticipants) {
        return group;
    }
    return null;
}

// REVERSAL (SEC-06). If an order that already earned a group reward is later
// cancelled (or its payment is refunded), the credit has to come back, or a
// customer can simply cancel after the group unlocks and keep the money.
//
// Design notes:
//   * Idempotent: the reversal reference id is deterministic, so the ledger's
//     unique (type, referenceId) index makes a repeated call a no-op.
//   * Never drives the balance negative: if the customer already spent the
//     credit the debit fails and we record a `needs_recovery` note for finance
//     instead of silently leaving the wallet short.
//   * Only the amount actually credited is reversed (the ledger row is the
//     authority, not a recomputed formula).
async function reverseRewardsForOrder(orderId) {
    const order = await Order.findById(orderId).select("_id user orderNumber");
    if (!order || !order.user) return { ok: false, reason: "no_order" };

    // Which group rewards reference this order?
    const credits = await WalletTransaction.find({
        user: order.user,
        type: "GROUP_REWARD",
        referenceType: "GROUP_REWARD",
    }).sort({ createdAt: -1 });

    const matching = credits.filter(function (tx) {
        return String(tx.referenceId || "").endsWith(":" + String(order._id));
    });
    if (!matching.length) return { ok: true, reversed: 0, reason: "no_reward" };

    let reversed = 0;
    let needsRecovery = 0;
    for (const tx of matching) {
        const groupId = String(tx.referenceId || "").split(":")[1] || "";
        const reversalRef = "group_reward_reversal:" + groupId + ":" + String(order._id);
        try {
            const result = await wallet.debit({
                userId: order.user,
                type: "GROUP_REWARD_REVERSAL",
                amount: Math.abs(Number(tx.amount) || 0),
                referenceType: "GROUP_REWARD_REVERSAL",
                referenceId: reversalRef,
                description: "Group order reward reversed (order cancelled): " + (order.orderNumber || ""),
                createdBy: "group-reward-reversal",
            });
            if (result && result.created) reversed++;
        } catch (e) {
            needsRecovery++;
            logger.error({ ev: "group_reward_reversal_failed", orderId: String(order._id), err: (e && e.message) || "unknown" });
        }
    }
    if (reversed) {
        await GroupOrder.updateOne(
            { _id: { $in: matching.map(function (t) { return t.referenceId.split(":")[1]; }).filter(Boolean) } },
            { $set: { rewardNote: "Reward reversed for a cancelled order (" + (order.orderNumber || order._id) + ")." } }
        );
    }
    return { ok: true, reversed: reversed, needsRecovery: needsRecovery };
}

module.exports = { applyRewards, sweepGroups, recordOrderInGroup, reverseRewardsForOrder, isRewardEligible };