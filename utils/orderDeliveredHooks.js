// ===============================
// ORDER DELIVERED HOOKS
// Business side-effects that fire exactly once when an order reaches
// "Delivered" through the shared completion primitive (partner OTP path or
// admin manual completion). Each hook is fire-and-forget and must never fail
// the delivery request itself. side-effects:
//   * order_delivered analytics event
//   * first-qualifying-order referral reward (₹50, idempotent)
//   * repeat-order reminder for established customers
// ===============================

const analytics = require("./analytics");
const referral = require("./referral");
const reminders = require("./reminders");
const coPurchase = require("./coPurchase");

async function fireOrderDelivered(order) {
    if (!order || !order._id) return;
    try {
        analytics.track({
            eventName: "order_delivered",
            userId: order.user,
            orderId: String(order._id),
            metadata: {
                orderNumber: order.orderNumber,
                total: order.total,
                itemCount: Array.isArray(order.items) ? order.items.length : 0,
                paymentMethod: order.paymentMethod || "cod",
            },
        });
    } catch (e) { /* non-fatal */ }

    // Referral reward tied to a real, qualifying, first-time delivery.
    try {
        const result = await referral.applyReferralReward(order);
        if (result.rewarded) {
            analytics.track({
                eventName: "referral_reward",
                userId: result.referrerId,
                orderId: String(order._id),
                metadata: { amount: result.amount, type: "REFERRAL_REWARD" },
            });
        }
    } catch (e) { /* non-fatal */ }

    // Repeat-order reminder (deduped weekly, opt-out aware).
    try {
        await reminders.maybeRemindRepeatOrder(order);
    } catch (e) { /* non-fatal */ }

    // Co-purchase signal: feed the "Frequently Bought Together" model from
    // real delivered orders. Non-fatal; skips orders without product refs.
    try {
        await coPurchase.recordPairsFromOrder(order);
    } catch (e) { /* non-fatal */ }

    // WhatsApp delivered update (Phase 2.5): opt-in + provider-gated.
    try {
        const whatsapp = require("./whatsapp");
        const User = require("../models/User");
        const user = order.user ? await User.findById(order.user).lean() : null;
        await whatsapp.notifyOrderUpdate(order, "order_delivered", user);
    } catch (e) { /* non-fatal */ }
}

module.exports = { fireOrderDelivered };