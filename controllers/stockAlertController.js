// ===============================
// BACK-IN-STOCK ALERT CONTROLLER
// POST /api/stock-alerts { productId } — "Notify Me" (auth).
// GET  /api/admin/stock-alerts/waiting — admin waiting counts.
// ===============================

const StockAlert = require("../models/StockAlert");
const { safeErrorMessage } = require("../utils/safeError");
const Product = require("../models/Product");
const stockAlert = require("../utils/stockAlert");
const analytics = require("../utils/analytics");

// POST /api/stock-alerts (auth). Only subscribable while the product is OUT of
// stock; re-subscribing for the same product is a harmless no-op.
exports.subscribe = async (req, res) => {
    try {
        const productId = String((req.body && req.body.productId) || "");
        if (!productId || !/^[0-9a-fA-F]{24}$/.test(productId)) {
            return res.status(400).json({ success: false, message: "Valid productId required" });
        }
        const product = await Product.findById(productId).select("name stock active");
        if (!product) return res.status(404).json({ success: false, message: "Product not found" });
        const inStock = Number(product.stock) > 0;
        if (inStock) {
            return res.status(400).json({ success: false, message: "This product is back in stock!" });
        }

        const updated = await StockAlert.findOneAndUpdate(
            { user: req.user._id, product: product._id },
            { $setOnInsert: { user: req.user._id, product: product._id, productName: product.name, status: "WAITING" } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        // Track only a genuinely new subscription.
        const createdRecently = (new Date() - new Date(updated.createdAt)) < 60000;
        if (createdRecently) {
            analytics.track({
                eventName: "stock_alert_subscribed",
                userId: req.user._id,
                productId: String(product._id),
                metadata: { productName: product.name },
            });
        }

        return res.json({ success: true, message: "We'll notify you when it's back in stock!", data: { productId: String(product._id), status: updated.status } });
    } catch (error) {
        if (error && error.code === 11000) {
            return res.json({ success: true, message: "We'll notify you when it's back in stock!" });
        }
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET /api/admin/stock-alerts/waiting (admin).
exports.adminWaiting = async (req, res) => {
    try {
        const stats = await stockAlert.waitingStats();
        const recent = await StockAlert.find({ status: "WAITING" })
            .sort({ createdAt: -1 })
            .limit(20)
            .populate("user", "name email phone")
            .populate("product", "name");
        return res.json({
            success: true,
            data: {
                waitingTotal: stats.waitingTotal,
                perProduct: stats.perProduct,
                recent: recent.map((a) => ({
                    _id: a._id,
                    user: a.user ? { name: a.user.name, email: a.user.email, phone: a.user.phone } : null,
                    product: a.product ? a.product.name : a.productName,
                    createdAt: a.createdAt,
                })),
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};