// ===============================
// CART CONTROLLER (persistent DB cart)
// ===============================

const Cart = require("../models/Cart");
const Product = require("../models/Product");
const mongoose = require("mongoose");
const { getMultFromWeight, round2 } = require("../utils/pricing");

// Resolve the variant a cart item points at (null when legacy/weight-mult).
function resolveVariant(p, variantId) {
    if (!variantId || !p || !p.variants || !p.variants.length) return null;
    if (!mongoose.Types.ObjectId.isValid(String(variantId))) return null;
    return p.variants.find(function (v) { return String(v._id) === String(variantId); }) || null;
}

// Validate/normalize incoming cart items
function normalizeItems(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    items.forEach(function (it) {
        if (!it || !it.product) return;
        const qty = parseInt(it.quantity, 10);
        out.push({
            product: it.product,
            quantity: Math.max(1, Math.min(99, isNaN(qty) ? 1 : qty)),
            weight: it.weight || null,
            unit: it.unit || null,
            variantId: it.variantId && mongoose.Types.ObjectId.isValid(String(it.variantId)) ? it.variantId : null,
            variantUnit: it.variantUnit || null
        });
    });
    return out;
}

// Build API-facing item view (with live DB prices)
function toItemView(it) {
    const p = it.product;
    if (!p || p.active === false) return null;
    const variant = resolveVariant(p, it.variantId);
    if (variant) {
        return {
            product: p._id,
            name: p.name,
            unit: p.unit,
            basePrice: variant.price,
            price: round2(variant.price),
            quantity: it.quantity,
            weight: it.weight,
            variantId: variant._id,
            variantUnit: variant.unit,
            active: variant.active && variant.stock > 0
        };
    }
    const mult = getMultFromWeight(it.weight, p.unit);
    return {
        product: p._id,
        name: p.name,
        unit: p.unit,
        basePrice: p.price,
        price: round2(p.price * mult),
        quantity: it.quantity,
        weight: it.weight,
        variantId: null,
        variantUnit: null,
        active: p.stock > 0
    };
}

// GET /api/cart
exports.getCart = async (req, res) => {
    try {
        const cart = await Cart.findOne({ user: req.user._id }).populate("items.product");
        if (!cart) {
            return res.json({ success: true, data: { items: [] } });
        }
        const items = (cart.items || []).map(toItemView).filter(Boolean);
        res.json({ success: true, data: { items } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /api/cart (replace whole cart for the logged-in user)
exports.setCart = async (req, res) => {
    try {
        const items = normalizeItems(req.body.items || []);
        const ids = items.map(it => it.product);
        const products = await Product.find({ _id: { $in: ids } });
        const byId = new Map(products.map(p => [String(p._id), p]));

        for (const it of items) {
            const p = byId.get(String(it.product));
            if (!p || p.active === false) {
                return res.status(400).json({
                    success: false,
                    message: (p ? p.name : it.product) + " is no longer available"
                });
            }
            const variant = resolveVariant(p, it.variantId);
            if (variant) {
                if (!variant.active) {
                    return res.status(400).json({
                        success: false,
                        message: p.name + " (" + variant.unit + ") is no longer available"
                    });
                }
                if (variant.stock <= 0) {
                    return res.status(400).json({
                        success: false,
                        message: p.name + " (" + variant.unit + ") is out of stock"
                    });
                }
                it.variantUnit = variant.unit;
                it.quantity = Math.min(it.quantity, variant.stock);
            } else {
                if (it.variantId) {
                    return res.status(400).json({
                        success: false,
                        message: p.name + " pack is no longer available. Please pick another."
                    });
                }
                if (p.stock <= 0) {
                    return res.status(400).json({
                        success: false,
                        message: p.name + " is out of stock"
                    });
                }
                it.quantity = Math.min(it.quantity, p.stock);
                it.variantId = null;
                it.variantUnit = null;
            }
        }

        let cart = await Cart.findOne({ user: req.user._id });
        if (!cart) cart = new Cart({ user: req.user._id });
        cart.items = items;
        await cart.save();
        res.json({ success: true, data: { items } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/cart/merge (merge guest local cart into the DB cart, combine quantities)
exports.mergeCart = async (req, res) => {
    try {
        const guestItems = Array.isArray(req.body.items) ? req.body.items : [];

        let cart = await Cart.findOne({ user: req.user._id });
        if (!cart) cart = new Cart({ user: req.user._id });

        // Map existing DB items by (product name + pack variant) - lowercase
        const byKey = new Map();
        for (const it of cart.items || []) {
            if (!it.product) continue;
            const p = await Product.findById(it.product);
            if (!p) continue;
            byKey.set(String(p.name).toLowerCase() + "|" + String(it.variantId || ""), {
                product: p._id,
                quantity: it.quantity,
                weight: it.weight,
                unit: it.unit,
                variantId: it.variantId || null,
                variantUnit: it.variantUnit || null
            });
        }

        // Merge guest items (identified by name + pack) into the keyed map
        for (const g of guestItems) {
            if (!g || !g.name) continue;
            const qty = Math.max(1, Math.min(99, parseInt(g.quantity, 10) || 1));
            const gVid = g.variantId && mongoose.Types.ObjectId.isValid(String(g.variantId)) ? String(g.variantId) : "";
            const key = String(g.name).toLowerCase() + "|" + gVid;
            const found = byKey.get(key);
            if (found) {
                found.quantity = Math.min(99, found.quantity + qty);
            } else {
                const p = await Product.findOne({ name: g.name, active: true });
                if (!p) continue;
                byKey.set(key, {
                    product: p._id,
                    quantity: qty,
                    weight: g.qtyLabel || g.weight || null,
                    unit: g.unit || p.unit,
                    variantId: gVid || null,
                    variantUnit: g.variantId ? (g.variantUnit || null) : null
                });
            }
        }

        cart.items = Array.from(byKey.values());
        await cart.save();

        const populated = await Cart.findById(cart._id).populate("items.product");
        const items = ((populated && populated.items) || []).map(toItemView).filter(Boolean);
        res.json({ success: true, data: { items } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE /api/cart (clear cart for the logged-in user)
exports.clearCart = async (req, res) => {
    try {
        await Cart.findOneAndDelete({ user: req.user._id });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};