// ===============================
// CART CONTROLLER (persistent DB cart)
// ===============================

const Cart = require("../models/Cart");
const Product = require("../models/Product");
const { getMultFromWeight, round2 } = require("../utils/pricing");

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
            unit: it.unit || null
        });
    });
    return out;
}

// Build API-facing item view (with live DB prices)
function toItemView(it) {
    const p = it.product;
    if (!p || p.active === false) return null;
    const mult = getMultFromWeight(it.weight, p.unit);
    return {
        product: p._id,
        name: p.name,
        unit: p.unit,
        basePrice: p.price,
        price: round2(p.price * mult),
        quantity: it.quantity,
        weight: it.weight,
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
        for (const it of items) {
            const p = await Product.findById(it.product);
            if (!p || p.active === false) {
                return res.status(400).json({
                    success: false,
                    message: (p ? p.name : it.product) + " is no longer available"
                });
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

        // Map existing DB items by product name (lowercase)
        const byName = new Map();
        for (const it of cart.items || []) {
            if (!it.product) continue;
            const p = await Product.findById(it.product);
            if (!p) continue;
            byName.set(String(p.name).toLowerCase(), {
                product: p._id,
                quantity: it.quantity,
                weight: it.weight,
                unit: it.unit
            });
        }

        // Merge guest items (identified by name) into the map
        for (const g of guestItems) {
            if (!g || !g.name) continue;
            const key = String(g.name).toLowerCase();
            const qty = Math.max(1, Math.min(99, parseInt(g.quantity, 10) || 1));
            const found = byName.get(key);
            if (found) {
                found.quantity = Math.min(99, found.quantity + qty);
            } else {
                const p = await Product.findOne({ name: g.name, active: true });
                if (!p) continue;
                byName.set(key, {
                    product: p._id,
                    quantity: qty,
                    weight: g.qtyLabel || g.weight || null,
                    unit: g.unit || p.unit
                });
            }
        }

        cart.items = Array.from(byName.values());
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