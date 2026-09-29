// ===============================
// CUSTOMER SEGMENTS
// Deterministic, non-intrusive classification used by segment-targeted
// coupons. Computed from real order/account data at validation time (never
// stored on the user, so it always reflects the current truth and needs no
// background job to stay accurate).
// Segments:
//   NEW_CUSTOMER     — signed up within 30 days (no qualifying orders yet)
//   FREQUENT_BUYER   — placed >= 4 orders in the last 90 days
//   HIGH_VALUE       — spent >= the high-value threshold in the last 90 days
//   INACTIVE_30_DAYS — last order older than 30 days (but has ordered before)
//   AT_RISK          — active account, no order in 60+ days, previously active
// ===============================

const Order = require("../models/Order");

const NEW_SINCE_MS = 30 * 24 * 60 * 60 * 1000;
const FREQ_90_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const HIGH_VALUE_SPEND = 3000; // rs spent in rolling 90 days
const INACTIVE_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const AT_RISK_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

// Primes: keeps high-value-relative math deterministic across users.
const AGE_WINDOW_MS = 180 * 24 * 60 * 60 * 1000;

// Load one user's ordering footprint in a single lightweight aggregation.
async function footprintFor(userId) {
    const days180 = new Date(Date.now() - AGE_WINDOW_MS);
    const rows = await Order.aggregate([
        { $match: { user: require("mongoose").Types.ObjectId(String(userId)), createdAt: { $gte: days180 } } },
        {
            $project: {
                status: 1,
                total: 1,
                createdAt: 1,
                // Only "live" orders count as spend signal (not cancelled/refunded).
                live: { $in: ["$status", ["Delivered", "Completed", "Out for Delivery", "Confirmed", "Placed"]] }
            }
        },
        {
            $group: {
                _id: null,
                orders90: { $sum: { $cond: [{ $and: [{ $gte: ["$createdAt", new Date(Date.now() - FREQ_90_DAYS_MS)] }, "$live"] }, 1, 0] } },
                spend90: { $sum: { $cond: [{ $and: [{ $gte: ["$createdAt", new Date(Date.now() - FREQ_90_DAYS_MS)] }, "$live"] }, { $ifNull: ["$total", 0] }, 0] } },
                lastOrderAt: { $max: "$createdAt" },
            }
        }
    ]);
    return rows.length ? rows[0] : {
        orders90: 0,
        spend90: 0,
        lastOrderAt: null
    };
}

// Which segments does this user belong to right now?
// Returns { segments: [], footprint } — footprint reused by callers to avoid a
// second query for the same request.
async function segmentOf(userId) {
    const footprint = await footprintFor(userId);
    const segments = [];
    const now = Date.now();
    const hasOrdered = !!footprint.lastOrderAt;

    // FREQUENT_BUYER first (the strongest repeated-purchase signal).
    if (footprint.orders90 >= 4) segments.push("FREQUENT_BUYER");
    if (footprint.spend90 >= HIGH_VALUE_SPEND) segments.push("HIGH_VALUE");

    // Acquisitions: NEW_CUSTOMER beats INACTIVE_30_DAYS for the same account.
    if (!hasOrdered || (now - new Date(footprint.lastOrderAt).getTime() > AGE_WINDOW_MS)) {
        segments.push("NEW_CUSTOMER");
    } else if (now - new Date(footprint.lastOrderAt).getTime() > AT_RISK_DAYS_MS) {
        segments.push("AT_RISK");
    } else if (now - new Date(footprint.lastOrderAt).getTime() > INACTIVE_30_DAYS_MS) {
        segments.push("INACTIVE_30_DAYS");
    } else if (!footprint.orders90) {
        // Recently(ish) active but never ordered in window -> treat as new-ish.
        segments.push("NEW_CUSTOMER");
    }

    return { segments: Array.from(new Set(segments)), footprint };
}

// Audience counts per segment for the admin targeting screen. To stay
// inexpensive, this classifies the most recently active customers (capped),
// one concurrency-limited pass, rather than scanning the whole account table.
async function segmentCounts() {
    const User = require("../models/User");
    const counts = { NEW_CUSTOMER: 0, INACTIVE_30_DAYS: 0, FREQUENT_BUYER: 0, HIGH_VALUE: 0, AT_RISK: 0 };
    const totalCustomers = await User.countDocuments({ role: "customer" });

    const recentUsers = await User.find({ role: "customer" })
        .sort({ createdAt: -1 })
        .limit(2000)
        .select("_id")
        .lean();

    let index = 0;
    const workers = Array.from({ length: 8 }, async () => {
        while (index < recentUsers.length) {
            const i = index++;
            const u = recentUsers[i];
            try {
                const res = await segmentOf(u._id);
                res.segments.forEach((s) => { if (counts[s] !== undefined) counts[s] += 1; });
            } catch (e) { /* skip user */ }
        }
    });
    await Promise.all(workers);

    return Object.assign({
        basedOn: recentUsers.length,
        totalCustomers: totalCustomers || 0,
        note: "Counts reflect the N most recently created customer accounts.",
    }, counts);
}

module.exports = { segmentOf, footprintFor, segmentCounts, SEGMENT_NAMES: ["NEW_CUSTOMER", "INACTIVE_30_DAYS", "FREQUENT_BUYER", "HIGH_VALUE", "AT_RISK"] };