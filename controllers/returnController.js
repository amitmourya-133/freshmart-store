// ===============================
// RETURN / REPLACEMENT / REFUND CONTROLLER
// COD-only returns. Customers can open a return only for delivered orders and
// can cancel it while it is still SUBMITTED. Admins drive the state machine
// and record the actual refund. Every amount is server-computed; client money
// values are never trusted.
// ===============================

const crypto = require("crypto");
const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const ReturnRequest = require("../models/ReturnRequest");
const InventoryLog = require("../models/InventoryLog");
const { parseImageDataUri } = require("../utils/productImage");
const { uploadImageBytes } = require("../utils/cloudinary");
const { assertVariantAvailable } = require("../utils/variants");

function isBadObjectId(id) {
    return !mongoose.Types.ObjectId.isValid(String(id || ""));
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

function generateReturnNumber() {
    const d = new Date();
    const ymd = d.getUTCFullYear() +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0");
    return "RR-" + ymd + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

// Valid state transitions. CANCELLED is customer-only and only from SUBMITTED.
const TRANSITIONS = {
    SUBMITTED: ["PROCESSING", "REJECTED", "CANCELLED"],
    PROCESSING: ["APPROVED", "REJECTED"],
    APPROVED: ["REFUND_PENDING", "REPLACEMENT_INITIATED"],
    REJECTED: [],
    CANCELLED: [],
    REFUND_PENDING: ["REFUND_PROCESSED"],
    REFUND_PROCESSED: ["CLOSED"],
    REPLACEMENT_INITIATED: ["REPLACEMENT_DELIVERED", "CLOSED"],
    REPLACEMENT_DELIVERED: ["CLOSED"],
    CLOSED: []
};

function pushTimeline(rt, status, by, note) {
    if (!Array.isArray(rt.timeline)) rt.timeline = [];
    rt.timeline.push({ status: status, by: by || null, at: new Date(), note: note || null });
}

async function restockReturnedItems(rt, byLabel, note) {
    if (!rt || rt.stockRestocked) return;
    for (const item of rt.items || []) {
        if (item.variantId) {
            // Positional filtered operator: only increment the exact matching
            // pack (plain $ would touch the wrong variant on multi-pack items).
            const res = await Product.updateOne(
                { _id: item.productId },
                { $inc: { "variants.$[elem].stock": item.quantity } },
                { arrayFilters: [{ "elem._id": item.variantId }] }
            );
            const variant = res && res.matchedCount === 1
                ? ((await Product.findById(item.productId).lean()) || {}).variants.find(function (v) { return String(v._id) === String(item.variantId); })
                : null;
            await logInv({
                product: item.productId, variantId: item.variantId, scope: "variant", change: item.quantity,
                previousStock: variant ? Math.max(0, variant.stock - item.quantity) : 0, newStock: variant ? variant.stock : 0,
                reason: "return_refund", changeRef: rt.returnNumber, note: note || (rt.returnType || "return")
            });
        } else {
            const product = await Product.findOneAndUpdate(
                { _id: item.productId },
                { $inc: { stock: item.quantity } },
                { new: true }
            );
            await logInv({
                product: item.productId, variantId: null, scope: "stock", change: item.quantity,
                previousStock: product ? Math.max(0, product.stock - item.quantity) : 0, newStock: product ? product.stock : 0,
                reason: "return_refund", changeRef: rt.returnNumber, note: note || (rt.returnType || "return")
            });
        }
    }
    rt.stockRestocked = true;
}

async function logInv(entry) {
    try {
        await InventoryLog.create(entry);
    } catch (e) {
        console.warn("[inventory] return log failed: " + (e && e.message ? e.message : "unknown"));
    }
}

// ===============================
// CREATE RETURN (customer)
// ===============================
exports.createReturn = async function (req, res) {
    try {
        const { orderId, items, returnType, reason, comments, proofImage } = req.body || {};

        if (isBadObjectId(orderId)) {
            return res.status(400).json({ success: false, message: "Valid order id required" });
        }
        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // Ownership: a logged-in customer must own the order; a guest may only
        // initiate against an anonymous order while proving name + phone.
        if (req.user) {
            if (!order.user || String(order.user) !== String(req.user._id)) {
                return res.status(403).json({ success: false, message: "You can only request returns for your own orders" });
            }
        } else {
            if (order.user) {
                return res.status(403).json({ success: false, message: "Please sign in to request a return" });
            }
            const c = req.body.customer || {};
            if (String(order.customer.phone || "") !== String(c.phone || "") ||
                String(order.customer.name || "").trim().toLowerCase() !== String(c.name || "").trim().toLowerCase()) {
                return res.status(403).json({ success: false, message: "Name and phone must match the order" });
            }
        }

        if (order.status !== "Delivered") {
            return res.status(400).json({ success: false, message: "Returns can only be requested for delivered orders" });
        }
        if (returnType !== "refund" && returnType !== "replacement") {
            return res.status(400).json({ success: false, message: "returnType must be 'refund' or 'replacement'" });
        }
        if (!reason || !String(reason).trim()) {
            return res.status(400).json({ success: false, message: "Please provide a return reason" });
        }

        // One active return request per order at a time.
        const active = await ReturnRequest.findOne({
            order: order._id,
            status: { $nin: ["REJECTED", "CANCELLED"] }
        });
        if (active) {
            return res.status(409).json({ success: false, message: "A return request is already open for this order" });
        }

        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, message: "Select at least one item to return" });
        }

        // Build the return lines from the ORDER (server-authoritative), never
        // from client prices/names. Quantity per line is capped at the order's.
        const orderItems = order.items || [];
        const returned = [];
        for (const it of items) {
            if (!it || !it.productId || isBadObjectId(it.productId)) {
                return res.status(400).json({ success: false, message: "Invalid return item" });
            }
            const matched = orderItems.find(function (oi) {
                return String(oi.productId || "") === String(it.productId) &&
                    String(oi.variantId || "0") === String(it.variantId || "0");
            });
            if (!matched) {
                return res.status(400).json({ success: false, message: "Item is not part of this order" });
            }
            const qty = parseInt(it.quantity, 10);
            if (!Number.isInteger(qty) || qty < 1 || qty > matched.quantity) {
                return res.status(400).json({ success: false, message: "Return quantity must be between 1 and " + matched.quantity + " for " + matched.name });
            }
            returned.push({
                productId: matched.productId,
                name: matched.name,
                price: matched.price,
                quantity: qty,
                variantId: matched.variantId || null,
                variantUnit: matched.variantUnit || null
            });
        }

        const safeProof = proofImage && /^https:\/\//i.test(String(proofImage)) ? String(proofImage).slice(0, 500) : null;

        const rt = await ReturnRequest.create({
            returnNumber: generateReturnNumber(),
            order: order._id,
            user: req.user ? req.user._id : null,
            customer: {
                name: String(req.user ? req.user.name : order.customer.name).slice(0, 100),
                phone: String((req.user && req.user.phone ? req.user.phone : (order.customer && order.customer.phone))).slice(0, 20),
                address: order.customer.address ? String(order.customer.address).slice(0, 200) : null,
                city: order.customer.city ? String(order.customer.city).slice(0, 60) : null,
                state: order.customer.state ? String(order.customer.state).slice(0, 40) : null,
                pincode: order.customer.pincode ? String(order.customer.pincode).slice(0, 10) : null
            },
            items: returned,
            returnType: returnType,
            reason: String(reason).trim().slice(0, 500),
            comments: comments && String(comments).trim() ? String(comments).trim().slice(0, 1000) : null,
            proofImage: safeProof,
            status: "SUBMITTED",
            timeline: []
        });
        pushTimeline(rt, "SUBMITTED", req.user ? "customer:" + String(req.user._id) : "guest", "Return requested for " + returnType);
        await rt.save();

        res.status(201).json({ success: true, data: rt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// LIST MY RETURNS (customer)
// ===============================
exports.listMyReturns = async function (req, res) {
    try {
        const returns = await ReturnRequest.find({ user: req.user._id }).sort({ createdAt: -1 });
        res.json({ success: true, count: returns.length, data: returns });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// GET ONE RETURN (owner or admin)
// ===============================
exports.getReturn = async function (req, res) {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        const rt = await ReturnRequest.findById(req.params.id).populate("order", "orderNumber total paymentStatus status");
        if (!rt) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        const isAdmin = req.user && req.user.role === "admin";
        const ownerOk = req.user && rt.user && String(rt.user) === String(req.user._id);
        if (!isAdmin && !ownerOk) {
            return res.status(403).json({ success: false, message: "Not authorized to view this return request" });
        }
        res.json({ success: true, data: rt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// CANCEL RETURN (customer, SUBMITTED only)
// ===============================
exports.cancelReturn = async function (req, res) {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        const rt = await ReturnRequest.findById(req.params.id);
        if (!rt) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        if (!req.user || !rt.user || String(rt.user) !== String(req.user._id)) {
            return res.status(403).json({ success: false, message: "You can only cancel your own return request" });
        }
        if (rt.status !== "SUBMITTED") {
            return res.status(400).json({ success: false, message: "Return request can only be cancelled before processing starts" });
        }
        rt.status = "CANCELLED";
        pushTimeline(rt, "CANCELLED", "customer:" + String(req.user._id), "Cancelled by customer");
        await rt.save();
        res.json({ success: true, data: rt });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// ADMIN: LIST RETURNS
// ===============================
exports.adminListReturns = async function (req, res) {
    try {
        const { status } = req.query;
        const filter = {};
        if (status && Object.keys(TRANSITIONS).includes(status)) filter.status = status;
        const returns = await ReturnRequest.find(filter)
            .sort({ createdAt: -1 })
            .limit(300)
            .populate("user", "name email phone")
            .populate("order", "orderNumber total paymentStatus status");
        res.json({ success: true, count: returns.length, data: returns });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// ADMIN: ADVANCE RETURN STATUS (+ record refund details)
// Transitions are strict. On REFUND_PROCESSED the refund payload is validated:
// a non-zero amount capped at the server-computed computedAmount, with a
// required method + reference. Money is only ever "returned" once.
// ===============================
exports.adminUpdateReturnStatus = async function (req, res) {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        const rt = await ReturnRequest.findById(req.params.id).populate("order", "_id total paymentStatus paid");
        if (!rt) {
            return res.status(404).json({ success: false, message: "Return request not found" });
        }
        const { status, refund } = req.body || {};
        const allowed = TRANSITIONS[rt.status] || [];
        if (allowed.indexOf(status) === -1) {
            return res.status(400).json({
                success: false,
                message: "Cannot move return " + rt.returnNumber + " from " + rt.status + " to " + status
            });
        }

        if (status === "APPROVED") {
            // Server-compute the refundable amount from the returned lines.
            const gross = round2((rt.items || []).reduce(function (sum, i) { return sum + round2(i.price * i.quantity); }, 0));
            rt.refund.computedAmount = round2(Math.min(gross, (rt.order && rt.order.total) || gross));
        }

        if (status === "REFUND_PROCESSED") {
            // Refund_details gate: once processed it can never be re-processed,
            // so a valid amount + method + reference are mandatory here.
            if (!refund || typeof refund !== "object" || !refund.method) {
                return res.status(400).json({ success: false, message: "Refund method is required to process the refund" });
            }
            const method = ["cash", "upi_transfer", "bank_transfer", "store_credit"].indexOf(refund.method) !== -1 ? refund.method : null;
            if (!method) {
                return res.status(400).json({ success: false, message: "Invalid refund method" });
            }
            const amount = round2(Number(refund.amount));
            if (!Number.isFinite(amount) || amount <= 0) {
                return res.status(400).json({ success: false, message: "Refund amount must be greater than 0" });
            }
            if (rt.refund.computedAmount <= 0) {
                return res.status(400).json({ success: false, message: "Refund was not approved with a payable amount" });
            }
            if (amount > rt.refund.computedAmount) {
                return res.status(400).json({
                    success: false,
                    message: "Refund amount (₹" + amount + ") cannot exceed the computed refundable ₹" + rt.refund.computedAmount
                });
            }
            rt.refund.amount = amount;
            rt.refund.method = method;
            rt.refund.reference = refund.reference && String(refund.reference).trim() ? String(refund.reference).trim().slice(0, 120) : ("RR-" + rt.returnNumber);
            rt.refund.processedAt = new Date();
            rt.refund.processedBy = req.user._id;
            rt.refund.note = refund.note && String(refund.note).trim() ? String(refund.note).trim().slice(0, 300) : null;

            // COD: a PAID order gets paymentStatus REFUNDED; an unpaid (PENDING)
            // order simply remains PENDING (nothing was collected to return).
            if (rt.order && rt.order.paymentStatus === "PAID") {
                await Order.updateOne(
                    { _id: rt.order._id, paymentStatus: "PAID" },
                    { $set: { paymentStatus: "REFUNDED", paid: false } }
                );
                rt.orderPaymentStatusChanged = true;
            }
        }

        if ((status === "REFUND_PROCESSED" || status === "REPLACEMENT_DELIVERED") && !rt.stockRestocked) {
            await restockReturnedItems(rt, "admin:" + String(req.user._id), "goods received back");
        }

        rt.status = status;
        pushTimeline(rt, status, "admin:" + String(req.user._id),
            status === "REFUND_PROCESSED" ? ("Refund of ₹" + rt.refund.amount + " via " + rt.refund.method + (rt.refund.reference ? " (" + rt.refund.reference + ")" : "")) : null);
        await rt.save();

        res.json({ success: true, data: rt });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// UPLOAD RETURN PROOF IMAGE (customer)
// Server re-validates the bytes and returns a secure Cloudinary URL (same
// codepath as product images; 503 until Cloudinary is configured).
// ===============================
exports.uploadReturnProof = async function (req, res) {
    try {
        const parsed = parseImageDataUri(req.body && req.body.image);
        const imageUrl = await uploadImageBytes(parsed.buffer, parsed.type);
        res.json({ success: true, imageUrl });
    } catch (error) {
        const status = (error && error.status) || 502;
        let message = "Image upload failed. Please try again.";
        if (status === 400 || status === 503) message = error.message;
        res.status(status).json({ success: false, message });
    }
};