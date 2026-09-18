// ===============================
// ORDER CONTROLLER
// ===============================

const crypto = require("crypto");
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const Settings = require("../models/Settings");
const Coupon = require("../models/Coupon");
const { getMultFromWeight, round2 } = require("../utils/pricing");
const { findValidCoupon, computeCouponDiscount, normalizeCode } = require("../utils/coupons");
const emailService = require("../utils/emailService");

// Best-effort notification sending wrapper. Never throws; never affects the
// request's order state. Logs a sanitized failure line (no secrets).
async function notifyCustomer(emailFn, order, extra) {
    try {
        const result = await emailFn({ to: order.customerEmail, order: order, ...extra });
        if (result && result.sent) {
            return { sent: true };
        }
        if (result && result.reason) {
            console.warn("[email] " + (order.orderNumber || "?") + " " + (extra.tag || "") + " skipped: " + result.reason);
        }
        return { sent: false };
    } catch (e) {
        console.warn("[email] " + (order.orderNumber || "?") + " " + (extra.tag || "") + " error: " + (e && e.message ? e.message : "unknown"));
        return { sent: false };
    }
}

// Lift email + timestamp flags onto the order document (best-effort).
async function recordNotify(order, field, at) {
    try {
        const patch = {};
        patch[field] = at || new Date();
        await Order.updateOne({ _id: order._id }, { $set: patch });
    } catch (e) { /* non-fatal */ }
}

const ORDER_STATUSES = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];
const STATUS_RANK = { Placed: 0, Confirmed: 1, Preparing: 2, "Out for Delivery": 3, Delivered: 4 };
const PAYMENT_STATUSES = ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED", "PENDING_REFUND"];
const PAYMENT_TRANSITIONS = {
    PENDING: ["PAID", "CANCELLED", "FAILED"],
    PAID: ["REFUNDED"],
    FAILED: ["CANCELLED"],
    CANCELLED: [],
    REFUNDED: [],
    PENDING_REFUND: ["REFUNDED"]
};

// ---------- helpers ----------

function generateOrderNumber() {
    return "FM" + Date.now().toString().slice(-6);
}

