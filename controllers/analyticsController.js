// ===============================
// ANALYTICS CONTROLLER
// - Public, rate-limited event ingestion (fire-and-forget, JSON only, always
//   sanitized: no tokens/passwords, primitives only).
// - Admin KPI aggregation. All aggregation is server-side; the browser only
//   ever asks for a time window and renders numbers.
// ===============================

const AnalyticsEvent = require("../models/AnalyticsEvent");
const { safeErrorMessage } = require("../utils/safeError");
const Order = require("../models/Order");
const User = require("../models/User");
const analytics = require("../utils/analytics");
const stockAlert = require("../utils/stockAlert");

// Never persist sensitive or nested payloads; keep only primitives and short
// arrays of primitives so junk cannot bloat the collection.
function sanitizeMetadata(value) {
    const out = {};
    if (!value || typeof value !== "object") return out;
    const keys = Object.keys(value);
    for (const k of keys) {
        if (!k || k.length > 40) continue;
        const v = value[k];
        const lower = k.toLowerCase();
        if (/(token|secret|password|key|cookie|authorization|otp)/.test(lower)) continue;
        if (typeof v === "string") out[k] = v.slice(0, 120);
        else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
        else if (typeof v === "boolean") out[k] = v;
        else if (Array.isArray(v) && v.length <= 24) {
            const items = v.filter((i) => typeof i === "string" || typeof i === "number" || typeof i === "boolean").slice(0, 24);
            out[k] = items;
        }
    }
    return out;
}

// POST /api/analytics/track — public, optional auth, rate-limited.
exports.track = async (req, res) => {
    const { eventName, anonymousId, sessionId, productId, category, metadata, page } = req.body || {};
    if (!eventName || !analytics.isValidEvent(eventName)) {
        return res.status(400).json({ success: false, message: "Unknown analytics event" });
    }
    const device = (req.get && req.get("user-agent")) ? String(req.get("user-agent")).slice(0, 200) : null;
    analytics.track({
        eventName: eventName,
        user: req.user,           // set by optionalProtect when logged in
        anonymousId: String(anonymousId || "").slice(0, 80) || null,
        sessionId: String(sessionId || "").slice(0, 80) || null,
        productId: productId ? String(productId).slice(0, 64) : (category ? "cat:" + String(category).slice(0, 40) : null),
        metadata: sanitizeMetadata(metadata || {}),
        device: device,
        page: page ? String(page).slice(0, 80) : null,
    });
    return res.json({ success: true });
};

function parseRange(req) {
    const r = String(req.query.range || "30d");
    const now = new Date();
    let from = null;
    if (r === "today") from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    else if (r === "7d") from = new Date(now.getTime() - 7 * 24 * 3600 * 1000);
    else if (r === "30d") from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    else if (r === "90d") from = new Date(now.getTime() - 90 * 24 * 3600 * 1000);
    else if (req.query.from && req.query.to) {
        const f = new Date(String(req.query.from));
        const t = new Date(String(req.query.to));
        if (!isNaN(f.getTime()) && !isNaN(t.getTime())) from = f;
    }
    if (!from && r === "today") from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (!from) from = new Date(now.getTime() - 30 * 24 * 3600 * 1000);
    return { from, to: new Date() };
}

// GET /api/admin/analytics?range=today|7d|30d|90d — admin only.
exports.adminAnalytics = async (req, res) => {
    try {
        const { from, to } = parseRange(req);
        const match = { createdAt: { $gte: from, $lte: to } };

        const [delivered, placed, cancelled, events, newCustomers, repeatCust, checkoutStarted, checkoutCompleted] = await Promise.all([
            Order.aggregate([
                { $match: Object.assign({}, match, { status: "Delivered" }) },
                { $group: { _id: null, revenue: { $sum: "$total" }, orderCount: { $sum: 1 } } },
            ]),
            Order.countDocuments(Object.assign({}, match, { status: { $ne: "Cancelled" } })),
            Order.countDocuments(Object.assign({}, match, { status: "Cancelled" })),
            AnalyticsEvent.aggregate([
                { $match: match },
                { $group: { _id: "$eventName", count: { $sum: 1 } } },
            ]),
            AnalyticsEvent.countDocuments(Object.assign({}, match, { eventName: "signup" })),
            Order.aggregate([
                { $match: Object.assign({}, match, { status: "Delivered", user: { $ne: null } }) },
                { $group: { _id: "$user" } },
                { $group: { _id: null, total: { $sum: 1 } } },
            ]),
            AnalyticsEvent.countDocuments(Object.assign({}, match, { eventName: "checkout_started" })),
            AnalyticsEvent.countDocuments(Object.assign({}, match, { eventName: "checkout_completed" })),
        ]);

        // Top products by units ordered across delivered orders in range.
        const top = await Order.aggregate([
            { $match: Object.assign({}, match, { status: "Delivered" }) },
            { $unwind: "$items" },
            { $group: { _id: { id: "$items.productId", name: "$items.name" }, quantity: { $sum: "$items.quantity" }, revenue: { $sum: { $multiply: ["$items.quantity", "$items.price"] } } } },
            { $sort: { quantity: -1 } },
            { $limit: 6 },
        ]);

        // Most-viewed products from product_view events.
        const viewed = await AnalyticsEvent.aggregate([
            { $match: Object.assign({}, match, { eventName: "product_view", productId: { $ne: null } }) },
            { $group: { _id: "$productId", views: { $sum: 1 } } },
            { $sort: { views: -1 } },
            { $limit: 6 },
        ]);

        const eventMap = {};
        events.forEach((e) => { eventMap[e._id] = e.count; });

        const d = delivered[0];
        const revenue = d ? Math.round(d.revenue * 100) / 100 : 0;
        const deliveredCount = d ? d.orderCount : 0;
        const aov = deliveredCount ? Math.round((revenue / deliveredCount) * 100) / 100 : 0;
        const conversionRate = checkoutStarted ? Math.round(((checkoutCompleted / checkoutStarted) * 1000)) / 10 : 0;
        const totalCustomers = await User.countDocuments({ role: "customer" });
        const repeatCustomers = repeatCust[0] ? repeatCust[0].total : 0;

        let stockInfo = { waitingTotal: 0, perProduct: [] };
        try { stockInfo = await stockAlert.waitingStats(); } catch (e) { /* non-fatal */ }

        const referralRewardEvents = await AnalyticsEvent.aggregate([
            { $match: Object.assign({}, match, { eventName: "referral_reward" }) },
            { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: "$metadata.amount" } } },
        ]);
        const rre = referralRewardEvents[0];

        return res.json({
            success: true,
            range: String(req.query.range || "30d"),
            from: from.toISOString(),
            to: to.toISOString(),
            kpis: {
                revenue, deliveredOrders: deliveredCount, aov,
                placedOrders: placed, cancelledOrders: cancelled,
                newCustomers, repeatCustomers, conversionRate,
                totalCustomers, checkoutStarted, checkoutCompleted,
            },
            events: eventMap,
            topProducts: top.map((t) => ({ name: t._id && t._id.name || "Product", productId: t._id && t._id.id, quantity: t.quantity, revenue: Math.round(t.revenue * 100) / 100 })),
            topViewedProducts: viewed.map((v) => ({ productId: v._id, views: v.views })),
            referral: {
                signups: eventMap.referral_signup || 0,
                rewardsCredited: rre ? rre.count : 0,
                amountCredited: rre ? Math.round(rre.amount * 100) / 100 : 0,
            },
            pwaInstalls: eventMap.pwa_install || 0,
            stockWaiting: stockInfo,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};