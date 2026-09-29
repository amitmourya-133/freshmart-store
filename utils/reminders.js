// ===============================
// REPEAT-ORDER REMINDER ENGINE
// After an order is Delivered, we gently remind established customers to order
// again so they never have to remember FreshMart. Rules (server-enforced):
//   * only for logged-in users with a previous delivered order (repeat buyers)
//   * the recipient may opt out (User.reminderOptOut)
//   * at most one reminder per ISo-week per user (dedupeKey drives the unique
//     (user, dedupeKey) notification index)
//   * no reminder while a recent (7d) order is still active or just cancelled
//   * conversion is recorded when a reminded user orders a reminded product
// ===============================

const Order = require("../models/Order");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { notifyBase } = require("../controllers/notificationController");
const analytics = require("./analytics");

const REMINDER_COOLDOWN_WEEKS = 1;      // at most 1 reminder per week
const SKIP_IF_ACTIVE_WITHIN_DAYS = 7;   // user already has work in flight
const CONVERSION_WINDOW_MS = 7 * 24 * 3600 * 1000;

// ISO week key: YYYY-Www so reminder dedupe resets each Monday.
function isoWeekKey(date) {
    const d = new Date(date);
    const dayNum = (d.getDay() + 6) % 7; // Monday = 0
    d.setDate(d.getDate() - dayNum + 3);
    const firstThursday = new Date(Date.UTC(d.getFullYear(), 0, 4));
    const year = d.getUTCFullYear();
    const week = Math.ceil((((d - firstThursday) / 86400000) + 1) / 7);
    return year + "-W" + String(week).padStart(2, "0");
}

function hasActiveRecentOrder(userId, now) {
    const since = new Date(now.getTime() - SKIP_IF_ACTIVE_WITHIN_DAYS * 24 * 3600 * 1000);
    return Order.countDocuments({
        user: userId,
        createdAt: { $gte: since },
        status: { $in: ["Placed", "Confirmed", "Preparing", "Out for Delivery"] },
    });
}

// Compute the reminder products (the ones most recently ordered, up to 3).
function pickProducts(order, limit) {
    const seen = new Map();
    for (const it of (order.items || [])) {
        const key = it.productId ? String(it.productId) : it.name;
        if (!seen.has(key)) {
            seen.set(key, { name: it.name, productId: it.productId ? String(it.productId) : null, unit: it.variantUnit || it.unit || "" });
        }
        if (seen.size >= (limit || 3)) break;
    }
    return Array.from(seen.values());
}

// Call after an order is Delivered. Fire-and-forget; never fails the caller.
async function maybeRemindRepeatOrder(deliveredOrder) {
    try {
        if (!deliveredOrder || !deliveredOrder.user) return;
        const order = deliveredOrder;
        // Only established repeat buyers are reminded (at least one prior order).
        const priorCount = await Order.countDocuments({
            user: order.user,
            _id: { $ne: order._id },
            status: { $in: ["Delivered"] },
        });
        if (priorCount === 0) return;

        const user = await User.findById(order.user).select("reminderOptOut");
        if (!user || user.reminderOptOut) return;

        if (await hasActiveRecentOrder(order.user, new Date())) return;

        const products = pickProducts(order, 3);
        if (!products.length) return;

        const names = products.map((p) => p.name).join(", ");
        const now = new Date();
        // Week-scoped dedupe: one reminder per user per ISO week maximum.
        const key = "repeat_reminder:" + String(order.user) + ":" + isoWeekKey(now);
        const doc = await notifyBase(order.user, {
            type: "reminder",
            title: "Come back to FreshMart 🥬",
            message: "Your last order included " + names + ". Reorder your favourites in a tap!",
            dedupeKey: key,
            data: {
                reminder: true,
                products: products,
                orderId: String(order._id),
                link: "index.html?search=" + encodeURIComponent(products.map((p) => p.name).join(" ")),
            },
        });

        // Only count truly new sends (dedupe returns the earlier doc).
        if (doc && doc._id) {
            const createdRecently = (now.getTime() - new Date(doc.createdAt).getTime()) < 120000;
            if (createdRecently) {
                analytics.track({
                    eventName: "reminder_sent",
                    userId: order.user,
                    orderId: String(order._id),
                    metadata: { productIds: products.map((p) => p.productId).filter(Boolean), dedupeKey: key },
                });
            }
        }
    } catch (e) {
        console.warn("[reminder] maybeRemindRepeatOrder failed: " + ((e && e.message) || "unknown"));
    }
}

// Call when a new order is created. Records reminder_converted when the user
// was reminded about any of the ordered products within the window.
async function maybeMarkReminderConverted(order) {
    try {
        if (!order || !order.user || !Array.isArray(order.items) || !order.items.length) return;
        const reminder = await Notification.findOne({
            user: order.user,
            type: "reminder",
            createdAt: { $gte: new Date(Date.now() - CONVERSION_WINDOW_MS) },
        }).sort({ createdAt: -1 });
        if (!reminder || !reminder.data || !Array.isArray(reminder.data.products)) return;

        const remindedIds = new Set(reminder.data.products.map((p) => p && p.productId).filter(Boolean));
        const remindedNames = new Set(reminder.data.products.map((p) => p && p.name).filter(Boolean));
        const hit = order.items.some((it) =>
            (it.productId && remindedIds.has(String(it.productId))) || remindedNames.has(it.name)
        );
        if (!hit) return;

        analytics.track({
            eventName: "reminder_converted",
            userId: order.user,
            orderId: String(order._id),
            metadata: { reminderNotificationId: String(reminder._id), productIds: order.items.map((i) => i.productId).filter(Boolean) },
        });
    } catch (e) {
        console.warn("[reminder] maybeMarkReminderConverted failed: " + ((e && e.message) || "unknown"));
    }
}

module.exports = { maybeRemindRepeatOrder, maybeMarkReminderConverted, isoWeekKey };