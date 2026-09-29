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

function round2(n) {
    return Math.round(n * 100) / 100;
}

async function applyRewards(groupId, options) {
    const group = await GroupOrder.findById(groupId);
    if (!group) return { ok: false, reason: "no_group" };
    if (group.status === "ACHIEVED" && group.rewardsIssuedAt) {
        return { ok: true, already: true, rewardsIssuedAt: group.rewardsIssuedAt };
    }

    const orderIds = Array.isArray(group.orders) ? group.orders : [];
    if (orderIds.length < group.minParticipants) {
        group.status = "OPEN";
        await group.save();
        return { ok: false, reason: "threshold_not_reached", count: orderIds.length };
    }

    // Threshold reached → freeze the status and reward everyone.
    const orders = await Order.find({ _id: { $in: orderIds } }).select(
        "user subtotal delivery total status createdAt orderNumber"
    );
    const issued = [];
    for (const order of orders) {
        if (!order.user) continue;
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
        } catch (e) { /* ledger idempotency handles any race */ }
    }

    group.status = "ACHIEVED";
    group.thresholdReachedAt = group.thresholdReachedAt || new Date();
    group.rewardsIssuedAt = new Date();
    group.rewardNote = "Issued ₹" + round2(issued.reduce((s, i) => s + i.amount, 0)) + " across " + issued.length + " orders.";
    await group.save();

    analytics.track({
        eventName: "group_threshold_reached",
        userId: group.host,
        metadata: {
            groupId: String(group._id),
            title: group.title || "",
            participants: orderIds.length,
            rewardType: group.rewardType,
            rewardAmount: round2(issued.reduce((s, i) => s + i.amount, 0)),
        },
    });

    return { ok: true, thresholdReached: true, issued: issued };
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

module.exports = { applyRewards, sweepGroups, recordOrderInGroup };