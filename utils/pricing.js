// ===============================
// PRICING HELPERS (shared price logic)
// ===============================

// Map a qty/weight chip label to its multiplier against the base unit price.
// Mirrors getQtyOptions() on the frontend so server totals match client totals.
function getMultFromWeight(weight, unit) {
    if (!weight) return 1;
    if (/^\d+$/.test(String(weight))) return parseInt(weight, 10) || 1;
    if (unit === "litre") {
        const litreMap = { "250ml": 0.25, "500ml": 0.5, "1L": 1, "2L": 2 };
        return litreMap[weight] || 1;
    }
    const kgMap = { "250g": 0.25, "500g": 0.5, "1kg": 1, "2kg": 2 };
    return kgMap[weight] || 1;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = { getMultFromWeight, round2 };