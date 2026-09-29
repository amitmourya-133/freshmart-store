// ===============================
// RECOMMENDATIONS CONTROLLER
// POST /api/recommendations — returns personalized product sections.
// Optional auth: signed-in users get all four sections; anonymous visitors get
// a cold-start/category fallback only (no per-user personalization is exposed).
// ===============================

const recommendations = require("../utils/recommendations");
const coPurchase = require("../utils/coPurchase");

async function getRecommendations(req, res) {
    try {
        const userId = req.user ? String(req.user._id) : null;
        const productId = req.body && req.body.productId ? String(req.body.productId) : null;
        const limit = req.body && req.body.limit ? parseInt(req.body.limit, 10) : 6;

        const result = await recommendations.recommendationsFor({
            userId,
            productId: /^[0-9a-f]{24}$/i.test(productId) ? productId : null,
            limit: isNaN(limit) ? 6 : limit,
            tracking: true,
        });
        res.json({ success: true, source: "local", cached: result.cached, sections: result.sections });
    } catch (err) {
        res.status(500).json({ success: false, message: "Recommendation service temporarily unavailable", code: "RECOMMENDATION_ERROR" });
    }
}

module.exports = { getRecommendations };