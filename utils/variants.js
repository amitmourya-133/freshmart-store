// ===============================
// PRODUCT VARIANTS LOGIC
// Shared server-side helpers for parsing admin-submitted variant lists and for
// resolving a variantId to a concrete price/stock atomically at checkout.
// ===============================

const mongoose = require("mongoose");

function isValidObjectId(value) {
    return mongoose.Types.ObjectId.isValid(value);
}

// Validate + normalize an admin-submitted `variants` array.
// Works with either a plain array (new products / full replacement) or an
// array of { _id?, unit, price, stock, active } objects (existing variants).
// Returns { variants } on success or throws { status: 400, message }.
function normalizeVariants(value) {
    if (value === undefined || value === null) return { variants: undefined };
    if (!Array.isArray(value)) {
        throw { status: 400, message: "variants must be an array" };
    }
    const errors = [];
    const raw = value.filter(function (v) { return v != null; });
    const seenUnits = new Set();
    const seenIds = new Set();
    const variants = raw.map(function (v, i) {
        const unit = String(v.unit || "").trim();
        if (!unit) errors.push("Variant " + (i + 1) + ": unit is required");
        else if (seenUnits.has(unit.toLowerCase())) errors.push("Duplicate variant unit: " + unit);
        else seenUnits.add(unit.toLowerCase());

        const price = Number(v.price);
        if (!Number.isFinite(price) || price < 0) errors.push("Variant " + (i + 1) + " (" + (unit || "?") + "): price must be 0 or more");

        const stock = Number(v.stock);
        if (!Number.isFinite(stock) || stock < 0 || !Number.isInteger(stock)) errors.push("Variant " + (i + 1) + " (" + (unit || "?") + "): stock must be a whole number");

        const active = v.active === undefined || v.active === null || String(v.active) !== "false";

        const entry = { unit: unit || "Variant " + (i + 1), price: Math.max(0, round2(price)), stock: Math.max(0, Math.floor(stock) || 0), active: !!active };
        if (v._id && isValidObjectId(v._id)) {
            if (seenIds.has(String(v._id))) errors.push("Duplicate variant id: " + v._id);
            seenIds.add(String(v._id));
            entry._id = v._id;
        }
        return entry;
    });

    if (errors.length) throw { status: 400, message: errors[0] };
    return { variants: variants };
}

// Server-side availability check for a variant line item.
// `qty` must already be a positive integer. Throws { status: 400, message }
// with a customer-safe reason when the variant is unknown/disabled/out of stock.
function assertVariantAvailable(product, variantId, qty) {
    if (!product.variants || !product.variants.length) {
        throw { status: 400, message: "This product does not have pack variants" };
    }
    const variant = product.variants.find(function (v) { return String(v._id) === String(variantId); });
    if (!variant) throw { status: 400, message: "Selected pack not found for this product" };
    if (!variant.active) throw { status: 400, message: "This pack is no longer selling" };
    if (variant.stock < qty) {
        throw { status: 400, message: "Only " + variant.stock + " of " + product.name + " (" + variant.unit + ") left in stock" };
    }
    return variant;
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

module.exports = { normalizeVariants, assertVariantAvailable, isValidObjectId, round2 };