// FM-YYYYMMDD-XXXXXX (human readable, safe for public tracking)
function generateTrackingId() {
    const d = new Date();
    const ymd = d.getUTCFullYear() +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0");
    return "FM-" + ymd + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// Returns an error message string or null when the address is valid (India, lenient)
function validateCustomer(c) {
    if (!c || typeof c !== "object") return "Delivery details are required";
    if (!c.name || String(c.name).trim().length < 2) return "Please enter your full name";
    if (!/^[6-9]\d{9}$/.test(String(c.phone || "").trim())) return "Please enter a valid 10-digit mobile number";
    if (!c.address || String(c.address).trim().length < 4) return "Please enter your delivery address";
    if (!c.city || String(c.city).trim().length < 2) return "Please enter your city";
    if (!/^\d{6}$/.test(String(c.pincode || "").trim())) return "Please enter a valid 6-digit pincode";
    return null;
}

function pushHistory(order, status, by) {
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    order.statusHistory.push({ status: status, by: by || null, at: new Date() });
}

// Delivery + minimum-order policy from the DB-backed settings
// (fallbacks: Rs.20 fee, free >= Rs.500, no minimum order).
async function deliveryPolicy() {
    const doc = await Settings.getSettings();
    return {
        charge: Number(doc.deliveryCharge) >= 0 ? Number(doc.deliveryCharge) : 20,
        freeThreshold: Number(doc.freeDeliveryThreshold) >= 0 ? Number(doc.freeDeliveryThreshold) : 500,
        minimumOrder: Number(doc.minimumOrderValue) > 0 ? Number(doc.minimumOrderValue) : 0
    };
}

// Server-authoritative totals. Products are re-priced from MongoDB whenever a
// productId is present; items without a productId use the client price but are
// still clamped to a positive value and the whole subtotal must be >= 1.
// Coupon discounts are always recomputed from the Coupon document (the client
// coupon value is never trusted). Throws { status, message } on failure.
async function computeServerTotals(items, options) {
    if (!Array.isArray(items) || items.length === 0) {
        throw { status: 400, message: "Cart is empty" };
    }
    const normalized = [];
    let serverSubtotal = 0;
    for (const item of items) {
        if (!item || typeof item !== "object") {
            throw { status: 400, message: "Invalid item in cart" };
        }
        const qty = parseInt(item.quantity, 10);
        if (!Number.isInteger(qty) || qty < 1) {
            throw { status: 400, message: "Invalid quantity for " + (item.name || "item") };
        }
        if (item.productId) {
            const product = await Product.findById(item.productId);
            if (!product || !product.active) {
                throw { status: 400, message: (item.name || "Item") + " is no longer available" };
            }
            if (product.stock < qty) {
                throw { status: 400, message: "Only " + product.stock + " units of " + product.name + " in stock" };
            }
            const mult = getMultFromWeight(item.weight, product.unit);
            const itemPrice = round2(product.price * mult);
            serverSubtotal += round2(itemPrice * qty);
            normalized.push({
                name: product.name,
                price: itemPrice,
                quantity: qty,
                weight: item.weight || null,
                productId: product._id
            });
        } else {
            const price = round2(Number(item.price) || 0);
            serverSubtotal += round2(price * qty);
            normalized.push({
                name: String(item.name || "Item").slice(0, 120),
                price: price,
                quantity: qty,
                weight: item.weight || null,
                productId: undefined
            });
        }
    }
    const subtotal = round2(serverSubtotal);
    if (subtotal < 1) {
        throw { status: 400, message: "Minimum order amount is Rs.1. Please add more items." };
    }
    const policy = await deliveryPolicy();
    if (policy.minimumOrder > 0 && subtotal < policy.minimumOrder) {
        throw {
            status: 400,
            message: "Your order is below the minimum order value of ₹" + policy.minimumOrder + ". Add items worth ₹" +
                (policy.minimumOrder - subtotal) + " more."
        };
    }
    const delivery = subtotal >= policy.freeThreshold ? 0 : policy.charge;

    // Coupon discount (server-side only)
    let discount = 0;
    let couponInfo = null;
    const rawCode = options && options.couponCode ? options.couponCode : null;
    if (rawCode && String(rawCode).trim()) {
        const { coupon } = await findValidCoupon(rawCode);
        discount = computeCouponDiscount(coupon, subtotal);
        couponInfo = { _id: coupon._id, code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, minimumOrderValue: coupon.minimumOrderValue };
    }
    const total = round2(subtotal + delivery - discount);
    return {
        items: normalized,
        subtotal: subtotal,
        delivery: delivery,
        discount: discount,
        coupon: couponInfo,
        minimumOrderValue: policy.minimumOrder,
        freeDeliveryThreshold: policy.freeThreshold,
        deliveryCharge: policy.charge,
        total: total
    };
}

function normalizeCustomer(c) {
    return {
        name: String((c && c.name) || "").trim().slice(0, 100),
        phone: String((c && c.phone) || "").trim().slice(0, 20),
        address: String((c && c.address) || "").trim().slice(0, 200),
        city: String((c && c.city) || "").trim().slice(0, 60),
        state: (c && c.state) ? String(c.state).trim().slice(0, 40) : null,
        pincode: String((c && c.pincode) || "").trim().slice(0, 10)
    };
}

// Restore stock for cancelled orders (once).
async function restoreStockOnce(order) {
    if (!order.items) return;
    for (const item of order.items) {
        if (item.productId) {
            await Product.findByIdAndUpdate(item.productId, { $inc: { stock: item.quantity } });
        }
    }
}

// Shared cancellation logic (admin + customer). Idempotent per order.
async function applyCancellation(order, by) {
    if (order.status === "Cancelled") return { ok: false, message: "Order is already cancelled" };
    if (order.status === "Delivered") return { ok: false, message: "Delivered orders cannot be cancelled" };

    await restoreStockOnce(order);

    if (order.paid || order.paymentStatus === "PAID") {
        // COD / UPI-manual payment was never settled through a gateway:
        // there is no money to "return", so the payment is simply voided.
        // No fake "REFUNDED" claim.
        order.paymentStatus = "CANCELLED";
        order.refund.reference = (order.refund && order.refund.reference) || "STORE-CREDIT";
    } else {
        order.paymentStatus = "CANCELLED";
    }

    order.status = "Cancelled";
    pushHistory(order, "Cancelled", by);
    await order.save();
    return { ok: true, order: order };
}

// ===============================
// CREATE ORDER
// ===============================
exports.createOrder = async (req, res) => {
    try {
        const { customer, items, payment, paymentMethod, paid, deliverySlot, subscription, subscriptionPlan, clientRef, paymentReference, couponCode } = req.body;

        // Server-side address validation
        const customerError = validateCustomer(customer);
        if (customerError) {
            return res.status(400).json({ success: false, message: customerError });
        }

        // Idempotency: retrying the same clientRef returns the existing order
        // instead of creating a duplicate (double click / browser retry / webhook retry).
        if (clientRef && String(clientRef).trim()) {
            const existing = await Order.findOne({ clientRef: String(clientRef).trim() });
            if (existing) {
                return res.status(200).json({ success: true, data: existing, already: true });
            }
        }

        const totals = await computeServerTotals(items, { couponCode: couponCode });

        const orderNumber = generateOrderNumber();
        const trackingId = generateTrackingId();
        const finalPaymentMethod = paymentMethod === "online" ? "online" : "cod";

        // Customer email for notifications: prefer the verified account email,
        // then an explicitly supplied email on the request. Never an OTP/token.
        const suppliedEmail = customer && customer.email ? String(customer.email).trim() : "";
        const customerEmail = req.user && req.user.email
            ? String(req.user.email).trim()
            : (suppliedEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(suppliedEmail) ? suppliedEmail : null);

        const orderData = {
            orderNumber: orderNumber,
            trackingId: trackingId,
            clientRef: (clientRef && String(clientRef).trim()) ? String(clientRef).trim() : undefined,
            customer: normalizeCustomer(customer),
            items: totals.items,
            payment: payment || (finalPaymentMethod === "cod" ? "Cash On Delivery" : "UPI - Online"),
            paymentMethod: finalPaymentMethod,
            subtotal: totals.subtotal,
            delivery: totals.delivery,
            discount: totals.discount,
            couponCode: totals.coupon ? totals.coupon.code : null,
            deliverySlot: deliverySlot || "Morning (8-11 AM)",
            subscription: subscription === true,
            subscriptionPlan: subscriptionPlan || null,
            total: totals.total,
            status: "Placed",
            user: req.user ? req.user._id : null,
            customerEmail: customerEmail
        };

        if (finalPaymentMethod === "cod") {
            orderData.paid = true;
            orderData.paymentStatus = "PAID";
            orderData.paymentMode = "cod";
            orderData.paymentAt = new Date();
            orderData.payment = "Cash On Delivery";
        } else if (paid === true) {
            // Manual UPI/QR confirmation: kept explicitly unverified until an
            // admin confirms the transfer. Never treated as gateway-paid.
            orderData.paid = false;
            orderData.paymentStatus = "PENDING";
            orderData.paymentMode = "manual";
            orderData.paymentReference = (paymentReference && String(paymentReference).trim()) || null;
        } else if (req.body.paymentMode === "manual") {
            // Manual UPI/QR flow (demo QR / "I have paid"): explicitly unverified
            orderData.paid = false;
            orderData.paymentStatus = "PENDING";
            orderData.paymentMode = "manual";
            orderData.paymentReference = (paymentReference && String(paymentReference).trim()) || null;
        } else {
            // Online (UPI) default: unpaid until admin verifies the transfer
            orderData.paid = false;
            orderData.paymentStatus = "PENDING";
            orderData.paymentMode = "manual";
            orderData.paymentReference = (paymentReference && String(paymentReference).trim()) || null;
        }

        // Reserve coupon usage BEFORE persisting the order so concurrent orders
        // cannot overshoot the usage limit. The increment is compensated if the
        // order creation itself fails immediately afterwards.
        let reservedCoupon = null;
        if (totals.coupon) {
            reservedCoupon = await Coupon.findOneAndUpdate(
                { _id: totals.coupon._id, active: true, $expr: {
                    $or: [
                        { $eq: ["$usageLimit", null] },
                        { $lt: ["$usageCount", "$usageLimit"] }
                    ]
                } },
                { $inc: { usageCount: 1 } },
                { new: true }
            );
            if (!reservedCoupon) {
                return res.status(400).json({ success: false, message: "This coupon has reached its usage limit" });
            }
        }

        // Decrement stock (order created => reservation). Payment success/failure
        // does not touch stock; only cancellation restores it (see cancellation).
        for (const item of totals.items) {
            if (item.productId) {
                await Product.findByIdAndUpdate(item.productId, { $inc: { stock: -item.quantity } });
            }
        }

        let order;
        try {
            order = await Order.create(Object.assign(orderData, { statusHistory: [{ status: "Placed", by: req.user ? "customer:" + String(req.user._id) : "guest", at: new Date() }] }));
        } catch (createError) {
            // Compensate the reserved usage count so retries do not burn the limit.
            if (reservedCoupon) {
                try { await Coupon.updateOne({ _id: reservedCoupon._id }, { $inc: { usageCount: -1 } }); } catch (e) { /* non-fatal */ }
            }
            throw createError;
        }

        res.status(201).json({
            success: true,
            data: order
        });

        // Order confirmation email (fire-and-forget; never blocks or fails the
        // response). The flag is recorded only when the send actually succeeded,
        // so a retry with a new attempt is not suppressed forever.
        if (order.customerEmail) {
            notifyCustomer(emailService.sendOrderConfirmation, order, { tag: "confirmation" })
                .then(async function (res2) {
                    if (res2.sent) await recordNotify(order, "notifyConfirmSentAt", new Date());
                });
        }
    } catch (error) {
        if (error && error.status) {
            return res.status(error.status).json({ success: false, message: error.message });
        }
        if (error && error.name === "CastError") {
            return res.status(400).json({ success: false, message: "Invalid product in cart" });
        }
        res.status(400).json({ success: false, message: error.message });
    }
};

// ===============================
// QUOTE ORDER (server-validated totals, nothing persisted)
// ===============================
exports.quoteOrder = async (req, res) => {
    try {
        const totals = await computeServerTotals(req.body.items, { couponCode: req.body.couponCode });
        res.json({
            success: true,
            data: {
                subtotal: totals.subtotal,
                delivery: totals.delivery,
                deliveryCharge: totals.deliveryCharge,
                freeDeliveryThreshold: totals.freeDeliveryThreshold,
                minimumOrderValue: totals.minimumOrderValue,
                minOrderAmount: totals.minimumOrderValue,
                discount: totals.discount,
                coupon: totals.coupon ? { code: totals.coupon.code, discountType: totals.coupon.discountType, discountValue: totals.coupon.discountValue } : null,
                total: totals.total
            }
        });
    } catch (error) {
        if (error && error.status) {
            return res.status(error.status).json({ success: false, message: error.message });
        }
        res.status(400).json({ success: false, message: error.message });
    }
};

// ===============================
// GET ALL ORDERS (admin, with filters + search)
// ===============================
exports.getOrders = async (req, res) => {
    try {
        const { status, paymentStatus, search } = req.query;
        const filter = {};
        if (status && ORDER_STATUSES.includes(status)) filter.status = status;
        if (paymentStatus && PAYMENT_STATUSES.includes(paymentStatus)) filter.paymentStatus = paymentStatus;
        if (search && String(search).trim()) {
            const s = String(search).trim();
            filter.$or = [
                { orderNumber: { $regex: s, $options: "i" } },
                { trackingId: { $regex: s, $options: "i" } },
                { "customer.name": { $regex: s, $options: "i" } },
                { "customer.phone": { $regex: s, $options: "i" } }
            ];
        }
        const orders = await Order.find(filter)
            .sort({ createdAt: -1 })
            .limit(200)
            .populate("user", "name email phone");
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// ADMIN OVERVIEW (dashboard metrics)
// ===============================
exports.getOverview = async (req, res) => {
    try {
        const settings = await Settings.getSettings();
        const defaultThreshold = settings.lowStockThreshold >= 1 ? settings.lowStockThreshold : 20;
        const threshold = Math.max(0, parseInt(req.query.threshold, 10) || defaultThreshold);
        const [totalProducts, totalCustomers, totalOrders, deliveredOrders, cancelledOrders, paidOrders, preparingOrders, salesAgg, activeAgg] = await Promise.all([
            Product.countDocuments(),
            User.countDocuments({ role: "customer" }),
            Order.countDocuments(),
            Order.countDocuments({ status: "Delivered" }),
            Order.countDocuments({ status: "Cancelled" }),
            Order.countDocuments({ paymentStatus: "PAID" }),
            Order.countDocuments({ status: "Preparing" }),
            Order.aggregate([{ $match: { status: { $ne: "Cancelled" } } }, { $group: { _id: null, total: { $sum: "$total" } } }]),
            Product.aggregate([
                { $match: { active: true } },
                { $group: { _id: null, low: { $sum: { $cond: [{ $lte: ["$stock", threshold] }, 1, 0] } }, out: { $sum: { $cond: [{ $lte: ["$stock", 0] }, 1, 0] } } } }
            ])
        ]);
        const nonCancelled = ORDER_STATUSES.filter((s) => s !== "Cancelled");
        const pendingOrders = await Order.countDocuments({ status: { $in: nonCancelled.filter((s) => s !== "Delivered") } });

        const agg = salesAgg[0] || { total: 0 };
        const stock = activeAgg[0] || { low: 0, out: 0 };

        res.json({
            success: true,
            data: {
                totalProducts: totalProducts,
                totalCustomers: totalCustomers,
                totalOrders: totalOrders,
                pendingOrders: pendingOrders,
                paidOrders: paidOrders,
                deliveredOrders: deliveredOrders,
                cancelledOrders: cancelledOrders,
                preparingOrders: preparingOrders,
                lowStockProducts: stock.low,
                outOfStockProducts: stock.out,
                totalSales: round2(agg.total),
                lowStockThreshold: threshold
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// GET MY ORDERS (customer, backend-enforced ownership)
// ===============================
exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// GET SINGLE ORDER (owner or admin only)
// ===============================
exports.getOrder = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id).populate("user", "name email phone");
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        const isAdmin = req.user && req.user.role === "admin";
        const isOwner = order.user && req.user && String(order.user) === String(req.user._id);
        if (!isAdmin && !isOwner) {
            return res.status(403).json({ success: false, message: "Not authorized to view this order" });
        }
        res.json({ success: true, data: order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// UPDATE ORDER STATUS (admin)
// ===============================

// Fire-and-forget notification on admin/customer status changes.
// A "Delivered" status sends the dedicated delivery confirmation exactly once
// (guarded by notifyDeliveredSentAt); other statuses send the generic status
// update, deduplicated per (status → sentAt) pair by notifyStatusFor.
function emailOnStatusChange(order, previousStatus) {
    if (!order.customerEmail) return;
    if (order.status === "Delivered") {
        if (order.notifyDeliveredSentAt) return;
        notifyCustomer(emailService.sendDeliveryConfirmation, order, { tag: "delivery" })
            .then(async function (r) {
                if (r.sent) {
                    await recordNotify(order, "notifyDeliveredSentAt", new Date());
                    await recordNotify(order, "notifyStatusSentAt", new Date());
                    await recordNotify(order, "notifyStatusFor", order.status);
                }
            });
        return;
    }
    if (order.notifyStatusFor === order.status && order.notifyStatusSentAt) return;
    notifyCustomer(emailService.sendOrderStatusUpdate, order, { tag: "status", previousStatus: previousStatus })
        .then(async function (r) {
            if (r.sent) {
                await recordNotify(order, "notifyStatusSentAt", new Date());
                await recordNotify(order, "notifyStatusFor", order.status);
            }
        });
}

exports.updateOrderStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!ORDER_STATUSES.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        if (order.status === status) {
            return res.json({ success: true, data: order });
        }

        // Prevent nonsensical/backwards transitions
        if (status === "Cancelled") {
            const previousStatus = order.status;
            const result = await applyCancellation(order, "admin:" + String(req.user._id));
            if (!result.ok) {
                return res.status(400).json({ success: false, message: result.message });
            }
            emailOnStatusChange(result.order, previousStatus);
            return res.json({ success: true, data: result.order });
        }

        if (order.status === "Cancelled" || order.status === "Delivered") {
            return res.status(400).json({ success: false, message: "Final status " + order.status + " cannot be changed" });
        }
        if (STATUS_RANK[status] < STATUS_RANK[order.status]) {
            return res.status(400).json({ success: false, message: "Cannot move status backwards" });
        }

        const previousStatus = order.status;
        order.status = status;
        pushHistory(order, status, "admin:" + String(req.user._id));
        await order.save();

        emailOnStatusChange(order, previousStatus);

        res.json({ success: true, data: order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// CUSTOMER CANCEL ORDER (backend-enforced)
// ===============================
exports.cancelOrder = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        if (!order.user || !req.user || String(order.user) !== String(req.user._id)) {
            return res.status(403).json({ success: false, message: "Not authorized to cancel this order" });
        }
        if (order.status !== "Placed" && order.status !== "Confirmed") {
            return res.status(400).json({ success: false, message: "Order can only be cancelled while placed or confirmed" });
        }

        const previousStatus = order.status;
        const result = await applyCancellation(order, "customer:" + String(req.user._id));
        if (!result.ok) {
            return res.status(400).json({ success: false, message: result.message });
        }
        emailOnStatusChange(result.order, previousStatus);
        res.json({ success: true, data: result.order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// ADMIN PAYMENT STATUS (manual verification / reject / store-level refund)
// ===============================
exports.updatePaymentStatus = async (req, res) => {
    try {
        const { paymentStatus, reference } = req.body;
        if (!PAYMENT_STATUSES.includes(paymentStatus)) {
            return res.status(400).json({ success: false, message: "Invalid payment status" });
        }

        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        const allowed = PAYMENT_TRANSITIONS[order.paymentStatus] || [];
        if (!allowed.includes(paymentStatus)) {
            return res.status(400).json({
                success: false,
                message: "Cannot change payment status from " + order.paymentStatus + " to " + paymentStatus
            });
        }

        order.paymentStatus = paymentStatus;
        if (paymentStatus === "PAID") {
            order.paid = true;
            order.paymentAt = new Date();
            if (reference && String(reference).trim()) order.paymentReference = String(reference).trim();
        } else if (paymentStatus === "REFUNDED") {
            order.refund.status = "store_credit";
            order.refund.reference = (reference && String(reference).trim()) || order.refund.reference || "STORE-CREDIT";
            order.refund.initiatedAt = order.refund.initiatedAt || new Date();
        }
        await order.save();

        res.json({ success: true, data: order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// PUBLIC TRACKING (safe fields only)
// ===============================
exports.getOrderByNumber = async (req, res) => {
    try {
        const n = String(req.params.number || "").trim();
        if (!n) {
            return res.status(400).json({ success: false, message: "Order reference required" });
        }
        const order = await Order.findOne({ $or: [{ orderNumber: n }, { trackingId: n }] });
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        // Tracking-only view: NEVER leak phone, address, payment ids or refund id
        res.json({
            success: true,
            data: {
                orderNumber: order.orderNumber,
                trackingId: order.trackingId,
                status: order.status,
                paymentStatus: order.paymentStatus,
                date: order.createdAt,
                items: (order.items || []).map(function (i) {
                    return { name: i.name || i.productName, quantity: i.quantity || 1, price: i.price || 0 };
                }),
                total: order.total,
                timeline: (order.statusHistory || []).map(function (h) {
                    return { status: h.status, at: h.at };
                })
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};