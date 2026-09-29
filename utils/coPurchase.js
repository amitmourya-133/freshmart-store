// ===============================
// CO-PURCHASE SERVICE
// Records unordered product pairs from a delivered order so the
// "Frequently Bought Together" recommendation stays a real, in-homed signal.
// Co-purchase rows are only ever written with real order data (a delivered,
// itemized, server-verified order) - never invented.
// ===============================

const CoPurchase = require("../models/CoPurchase");
const analytics = require("./analytics");
const { ObjectId } = require("mongoose").Types;

function canon(a, b) {
    return String(a) < String(b) ? [a, b] : [b, a];
}

// Update (a,b) pair counts from an order's items in one bulkWrite per order.
// Skipped entirely when the order has no real product references.
async function recordPairsFromOrder(order) {
    if (!order || !Array.isArray(order.items) || order.items.length < 2) return 0;
    const ids = order.items
        .map((it) => (it.productId ? String(it.productId) : ""))
        .filter(Boolean);
    if (ids.length < 2) return 0;

    // Deduplicate same-product multiple lines to a single pair occurrence.
    const unique = Array.from(new Set(ids));
    const pairs = new Set();
    for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
            pairs.add(canon(unique[i], unique[j]).join(":"));
        }
    }

    const ops = Array.from(pairs).map((pair) => {
        const [a, b] = pair.split(":");
        return {
            updateOne: {
                filter: { a: new ObjectId(a), b: new ObjectId(b) },
                update: {
                    $inc: { count: 1 },
                    $set: { lastSeenAt: order.createdAt || new Date() },
                },
                upsert: true,
            },
        };
    });

    const res = await CoPurchase.bulkWrite(ops, { ordered: false });
    return res && res.upsertedCount ? res.upsertedCount : 0;
}

// Top N partners most frequently bought with `productId` (deterministic order
// by count desc, most-recently-seen as tie-break).
async function frequentPartners(productId, limit) {
    if (!productId) return [];
    const rows = await CoPurchase.find({
        $or: [{ a: productId }, { b: productId }],
    })
        .sort({ count: -1, lastSeenAt: -1 })
        .limit(limit || 6)
        .lean();

    return rows.map((r) => {
        const pid = String(r.a) === String(productId) ? String(r.b) : String(r.a);
        return { productId: pid, score: r.count };
    });
}

async function trackImpression(userId, source, ids) {
    if (!Array.isArray(ids) || !ids.length) return;
    try {
        await analytics.track({
            eventName: "recommendation_impression",
            userId: userId || null,
            metadata: { source: source || "recommendations", count: ids.length },
        });
    } catch (e) { /* non-fatal */ }
}

module.exports = { recordPairsFromOrder, frequentPartners, trackImpression };