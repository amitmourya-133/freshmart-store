// ===============================
// INVENTORY FORECASTING (Phase 3.8)
// Data-driven supply planning from REAL order history (delivered/completed
// orders only, so cancelled/unpaid lines never skew demand). Insights:
//   * avg daily sold qty  − 7d velocity and 30d velocity
//   * daysOfStockLeft     − stock / avgDaily (0 when no history → "no data")
//   * velocity tier       − fast / normal / slow / none (sales quartiles)
//   * restock flagged     − daysOfStockLeft <= reorderDays
//   * stock-out risk      − daysOfStockLeft <= 2 or stock already 0
// Bounded aggregations, cached 60s, and always safe on an empty catalog.
// ===============================

const Product = require("../models/Product");
const Order = require("../models/Order");
const StockAlert = require("../models/StockAlert");
const analytics = require("./analytics");

const REORDER_DAYS = 7;
const OUT_DAYS = 2;

let cache = { at: 0, data: null };
const CACHE_TTL = 60 * 1000;

async function computeForecast(opts) {
    const now = Date.now();
    const since7 = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const since90 = new Date(now - 90 * 24 * 60 * 60 * 1000);

    const productId = opts && opts.productId ? String(opts.productId) : null;
    const pFilter = productId ? { _id: productId } : {};

    const products = await Product.find(pFilter).select("_id name category unit stock active b2bMinQty").lean();

    // Live order demand in one bounded aggregation: 90d sold qty + last 7d qty.
    const match = {
        status: { $in: ["Delivered", "Completed"] },
        createdAt: { $gte: since90 },
        "items.productId": { $ne: null },
    };
    if (productId) match["items.productId"] = productId;

    const rows = await Order.aggregate([
        { $match: match },
        { $unwind: "$items" },
        { $match: { "items.productId": { $ne: null } } },
        {
            $group: {
                _id: "$items.productId",
                sold90: { $sum: "$items.quantity" },
                sold7: { $sum: { $cond: [{ $gte: ["$createdAt", since7] }, "$items.quantity", 0] } },
                orders90: { $sum: 1 },
            },
        },
    ]);
    const byId = new Map(rows.map((r) => [String(r._id), r]));

    // Waiting-customers count from back-in-stock alerts (real demand signal).
    const warnedProducts = await StockAlert.aggregate([
        { $match: { notified: false } },
        { $group: { _id: "$product", waiters: { $sum: 1 } } },
    ]);
    const waiters = new Map(warnedProducts.map((w) => [String(w._id), w.waiters]));

    const items = [];
    for (const p of products) {
        const row = byId.get(String(p._id)) || { sold90: 0, sold7: 0, orders90: 0 };
        const avgDaily90 = round1(row.sold90 / 90);
        const avgDaily7 = round1(row.sold7 / 7);
        const daysOfStockLeft = avgDaily90 > 0 ? Math.round(Number(p.stock || 0) / avgDaily90) : (p.active ? null : null);
        let velocity = "none";
        if (rows.length) {
            const all = rows.map((r) => r.sold90).sort((a, b) => a - b);
            const q = (v) => {
                const idx = Math.min(all.length - 1, Math.floor(all.length * v));
                return all[idx] || 0;
            };
            const sold = row.sold90;
            velocity = sold === 0 ? "none" : (sold >= q(0.75) ? "fast" : (sold >= q(0.4) ? "normal" : "slow"));
        }
        const restock = p.active === true && avgDaily90 > 0 && (daysOfStockLeft != null && daysOfStockLeft <= REORDER_DAYS);
        const outRisk = p.active === true && avgDaily90 > 0 && ((daysOfStockLeft != null && daysOfStockLeft <= OUT_DAYS) || Number(p.stock || 0) <= 0);
        const waitlist = waiters.get(String(p._id)) || 0;
        items.push({
            productId: p._id,
            name: p.name,
            category: p.category,
            unit: p.unit || "kg",
            stock: p.stock || 0,
            active: p.active,
            sold90: row.sold90,
            sold7: row.sold7,
            avgDaily90,
            avgDaily7,
            orders90: row.orders90,
            daysOfStockLeft,
            velocity,
            restock,
            restockDays: REORDER_DAYS,
            outRisk,
            waitlist,
            suggestedOrderQty: restock ? suggestedQty(p, avgDaily90) : 0,
        });
    }

    items.sort((a, b) => {
        // stock-out risks first, then restock, then slowest-moving.
        const score = (x) => (x.outRisk ? 0 : (x.restock ? 1 : 2));
        const sc = score(a) - score(b);
        return sc !== 0 ? sc : (a.daysOfStockLeft == null ? 1 : (b.daysOfStockLeft == null ? -1 : a.daysOfStockLeft - b.daysOfStockLeft));
    });

    const summary = {
        coverage: items.length,
        outOfStock: items.filter((i) => i.stock <= 0).length,
        stockOutRisk: items.filter((i) => i.outRisk).length,
        needsRestock: items.filter((i) => i.restock).length,
        fastMovers: items.filter((i) => i.velocity === "fast" && i.avgDaily90 > 0).length,
        generatedAt: new Date(),
        reorderDaysDefault: REORDER_DAYS,
    };

    for (const r of items.filter((i) => i.restock)) {
        analytics.track({
            eventName: "reorder_alert_triggered",
            productId: r.productId,
            metadata: { name: r.name, daysOfStockLeft: r.daysOfStockLeft, stock: r.stock, suggestedOrderQty: r.suggestedOrderQty },
        });
    }

    return { summary, data: items };
}

function round1(n) {
    return Math.round(n * 10) / 10;
}

// Reasonable next-purchase suggestion: one week of projected demand, rounded up
// to the product's b2b minimum or 5 units, so the buyer orders a usable batch.
function suggestedQty(p, avgDaily90) {
    const week = Math.ceil(avgDaily90 * REORDER_DAYS);
    const batch = p.b2bMinQty ? Math.max(p.b2bMinQty, 5) : 5;
    return Math.max(batch, Math.ceil(week / batch) * batch);
}

async function forecast(opts) {
    if (cache.data && Date.now() - cache.at < CACHE_TTL && !(opts && opts.productId)) {
        return cache.data;
    }
    const data = await computeForecast(opts);
    if (!(opts && opts.productId)) {
        cache = { at: Date.now(), data: data };
    }
    return data;
}

module.exports = { forecast, computeForecast, REORDER_DAYS, OUT_DAYS };