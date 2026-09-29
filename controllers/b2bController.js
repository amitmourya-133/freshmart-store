// ===============================
// B2B SUPPLY CONTROLLER (Phase 3.7)
// Bulk supply for registered buyers (restaurants, kirana, resellers).
// Rules:
//   * Only a role-"b2b_customer" with an admin-approved profile reaches these
//     endpoints (middleware/auth.js b2b guard).
//   * All prices come from the Product b2bPrice (server-side); the client can
//     never set its own price or discount. Minimum order quantity (b2bMinQty)
//     is enforced per line.
//   * Payment is either "credit" (admin-approved limit, tracked per order and
//     audited by cancellation/refund) or "manual" (unpaid UNTIL the admin
//     verifies the transfer — never assumed paid).
//   * Credit exposure is bounded: a credit order can never push the buyer over
//     their approved creditLimit at booking time.
// ===============================

const crypto = require("crypto");
const Product = require("../models/Product");
const Order = require("../models/Order");
const User = require("../models/User");
const notificationController = require("../controllers/notificationController");
const analytics = require("../utils/analytics");

function round2(n) {
    return Math.round(n * 100) / 100;
}

function invoiceNumberFor() {
    const d = new Date();
    const ymd = d.getUTCFullYear() +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0");
    return "INV-" + ymd + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// Amount currently on credit for a buyer (b2b orders in "credit" mode that are
// not cancelled/refunded).
async function creditUsedFor(userId) {
    const rows = await Order.aggregate([
        { $match: { user: require("mongoose").Types.ObjectId(String(userId)), orderType: "b2b", paymentMode: "credit", status: { $ne: "Cancelled" } } },
        { $group: { _id: null, used: { $sum: { $ifNull: ["$total", 0] } }, open: { $sum: { $cond: [{ $in: ["$status", ["Delivered", "Completed", "Out for Delivery", "Confirmed", "Placed"]] }, { $ifNull: ["$total", 0] }, 0] } } } },
    ]);
    return rows.length ? rows[0] : { used: 0, open: 0 };
}

// GET /api/b2b/products — B2B tier list (b2b guard). Returns only fields the
// buyer needs (b2bPrice/b2bMinQty included; retail wholesale values excluded).
exports.b2bProducts = async (req, res) => {
    try {
        const products = await Product.find({ active: true, b2bPrice: { $gt: 0 } })
            .sort({ category: 1, name: 1 })
            .select("_id name category unit b2bPrice b2bMinQty stock image gradient description")
            .lean();
        res.json({ success: true, count: products.length, data: products });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Core builder used by both the HTTP handler and the recurring processor.
// Throws { status, message }; returns { order, creditStatus } when the order
// was persisted with stock reserved.
async function buildB2BOrder(buyer, body, opts) {
    const { items, poNumber, deliverySlot, deliveryAddress } = body;
    if (!Array.isArray(items) || !items.length) throw Object.assign(new Error("Order items are required"), { status: 400 });

    const canUseCredit = buyer.b2bApproved === true && buyer.creditLimit > 0;
    const creditState = canUseCredit ? await creditUsedFor(buyer._id) : { used: 0, open: 0 };

    const lines = [];
    let subtotal = 0;
    for (const it of items) {
        if (!it || !it.productId) throw Object.assign(new Error("Each line needs a productId"), { status: 400 });
        const product = await Product.findOne({ _id: it.productId, active: true }).lean();
        if (!product) throw Object.assign(new Error("Product unavailable"), { status: 400 });
        if (!product.b2bPrice || product.b2bPrice <= 0) throw Object.assign(new Error(product.name + " has no B2B bulk pricing"), { status: 400 });
        const qty = Number(it.quantity);
        if (!Number.isInteger(qty) || qty < product.b2bMinQty) {
            throw Object.assign(new Error(product.name + " requires a minimum quantity of " + product.b2bMinQty + " " + (product.unit || "units")), { status: 400 });
        }
        if (qty > 100000) throw Object.assign(new Error("Quantity too large for " + product.name), { status: 400 });
        lines.push({
            name: product.name,
            price: round2(product.b2bPrice),
            quantity: qty,
            quantityUnit: product.unit || "kg",
            b2bMinQty: product.b2bMinQty,
            productId: product._id,
            b2b: true,
            basePrice: product.b2bPrice,
        });
        subtotal += round2(product.b2bPrice * qty);
    }
    subtotal = round2(subtotal);
    const total = subtotal;

    if (canUseCredit) {
        if (round2(creditState.open + total) > buyer.creditLimit) {
            throw Object.assign(new Error("This order would exceed your credit limit (approved ₹" + buyer.creditLimit + ")."), { status: 400 });
        }
    }

    const reserved = [];
    for (const line of lines) {
        const res = await Product.updateOne(
            { _id: line.productId, active: true, stock: { $gte: line.quantity } },
            { $inc: { stock: -line.quantity } }
        );
        if (!(res && res.modifiedCount === 1)) {
            for (const r of reserved) await Product.updateOne({ _id: r.productId }, { $inc: { stock: r.quantity } }).catch(() => {});
            const prod = await Product.findById(line.productId).lean();
            throw Object.assign(new Error("Insufficient stock for " + ((prod && prod.name) || line.name) + " (available " + ((prod && prod.stock) || 0) + ")"), { status: 400 });
        }
        reserved.push(line);
    }

    const addr = deliveryAddress || null;
    const customerBlock = {
        name: String((addr && addr.name) || buyer.b2bProfile.businessName || buyer.name || "B2B customer").slice(0, 100),
        phone: String((addr && addr.phone) || buyer.phone || "").slice(0, 20),
        address: String((addr && addr.address) || "").slice(0, 200) || "Bulk supply delivery",
        city: String((addr && addr.city) || "").slice(0, 60),
        state: (addr && addr.state) ? String(addr.state).slice(0, 40) : null,
        pincode: String((addr && addr.pincode) || "000000").slice(0, 10),
    };
    if (!customerBlock.phone || !customerBlock.name || !customerBlock.address || !customerBlock.pincode) {
        for (const r of reserved) await Product.updateOne({ _id: r.productId }, { $inc: { stock: r.quantity } }).catch(() => {});
        throw Object.assign(new Error("Supply address (name, phone, address, city, pincode) is required"), { status: 400 });
    }

    const paymentMode = canUseCredit && buyer.creditLimit > 0 ? "credit" : "manual";
    const invoiceNumber = invoiceNumberFor();

    const order = await Order.create({
        orderNumber: "B2B" + Date.now().toString().slice(-6),
        trackingId: "FM-" + new Date().getTime().toString().slice(-4) + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
        orderType: "b2b",
        invoiceNumber: invoiceNumber,
        poNumber: String(poNumber || "").trim().slice(0, 40) || null,
        customer: customerBlock,
        items: lines.map(function (l) { return { name: l.name, price: l.price, quantity: l.quantity, productId: l.productId }; }),
        payment: paymentMode === "credit" ? "Credit" : "UPI - Online",
        paymentMethod: paymentMode === "credit" ? "credit" : "online",
        paymentMode: paymentMode,
        subtotal: subtotal,
        delivery: 0,
        discount: 0,
        total: total,
        status: "Placed",
        user: buyer._id,
        customerEmail: buyer.email || null,
        deliverySlot: String(deliverySlot || "Morning (8-11 AM)").slice(0, 60),
        recurring: {},
        statusHistory: [{ status: "Placed", by: "b2b:" + String(buyer._id), at: new Date() }],
    });

    analytics.track({
        eventName: "b2b_order_created",
        userId: buyer._id,
        orderId: String(order._id),
        metadata: {
            invoiceNumber: invoiceNumber,
            total: total,
            itemCount: lines.length,
            paymentMode: paymentMode,
            creditOpen: paymentMode === "credit" ? round2(creditState.open + total) : null,
        },
    });

    notificationController.notifyRole("admin", {
        type: "b2b",
        title: "New B2B order " + invoiceNumber,
        message: (buyer.b2bProfile.businessName || buyer.name) + " ordered ₹" + total + " (" + paymentMode + ").",
        data: { link: "admin.html" },
    }).catch(function () { /* non-fatal */ });

    const creditStatus = {
        mode: paymentMode,
        creditUsed: round2(creditState.open + total),
        creditLimit: buyer.creditLimit || 0,
    };
    return { order, creditStatus };
}

// POST /api/b2b/orders — create a bulk order. Payment mode is decided from the
// buyer's credit terms (server-side), never from the request.
exports.createB2BOrder = async (req, res) => {
    try {
        const result = await buildB2BOrder(req.user, req.body);
        res.status(201).json({ success: true, data: result.order, creditStatus: result.creditStatus });
    } catch (error) {
        const status = error && error.status ? error.status : 400;
        res.status(status).json({ success: false, message: error.message });
    }
};

// GET /api/b2b/orders — my invoices (b2b buyer only).
exports.myB2BOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id, orderType: "b2b" })
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        res.json({ success: true, count: orders.length, data: orders.map(function (o) {
            return {
                _id: o._id,
                orderNumber: o.orderNumber,
                invoiceNumber: o.invoiceNumber,
                poNumber: o.poNumber || null,
                createdAt: o.createdAt,
                status: o.status,
                paymentMode: o.paymentMode,
                paymentStatus: o.paymentStatus,
                total: o.total,
                itemCount: Array.isArray(o.items) ? o.items.length : 0,
            };
        }) });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET /api/b2b/credit — buyer's credit standing.
exports.myCredit = async (req, res) => {
    try {
        const state = await creditUsedFor(req.user._id);
        res.json({
            success: true,
            data: {
                approved: req.user.b2bApproved === true,
                creditLimit: req.user.creditLimit || 0,
                creditTermsDays: req.user.creditTermsDays || 0,
                creditUsed: round2(state.used),
                creditOpen: round2(state.open),
                creditAvailable: Math.max(0, round2((req.user.creditLimit || 0) - state.open)),
            },
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/b2b/orders/:id/recurring — schedule a recurring re-order.
exports.scheduleRecurring = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.user._id, orderType: "b2b" });
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });
        const freq = Number(req.body.frequencyDays);
        if (!Number.isInteger(freq) || freq < 7 || freq > 365) return res.status(400).json({ success: false, message: "frequencyDays must be 7..365" });
        order.recurring = {
            active: true,
            frequencyDays: freq,
            nextRunAt: new Date(Date.now() + freq * 24 * 60 * 60 * 1000),
            baseOrder: order._id,
        };
        await order.save();
        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST /api/b2b/orders/:id/recurring/cancel
exports.cancelRecurring = async (req, res) => {
    try {
        const order = await Order.findOne({ _id: req.params.id, user: req.user._id, orderType: "b2b" });
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });
        order.recurring = { active: false, frequencyDays: 0, nextRunAt: null, baseOrder: order._id };
        await order.save();
        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// ADMIN B2B MANAGEMENT
// ===============================

// Admin: list B2B buyers with their credit posture.
exports.adminAccounts = async (req, res) => {
    try {
        const users = await User.find({ role: "b2b_customer" }).select("name email phone b2bProfile creditLimit creditTermsDays b2bApproved createdAt").lean();
        const out = [];
        for (const u of users) {
            const state = await creditUsedFor(u._id);
            out.push(Object.assign({
                _id: u._id,
                name: u.name,
                email: u.email,
                phone: u.phone,
                b2bProfile: u.b2bProfile || null,
                creditLimit: u.creditLimit || 0,
                creditTermsDays: u.creditTermsDays || 0,
                b2bApproved: !!u.b2bApproved,
                creditUsed: round2(state.used),
                creditOpen: round2(state.open),
                createdAt: u.createdAt,
            }, {}));
        }
        res.json({ success: true, count: out.length, data: out });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: set credit terms / approval. All fields are explicit; nothing is
// auto-granted. Lowering a limit never un-pays outstanding invoices — it only
// affects new order capacity (enforced at booking time).
exports.adminUpdateAccount = async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        if (req.body.b2bProfile !== undefined) {
            const p = req.body.b2bProfile || {};
            if (p.gstin && !/^[0-9A-Z]{15}$/.test(String(p.gstin).toUpperCase())) return res.status(400).json({ success: false, message: "GSTIN must be 15 characters" });
            if (!user.b2bProfile) user.b2bProfile = { bool: false };
            user.b2bProfile.bool = true;
            if (p.businessName) user.b2bProfile.businessName = String(p.businessName).slice(0, 120);
            if (p.gstin) user.b2bProfile.gstin = String(p.gstin).toUpperCase();
            if (p.purchaseOfficer) user.b2bProfile.purchaseOfficer = String(p.purchaseOfficer).slice(0, 120);
        }
        if (req.body.creditLimit !== undefined) {
            const lim = Number(req.body.creditLimit);
            if (!Number.isFinite(lim) || lim < 0 || lim > 100000000) return res.status(400).json({ success: false, message: "creditLimit must be a non-negative amount" });
            user.creditLimit = lim;
        }
        if (req.body.creditTermsDays !== undefined) {
            const d = Number(req.body.creditTermsDays);
            if (!Number.isInteger(d) || d < 0 || d > 180) return res.status(400).json({ success: false, message: "creditTermsDays must be 0..180" });
            user.creditTermsDays = d;
        }
        if (req.body.b2bApproved !== undefined) {
            if (typeof req.body.b2bApproved !== "boolean") return res.status(400).json({ success: false, message: "b2bApproved must be a boolean" });
            user.b2bApproved = req.body.b2bApproved;
        }
        await user.save();
        res.json({ success: true, data: { _id: user._id, b2bApproved: user.b2bApproved, creditLimit: user.creditLimit, creditTermsDays: user.creditTermsDays } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin/cron: create due recurring B2B orders (bounded batch).
exports.processRecurring = async (req, res) => {
    try {
        const limit = Math.min(Math.max(Number(req.body.limit) || 20, 1), 50);
        const due = await Order.find({
            "recurring.active": true,
            "recurring.nextRunAt": { $lte: new Date() },
            orderType: "b2b",
        }).sort({ "recurring.nextRunAt": 1 }).limit(limit);
        let created = 0;
        for (const base of due) {
            try {
                // Re-run the SAME line specification at current prices (buildB2BOrder
                // is server-authoritative; recurring orders never trust a stale price).
                const buyer = await User.findById(base.user).lean();
                if (!buyer || buyer.role !== "b2b_customer" || !buyer.b2bApproved) continue;
                if (!buyer.b2bProfile || !buyer.b2bProfile.bool) continue;
                const addr = base.customer || null;
                const order = await buildB2BOrder(buyer, {
                    items: base.items.map(function (i) { return { productId: String(i.productId || ""), quantity: i.quantity }; }).filter(function (i) { return i.productId; }),
                    deliverySlot: base.deliverySlot,
                    poNumber: base.poNumber || null,
                    deliveryAddress: {
                        name: addr && addr.name, phone: addr && addr.phone, address: addr && addr.address,
                        city: addr && addr.city, state: addr && addr.state, pincode: addr && addr.pincode,
                    },
                });
                // Advance the base schedule so the batch does not refire it.
                await Order.updateOne({ _id: base._id }, {
                    "recurring.nextRunAt": new Date(Date.now() + (base.recurring.frequencyDays || 30) * 24 * 60 * 60 * 1000),
                }).catch(function () { /* non-fatal */ });
                created++;
            } catch (e) { /* one bad base must never kill the batch */ }
        }
        res.json({ success: true, data: { scanned: due.length, created: created } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

module.exports.creditUsedFor = creditUsedFor;
module.exports.buildB2BOrder = buildB2BOrder;