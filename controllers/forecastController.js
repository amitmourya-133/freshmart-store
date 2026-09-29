// ===============================
// INVENTORY FORECAST CONTROLLER (Phase 3.8)
// GET /api/admin/inventory/forecast  (admin only, cached 60s)
// ===============================

const forecast = require("../utils/forecast");

async function getForecast(req, res) {
    try {
        const productId = req.query.productId ? String(req.query.productId) : null;
        const data = await forecast.forecast({ productId: /^[0-9a-f]{24}$/i.test(productId) ? productId : null });
        res.json({ success: true, ...data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
}

module.exports = { getForecast };