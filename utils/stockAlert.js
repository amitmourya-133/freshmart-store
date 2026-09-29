// ===============================
// BACK-IN-STOCK ALERT SERVICE
// Notifies every WAITING subscriber the moment an out-of-stock product becomes
// available again (OUT_OF_STOCK -> IN_STOCK transition, detected at the stock
// write sites in productController). Alerts flip to NOTIFIED exactly once;
// the notification (user, dedupeKey) index also prevents double-sends.
// ===============================

const StockAlert = require("../models/StockAlert");
const { notifyBase } = require("../controllers/notificationController");
const analytics = require("./analytics");

// Fire-and-forget: call after a product's stock rose above 0 from 0/absent.
async function notifyBackInStock(product) {
    try {
        if (!product || !product._id) return;
        const alerts = await StockAlert.find({ product: product._id, status: "WAITING" })
            .select("_id user")
            .limit(500);
        if (!alerts.length) return;

        const productIdStr = String(product._id);
        const name = product.name || "This product";
        const link = "index.html?search=" + encodeURIComponent(name);

        for (const alert of alerts) {
            await notifyBase(alert.user, {
                type: "stock_alert",
                title: "Back in stock: " + name + " 🟢",
                message: "Good news! " + name + " is available again. Order before it sells out.",
                dedupeKey: "stock_alert:" + productIdStr,
                data: { productId: productIdStr, productName: name, link },
            });
            await StockAlert.updateMany(
                { _id: alert._id, status: "WAITING" },
                { $set: { status: "NOTIFIED", notifiedAt: new Date() } }
            );
        }

        analytics.track({
            eventName: "stock_alert_triggered",
            productId: productIdStr,
            metadata: { notifiedCount: alerts.length, productName: name },
        });
    } catch (e) {
        console.warn("[stock-alert] notifyBackInStock failed: " + ((e && e.message) || "unknown"));
    }
}

// Admin: count of users still waiting across all products.
async function waitingStats() {
    const [waiting, rows] = await Promise.all([
        StockAlert.countDocuments({ status: "WAITING" }),
        StockAlert.aggregate([
            { $match: { status: "WAITING" } },
            { $group: { _id: "$product", waiting: { $sum: 1 } } },
            { $sort: { waiting: -1 } },
            { $limit: 20 },
        ]),
    ]);
    return { waitingTotal: waiting, perProduct: rows };
}

module.exports = { notifyBackInStock, waitingStats };