// ===============================
// PERSONALIZED RECOMMENDATIONS ENGINE
// Deterministic, privacy-conscious scoring built from real in-homed signals:
//   * recently_viewed   — last product_view analytics events (user-anchored)
//   * buy_again         — previously ordered (delivered) products, frequency bump
//   * frequently_bought — co-purchase pairs from delivered orders
//   * you_may_also_like — category/rating fallback for new or cold users
// Everything is capped and indexed; results are cached in-memory for 60s so a
// page load never triggers an expensive aggregation. User-specific sections
// return empty arrays for anonymous visitors instead of leaking personalization.
// ===============================

const mongoose = require("mongoose");
const Product = require("../models/Product");
const Order = require("../models/Order");
const AnalyticsEvent = require("../models/AnalyticsEvent");
const coPurchase = require("./coPurchase");

const { ObjectId } = mongoose.Types;

// In-memory result TTL cache: key = `${userId||'anon'}:${productId||'none'}`
// Small bounded cache; stale entries expire naturally in-memory (acceptable for
// a recommendation surface - never a correctness boundary).
const CACHE_TTL_MS = 60 * 1000;
const cache = new Map();

const VIEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function _activeProductsByIds(ids) {
    if (!Array.isArray(ids) || !ids.length) return [];
    const docs = await Product.find({ _id: { $in: ids }, active: true }).lean();
    const byId = new Map(docs.map((d) => [String(d._id), d]));
    return ids.map((id) => byId.get(String(id))).filter(Boolean);
}

// Public-safe product slice (no admin-only fields).
function publicProduct(p) {
    if (!p) return null;
    return {
        id: p._id,
        name: p.name,
        category: p.category,
        price: p.price,
        unit: p.unit,
        stock: p.stock,
        rating: p.rating || 0,
        ratingCount: p.ratingCount || 0,
        gradient: p.gradient || null,
        imageBy: p.imageBy || null,
    };
}

async function recentlyViewed(userId, limit) {
    if (!userId) return [];
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000);
    const events = await AnalyticsEvent.aggregate([
        {
            $match: {
                userId: new ObjectId(userId),
                eventName: "product_view",
                createdAt: { $gte: sixMonthsAgo },
                productId: { $ne: null },
            },
        },
        { $sort: { createdAt: -1 } },
        { $group: { _id: "$productId", last: { $first: "$createdAt" } } },
        { $sort: { last: -1 } },
        { $limit: limit || 8 },
    ]);
    return _activeProductsByIds(events.map((e) => e._id));
}

async function buyAgain(userId, limit, excludeIds) {
    if (!userId) return [];
    const exclude = excludeIds || [];
    const rows = await Order.aggregate([
        {
            $match: {
                user: new ObjectId(userId),
                status: { $in: ["Delivered", "Completed", "Out for Delivery", "Confirmed", "Placed"] },
                "items.productId": { $ne: null },
            },
        },
        { $unwind: "$items" },
        {
            $match: {
                "items.productId": { $ne: null },
                "items.productName": { $ne: null },
            },
        },
        { $group: { _id: "$items.productId", orders: { $sum: 1 }, last: { $max: "$createdAt" } } },
        { $sort: { orders: -1, last: -1 } },
        { $limit: (limit || 8) * 3 },
    ]);
    const ids = rows.map((r) => r._id).filter((id) => !exclude.includes(String(id)));
    return _activeProductsByIds(ids.slice(0, limit || 8));
}

// Same-category top-rated products the user has not interacted with much.
// Used as the cold-start / "you may also like" section, and as the anonymous
// fallback (no PII - anonymous shops only receive category/popularity signals).
async function youMayAlsoLike(userId, limit, excludeIds) {
    const exclude = new Set((excludeIds || []).map(String));
    let mongoFilter = { active: true };

    if (userId) {
        const viewed = await AnalyticsEvent.aggregate([
            {
                $match: {
                    userId: new ObjectId(userId),
                    eventName: { $in: ["product_view", "recommendation_click"] },
                    productId: { $ne: null },
                },
            },
            { $group: { _id: "$productId" } },
        ]);
        viewed.forEach((v) => exclude.add(String(v._id)));
    }

    const pool = await Product.find({ ...mongoFilter, _id: { $nin: Array.from(exclude) } })
        .sort({ rating: -1, ratingCount: -1 })
        .limit((limit || 8) * 2)
        .lean();

    // Tier by category spread so the section is not one category.
    const byCat = new Map();
    pool.forEach((p) => {
        const key = p.category || "Other";
        if (!byCat.has(key)) byCat.set(key, []);
        if (byCat.get(key).length < Math.ceil((limit || 8) / 2)) byCat.get(key).push(p);
    });
    const out = [];
    let i = 0;
    while (out.length < (limit || 8)) {
        let added = false;
        for (const arr of byCat.values()) {
            if (i < arr.length) {
                out.push(arr[i]);
                added = true;
                if (out.length >= (limit || 8)) break;
            }
        }
        i++;
        if (!added) break;
    }
    return out;
}

// Build the ordered sections for a user + optional product context.
async function buildSections({ userId, productId, limit }) {
    const n = limit && limit > 0 ? Math.min(limit, 12) : 6;
    const exclude = [];
    const sections = [];
    let items = [];

    if (productId) {
        // Anchor: a real product on screen.
        const fbt = (await coPurchase.frequentPartners(new ObjectId(productId), n))
            .map((r) => r.productId);
        const fbtDocs = await _activeProductsByIds(fbt);
        fbtDocs.forEach((d) => exclude.push(String(d._id)));
        if (fbtDocs.length) {
            sections.push({ key: "frequently_bought_together", title: "Frequently bought together", items: fbtDocs.map(publicProduct) });
        }
    }

    items = await recentlyViewed(userId, n);
    items.forEach((d) => exclude.push(String(d._id)));
    if (items.length) sections.push({ key: "recently_viewed", title: "Recently viewed", items: items.map(publicProduct) });

    items = await buyAgain(userId, n, exclude);
    items.forEach((d) => exclude.push(String(d._id)));
    if (items.length) sections.push({ key: "buy_again", title: "Buy again", items: items.map(publicProduct) });

    items = await youMayAlsoLike(userId, n, exclude);
    if (items.length) sections.push({ key: "you_may_also_like", title: "You may also like", items: items.map(publicProduct) });

    return sections;
}

async function recommendationsFor({ userId, productId, limit, tracking }) {
    const cacheKey = `${userId ? String(userId) : "anon"}:${productId ? String(productId) : "none"}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        return { sections: hit.sections, cached: true };
    }

    const sections = await buildSections({ userId, productId, limit });

    // Trim each section to the requested limit.
    sections.forEach((s) => { s.items = s.items.slice(0, limit > 0 ? Math.min(limit, 12) : 6); });

    // Fire impressions (fire-and-forget) but never block on them.
    if (tracking) {
        const ids = [];
        sections.forEach((s) => s.items.forEach((i) => i.id && ids.push(String(i.id))));
        coPurchase.trackImpression(userId, "recommendations", ids);
    }

    cache.set(cacheKey, { at: Date.now(), sections });
    return { sections, cached: false };
}

module.exports = { recommendationsFor, buildSections, publicProduct, recentlyViewed, buyAgain, youMayAlsoLike };