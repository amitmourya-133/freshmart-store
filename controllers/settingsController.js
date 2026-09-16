// ===============================
// SETTINGS CONTROLLER
// Store configuration (delivery charges + low-stock threshold + min order).
// GET /api/settings/shipping -> public read-only delivery policy.
// GET /api/settings          -> admin full config.
// PUT /api/settings          -> admin update (validated).
// ===============================

const Settings = require("../models/Settings");

// Public read-only delivery policy (for the checkout summary display).
// Customers can never modify these values.
exports.getShippingPolicy = async (req, res) => {
    try {
        const policy = await Settings.getShippingPolicy();
        res.json({ success: true, data: policy });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: full settings (delivery + low-stock threshold + minimum order).
exports.getSettings = async (req, res) => {
    try {
        const doc = await Settings.getSettings();
        res.json({
            success: true,
            data: {
                deliveryCharge: doc.deliveryCharge,
                freeDeliveryThreshold: doc.freeDeliveryThreshold,
                lowStockThreshold: doc.lowStockThreshold,
                minimumOrderValue: Number(doc.minimumOrderValue) > 0 ? Number(doc.minimumOrderValue) : 0
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: update settings with validation (no negatives, sensible limits, coerce to numbers).
exports.updateSettings = async (req, res) => {
    try {
        const doc = await Settings.getSettings();
        const updates = {};

        if (req.body.deliveryCharge !== undefined) {
            const v = Number(req.body.deliveryCharge);
            if (!Number.isFinite(v) || v < 0 || v > 100000) {
                return res.status(400).json({ success: false, message: "Delivery charge must be between 0 and 100000" });
            }
            updates.deliveryCharge = Math.round(v * 100) / 100;
        }

        if (req.body.freeDeliveryThreshold !== undefined) {
            const v = Number(req.body.freeDeliveryThreshold);
            if (!Number.isFinite(v) || v < 0 || v > 1000000) {
                return res.status(400).json({ success: false, message: "Free-delivery threshold must be between 0 and 1000000" });
            }
            updates.freeDeliveryThreshold = Math.round(v * 100) / 100;
        }

        if (req.body.minimumOrderValue !== undefined) {
            const v = Number(req.body.minimumOrderValue);
            if (!Number.isFinite(v) || v < 0 || v > 1000000) {
                return res.status(400).json({ success: false, message: "Minimum order value must be between 0 and 1000000" });
            }
            updates.minimumOrderValue = Math.round(v * 100) / 100;
        }

        if (req.body.lowStockThreshold !== undefined) {
            const v = Number(req.body.lowStockThreshold);
            if (!Number.isFinite(v) || v < 1 || v > 100000) {
                return res.status(400).json({ success: false, message: "Low-stock threshold must be at least 1" });
            }
            updates.lowStockThreshold = Math.floor(v);
        }

        Object.assign(doc, updates);
        await doc.save();

        res.json({
            success: true,
            data: {
                deliveryCharge: doc.deliveryCharge,
                freeDeliveryThreshold: doc.freeDeliveryThreshold,
                minimumOrderValue: Number(doc.minimumOrderValue) > 0 ? Number(doc.minimumOrderValue) : 0,
                lowStockThreshold: doc.lowStockThreshold
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};