// ===============================
// SETTINGS CONTROLLER
// Store configuration (delivery charges + low-stock threshold + min order +
// delivery radius / ETA config).
// GET /api/settings/shipping -> public read-only delivery policy.
// GET /api/settings          -> admin full config.
// PUT /api/settings          -> admin update (validated).
// GET /api/settings/delivery-check -> public coverage check (lat/lng).
// ===============================

const Settings = require("../models/Settings");
const { deliveryCoverageFor } = require("../utils/geo");

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

// Public coverage check for a destination coordinate pair. Used by the checkout
// to warn early; the authoritative gate stays inside createOrder.
exports.getDeliveryCoverage = async (req, res) => {
    try {
        const lat = Number(req.query.lat);
        const lng = Number(req.query.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng) ||
            Math.abs(lat) > 90 || Math.abs(lng) > 180) {
            return res.status(400).json({ success: false, message: "Invalid coordinates" });
        }
        const coverage = await deliveryCoverageFor(lat, lng);
        res.json({ success: true, data: coverage });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: full settings (delivery + low-stock threshold + minimum order + radius/ETA).
exports.getSettings = async (req, res) => {
    try {
        const doc = await Settings.getSettings();
        res.json({
            success: true,
            data: {
                deliveryCharge: doc.deliveryCharge,
                freeDeliveryThreshold: doc.freeDeliveryThreshold,
                lowStockThreshold: doc.lowStockThreshold,
                minimumOrderValue: Number(doc.minimumOrderValue) > 0 ? Number(doc.minimumOrderValue) : 0,
                deliveryRadiusKm: Number(doc.deliveryRadiusKm) > 0 ? Number(doc.deliveryRadiusKm) : 0,
                storeLat: Number(doc.storeLat) || 0,
                storeLng: Number(doc.storeLng) || 0,
                storeLocality: doc.storeLocality || "Store",
                etaBaseMinutes: Number(doc.etaBaseMinutes) >= 0 ? Number(doc.etaBaseMinutes) : 45,
                etaMinutesPerKm: Number(doc.etaMinutesPerKm) >= 0 ? Number(doc.etaMinutesPerKm) : 3
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

        if (req.body.deliveryRadiusKm !== undefined) {
            const v = Number(req.body.deliveryRadiusKm);
            if (!Number.isFinite(v) || v < 0 || v > 500) {
                return res.status(400).json({ success: false, message: "Delivery radius must be between 0 and 500 km (0 disables the radius check)" });
            }
            updates.deliveryRadiusKm = Math.round(v * 100) / 100;
        }

        if (req.body.storeLat !== undefined) {
            const v = Number(req.body.storeLat);
            if (!Number.isFinite(v) || Math.abs(v) > 90) {
                return res.status(400).json({ success: false, message: "Store latitude must be between -90 and 90" });
            }
            updates.storeLat = Math.round(v * 1e6) / 1e6;
        }

        if (req.body.storeLng !== undefined) {
            const v = Number(req.body.storeLng);
            if (!Number.isFinite(v) || Math.abs(v) > 180) {
                return res.status(400).json({ success: false, message: "Store longitude must be between -180 and 180" });
            }
            updates.storeLng = Math.round(v * 1e6) / 1e6;
        }

        if (req.body.storeLocality !== undefined) {
            const v = String(req.body.storeLocality).trim().slice(0, 120);
            if (!v) {
                return res.status(400).json({ success: false, message: "Store locality cannot be empty" });
            }
            updates.storeLocality = v;
        }

        if (req.body.etaBaseMinutes !== undefined) {
            const v = Number(req.body.etaBaseMinutes);
            if (!Number.isFinite(v) || v < 0 || v > 600) {
                return res.status(400).json({ success: false, message: "ETA base minutes must be between 0 and 600" });
            }
            updates.etaBaseMinutes = Math.floor(v);
        }

        if (req.body.etaMinutesPerKm !== undefined) {
            const v = Number(req.body.etaMinutesPerKm);
            if (!Number.isFinite(v) || v < 0 || v > 30) {
                return res.status(400).json({ success: false, message: "ETA minutes-per-km must be between 0 and 30" });
            }
            updates.etaMinutesPerKm = Math.round(v * 100) / 100;
        }

        Object.assign(doc, updates);
        await doc.save();

        res.json({
            success: true,
            data: {
                deliveryCharge: doc.deliveryCharge,
                freeDeliveryThreshold: doc.freeDeliveryThreshold,
                minimumOrderValue: Number(doc.minimumOrderValue) > 0 ? Number(doc.minimumOrderValue) : 0,
                lowStockThreshold: doc.lowStockThreshold,
                deliveryRadiusKm: Number(doc.deliveryRadiusKm) > 0 ? Number(doc.deliveryRadiusKm) : 0,
                storeLat: Number(doc.storeLat) || 0,
                storeLng: Number(doc.storeLng) || 0,
                storeLocality: doc.storeLocality || "Store",
                etaBaseMinutes: Number(doc.etaBaseMinutes) >= 0 ? Number(doc.etaBaseMinutes) : 45,
                etaMinutesPerKm: Number(doc.etaMinutesPerKm) >= 0 ? Number(doc.etaMinutesPerKm) : 3
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};