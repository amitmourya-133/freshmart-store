// ===============================
// ADMIN SALES DASHBOARD CONTROLLER
// GET /api/admin/dashboard?from=YYYY-MM-DD&to=YYYY-MM-DD
// Admin-only (protect + admin middleware at the route level).
//
// Everything is aggregated server-side from real order documents.
// Sales definition (documented & used everywhere in this endpoint):
//   a sale is a non-cancelled order (status != "Cancelled"); the recorded
//   order.total (which the server computed from MongoDB prices at checkout)
//   is the source of truth. Cancelled orders are excluded because the goods
//   were never fulfilled.
// Timeline grouping uses Asia/Kolkata consistently for 'today' and date-wise.
// ===============================

const Order = require("../models/Order");
const Product = require("../models/Product");
const Settings = require("../models/Settings");

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000; // Asia/Kolkata = UTC+05:30
const currency = "INR";

function pad(n) {
    return String(n).length === 1 ? "0" + n : String(n);
}

function toIstDateString(d) {
    const t = new Date(d).getTime() + IST_OFFSET_MS;
    const u = new Date(t);
    return u.getUTCFullYear() + "-" + pad(u.getUTCMonth() + 1) + "-" + pad(u.getUTCDate());
}

// Boundary of an IST-day (milliseconds) from a "YYYY-MM-DD" string.
function istDayStart(dateStr) {
    const parts = String(dateStr).split("-").map(Number);
    return Date.UTC(parts[0], parts[1] - 1, parts[2]) - IST_OFFSET_MS;
}

function istDayEnd(dateStr) {
    return istDayStart(dateStr) + 86400000;
}

function addDays(dateStr, n) {
    const d = new Date(istDayStart(dateStr) + n * 86400000 + IST_OFFSET_MS);
    return toIstDateString(d);
}

async function dayAggregation($gte, $lt) {
    const rows = await Order.aggregate([
        { $match: { createdAt: { $gte: new Date($gte), $lt: new Date($lt) }, status: { $ne: "Cancelled" } } },
        {
            $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Kolkata" } },
                orders: { $sum: 1 },
                sales: { $sum: "$total" }
            }
        }
    ]);
    const map = {};
    rows.forEach(function (r) { map[r._id] = { date: r._id, sales: Math.round(r.sales * 100) / 100, orders: r.orders }; });
    return map;
}

exports.getDashboard = async (req, res) => {
    try {
        const settings = await Settings.getSettings();
        const threshold = settings.lowStockThreshold >= 1 ? settings.lowStockThreshold : 20;
        const minOrderValue = Number(settings.minimumOrderValue) || 0;

        // ---- date range ----
        let from = String(req.query.from || "").trim();
        let to = String(req.query.to || "").trim();
        const today = toIstDateString(Date.now());
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
            // Default: last 30 days including today.
            to = today;
            from = addDays(to, -29);
        }
        if (from > to) {
            const tmp = from; from = to; to = tmp;
        }
        const rangeDays = [];
        for (let d = from; d <= to; d = addDays(d, 1)) rangeDays.push(d);

        const todayStart = istDayStart(today);
        const todayEnd = istDayEnd(today);

        // ---- aggregate in parallel ----
        const [todayAgg, pendingCount, deliveredCount, cancelledCount, totalOrders, totalSalesAgg, topAgg, outAgg, rangeAgg] = await Promise.all([
            dayAggregation(todayStart, todayEnd),
            Order.countDocuments({ status: { $in: ["Placed", "Confirmed", "Preparing", "Out for Delivery"] } }),
            Order.countDocuments({ status: "Delivered" }),
            Order.countDocuments({ status: "Cancelled" }),
            Order.countDocuments({}),
            Order.aggregate([
                { $match: { status: { $ne: "Cancelled" } } },
                { $group: { _id: null, total: { $sum: "$total" } } }
            ]),
            Order.aggregate([
                { $match: { status: { $ne: "Cancelled" } } },
                { $unwind: "$items" },
                { $group: { _id: "$items.name", quantity: { $sum: "$items.quantity" } } },
                { $sort: { quantity: -1 } },
                { $limit: 10 }
            ]),
            Product.aggregate([
                { $match: { active: true } },
                { $sort: { stock: 1 } },
                { $project: { name: 1, stock: 1 } }
            ]),
            dayAggregation(istDayStart(from), istDayEnd(to))
        ]);

        const todayRow = todayAgg[today] || { date: today, sales: 0, orders: 0 };
        const lowStockList = [];
        const outOfStockList = [];
        (outAgg || []).forEach(function (p) {
            if (p.stock <= 0) outOfStockList.push({ name: p.name, stock: p.stock });
            else if (p.stock < threshold) lowStockList.push({ name: p.name, stock: p.stock });
        });

        // ---- fill the full date range (missing days = zero) ----
        const dateWise = rangeDays.map(function (d) {
            const r = rangeAgg[d];
            return r || { date: d, sales: 0, orders: 0 };
        });

        const totalSales = totalSalesAgg[0] ? Math.round(totalSalesAgg[0].total * 100) / 100 : 0;

        res.json({
            success: true,
            data: {
                currency: currency,
                salesDefinition: "Sum of order.total for orders whose status is not Cancelled. Values are computed server-side from MongoDB order documents.",
                today: { date: today, sales: todayRow.sales, orders: todayRow.orders },
                pendingOrders: pendingCount,
                deliveredOrders: deliveredCount,
                cancelledOrders: cancelledCount,
                totalOrders: totalOrders,
                totalSales: totalSales,
                topSelling: topAgg.map(function (r) { return { name: r._id, quantity: r.quantity }; }),
                lowStock: lowStockList,
                lowStockThreshold: threshold,
                outOfStock: outOfStockList,
                minimumOrderValue: minOrderValue,
                from: from,
                to: to,
                dateWise: dateWise
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};