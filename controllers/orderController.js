// ===============================
// ORDER CONTROLLER
// ===============================

const crypto = require("crypto");
const mongoose = require("mongoose");
const { safeErrorMessage } = require("../utils/safeError");
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const Settings = require("../models/Settings");
const Coupon = require("../models/Coupon");
const InventoryLog = require("../models/InventoryLog");
const DeliveryAssignment = require("../models/DeliveryAssignment");
const DeliveryOffer = require("../models/DeliveryOffer");
const notificationController = require("./notificationController");
const { getMultFromWeight, round2 } = require("../utils/pricing");
const { findValidCoupon, computeCouponDiscount, normalizeCode, reserveCouponUsage, releaseCouponUsage } = require("../utils/coupons");
const { assertVariantAvailable } = require("../utils/variants");
const emailService = require("../utils/emailService");
const { assertDeliveryWithinRadius } = require("../utils/geo");
const { deliveryEta } = require("../utils/eta");
const { creditStoreCredit } = require("../utils/refunds");

// The single shared delivery-completion primitive (identical to the one the
// delivery-partner OTP path uses), so "Delivered" can reach the parent Order and
// its assignment only through one code path.
const { completeOrderDelivery } = require("../utils/deliveryCompletion");

// Best-effort audit log: stock reservations/restores never break the order
// flow when logging fails.
async function logStockChange(entry) {
    try {
        await InventoryLog.create(entry);
    } catch (e) {
        console.warn("[inventory] log failed: " + (e && e.message ? e.message : "unknown"));
    }
}

// Best-effort notification sending wrapper. Never throws; never affects the
// request's order state. Logs a sanitized failure line (no secrets).
async function notifyCustomer(emailFn, order, extra) {
    try {
        const result = await emailFn({ to: order.customerEmail, order: order, ...extra });
        if (result && result.sent) {
            return { sent: true };
        }
        if (result && result.reason) {
            console.warn("[email] " + (order.orderNumber || "?") + " " + (extra.tag || "") + " skipped: " + result.reason +
                (result.code ? "/" + result.code : "") + (result.hint ? " (" + result.hint + ")" : ""));
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

// In-app inbox notification for the order owner (guests are skipped).
// eventKey scopes dedupe so repeated events (e.g. the same status posted twice)
// never create a second inbox entry.
function inboxNotify(order, title, message, eventKey) {
    if (!order || !order.user) return;
    notificationController.notifyBase(order.user, {
        type: "order_status",
        title: title,
        message: message,
        dedupeKey: "order_inbox:" + String(order._id) + ":status:" + (eventKey || ""),
        data: {
            link: "orders.html",
            orderId: String(order._id),
            orderNumber: order.orderNumber || order.trackingId || ""
        }
    });
}

// Latest delivery partner for an order (used by owner/admin order view and the
// public tracking view). Returns { name, phone } or null when unassigned.
async function deliveryPartnerFor(orderId) {
    try {
        const assignment = await DeliveryAssignment.findOne({ order: orderId })
            .sort({ createdAt: -1 })
            .populate("deliveryUser", "name phone");
        if (!assignment || !assignment.deliveryUser) return null;
        return { name: assignment.deliveryUser.name, phone: assignment.deliveryUser.phone };
    } catch (e) {
        return null;
    }
}

// Latest delivery-assignment state for an order (used by owner/admin order views
// and the customer tracking view). includePartnerLocation is admin-only: it adds
// the partner's live coordinates so the map can drop a partner pin; customers
// never receive the partner's location (their private account data).
async function deliveryTrackFor(orderId, includePartnerLocation) {
    try {
        const assignment = await DeliveryAssignment.findOne({ order: orderId })
            .sort({ createdAt: -1 })
            .populate("deliveryUser", includePartnerLocation ? "name phone lastLat lastLng lastLocationAt" : "name");
        if (!assignment) return null;
        const track = {
            status: assignment.status,
            assignedAt: assignment.assignedAt || null,
            acceptedAt: assignment.acceptedAt || null,
            pickedUpAt: assignment.pickedUpAt || null,
            enRouteAt: assignment.enRouteAt || null,
            deliveredAt: assignment.deliveredAt || null,
            proofImage: assignment.proofImage || null
        };
        if (assignment.deliveryUser) {
            track.partner = { name: assignment.deliveryUser.name };
            if (includePartnerLocation) {
                const u = assignment.deliveryUser;
                const lastAt = u.lastLocationAt ? new Date(u.lastLocationAt).getTime() : null;
                const STALE_MS = 15 * 60 * 1000;
                track.partner.phone = u.phone || null;
                track.partner.lastLat = u.lastLat != null ? u.lastLat : null;
                track.partner.lastLng = u.lastLng != null ? u.lastLng : null;
                track.partner.lastLocationAt = u.lastLocationAt || null;
                track.partner.stale = lastAt ? (Date.now() - lastAt > STALE_MS) : true;
            }
        }
        return track;
    } catch (e) {
        return null;
    }
}

// Hard cap on distinct lines in a single order. Bounds the per-item product
// lookup in computeServerTotals so one request cannot force an unbounded
// number of sequential MongoDB reads.
const MAX_ORDER_LINES = 50;

const ORDER_STATUSES = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];
const STATUS_RANK = { Placed: 0, Confirmed: 1, Preparing: 2, "Out for Delivery": 3, Delivered: 4 };
const PAYMENT_STATUSES = ["PENDING", "PAID", "FAILED", "CANCELLED", "REFUNDED", "PENDING_REFUND"];
// Payment lifecycle (independent from delivery status):
//   PENDING        -> awaiting payment (COD at door / manual UPI unverified)
//   PAID           -> money collected (verified manual UPI, gateway, COD handover)
//   FAILED         -> admin rejected a manual payment; may be re-verified (PAID)
//                     or voided with the order (CANCELLED)
//   PENDING_REFUND -> money owed back to the customer, settlement not finished
//                     (cancelled-while-paid that could not auto-credit, or an
//                     admin-started refund). Reaches REFUNDED only.
//   REFUNDED       -> settled (store credit issued, or external settlement
//                     recorded). Terminal.
//   CANCELLED      -> never charged / charge voided. Terminal.
const PAYMENT_TRANSITIONS = {
    PENDING: ["PAID", "CANCELLED", "FAILED"],
    PAID: ["REFUNDED", "PENDING_REFUND"],
    FAILED: ["CANCELLED", "PAID"],
    CANCELLED: [],
    REFUNDED: [],
    PENDING_REFUND: ["REFUNDED"]
};

// ---------- helpers ----------

function generateOrderNumber() {
    const d = new Date();
    const ymd = d.getUTCFullYear().toString().slice(-2) +
        String(d.getUTCMonth() + 1).padStart(2, "0") +
        String(d.getUTCDate()).padStart(2, "0");
    return "FM-" + ymd + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
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

// Optional GPS capture at checkout. Returns a sanitized { latitude, longitude,
// accuracy, capturedAt } object or null when absent (manual address entry /
// older clients). Malformed or out-of-range values are rejected — coordinates
// claimed by the browser are never stored without sanity checks.
function normalizeDeliveryLocation(loc) {
    if (loc === undefined || loc === null) return null;
    if (typeof loc !== "object" || Array.isArray(loc)) {
        throw { status: 400, message: "Invalid delivery location" };
    }
    const lat = loc.latitude === undefined || loc.latitude === null || String(loc.latitude).trim() === "" ? NaN : Number(loc.latitude);
    const lng = loc.longitude === undefined || loc.longitude === null || String(loc.longitude).trim() === "" ? NaN : Number(loc.longitude);
    const accuracy = loc.accuracy === undefined || loc.accuracy === null || String(loc.accuracy).trim() === "" ? NaN : Number(loc.accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw { status: 400, message: "Invalid delivery location coordinates" };
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) {
        throw { status: 400, message: "Delivery location coordinates are out of range" };
    }
    // Explicit (0,0) is never a real delivery point — it is the classic
    // "empty or missing GPS became 0" fallback. Reject it outright so a bogus
    // Gulf-of-Guinea destination can never be recorded or forwarded.
    if (lat === 0 && lng === 0) {
        throw { status: 400, message: "Delivery location coordinates are missing (0,0)" };
    }
    if (Number.isFinite(accuracy) && (accuracy < 0 || accuracy > 5000)) {
        throw { status: 400, message: "Invalid delivery location accuracy" };
    }
    return {
        latitude: Math.round(lat * 1e6) / 1e6,
        longitude: Math.round(lng * 1e6) / 1e6,
        accuracy: Number.isFinite(accuracy) ? Math.round(accuracy) : null,
        capturedAt: new Date()
    };
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

// Server-authoritative totals.
//
// SECURITY (money integrity): EVERY line item must reference a real catalogue
// product by `productId`. The price, the product name and the stock are read
// ONLY from MongoDB. `item.price`, `item.name`, `item.subtotal` and
// `item.total` sent by the client are ignored entirely — there is deliberately
// no "custom/free item" branch, because that branch let an unauthenticated
// caller mint a real order for an arbitrary amount by simply omitting
// `productId` (see SEC-01 in the hardening report). A missing/invalid
// `productId` is a 400, never a free line.
//
// `active === false` is the single "not orderable" gate (the catalogue has no
// separate `orderable` flag), so an unpublished product can never be bought.
//
// Coupon discounts are always recomputed from the Coupon document (the client
// coupon value is never trusted). Throws { status, message } on failure.
async function computeServerTotals(items, options) {
    if (!Array.isArray(items) || items.length === 0) {
        throw { status: 400, message: "Cart is empty" };
    }
    if (items.length > MAX_ORDER_LINES) {
        throw { status: 400, message: "An order can contain at most " + MAX_ORDER_LINES + " different items" };
    }
    const normalized = [];
    let serverSubtotal = 0;
    for (const item of items) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw { status: 400, message: "Invalid item in cart" };
        }
        const qty = parseInt(item.quantity, 10);
        if (!Number.isInteger(qty) || qty < 1) {
            throw { status: 400, message: "Invalid quantity for " + (String(item.name || "item").slice(0, 60)) };
        }
        // --- productId is MANDATORY -----------------------------------------
        const rawId = item.productId === undefined || item.productId === null ? "" : String(item.productId).trim();
        if (!rawId) {
            throw { status: 400, message: "Cart contains an item that is not in the catalogue. Please rebuild your cart." };
        }
        if (!mongoose.Types.ObjectId.isValid(rawId)) {
            throw { status: 400, message: "Cart contains an invalid product reference" };
        }
        const product = await Product.findById(rawId);
        if (!product) {
            throw { status: 400, message: "A product in your cart no longer exists. Please rebuild your cart." };
        }
        if (!product.active) {
            throw { status: 400, message: product.name + " is no longer available" };
        }
        if (item.variantId) {
            // Pack-size variant: price/stock come from the variant, never
            // from the client. assertVariantAvailable also enforces stock.
            const variant = assertVariantAvailable(product, item.variantId, qty);
            serverSubtotal += round2(variant.price * qty);
            normalized.push({
                name: product.name,
                price: round2(variant.price),
                quantity: qty,
                weight: item.weight || null,
                productId: product._id,
                variantId: variant._id,
                variantUnit: variant.unit
            });
            continue;
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
            productId: product._id,
            variantId: null,
            variantUnit: null
        });
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
        const { coupon } = await findValidCoupon(rawCode, { userId: options && options.userId ? options.userId : null });
        discount = computeCouponDiscount(coupon, subtotal);
        couponInfo = { _id: coupon._id, code: coupon.code, discountType: coupon.discountType, discountValue: coupon.discountValue, minimumOrderValue: coupon.minimumOrderValue, perUserLimit: coupon.perUserLimit, segment: coupon.segment || null, maxDiscountAmount: coupon.maxDiscountAmount || null };
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

// Reserve stock atomically with a guarded findOneAndUpdate (single statement,
// so two concurrent checkouts can never both succeed against the last unit).
// Returns the product doc with the variant included when it was a pack sale,
// or null when the line is not servable at the requested quantity.
// Reserve stock atomically with a guarded update (single statement, so two
// concurrent checkouts can never both succeed against the last unit). The
// variant branch uses $elemMatch as the DOCUMENT-LEVEL guard (MongoDB
// re-validates the query on write-conflict retries) plus arrayFilters pinned
// to the exact pack _id so the increment lands on the right element and never
// on a sibling pack. Returns the product doc with the decremented variant (for
// audit), or null when the line is not servable at the requested quantity.
async function tryReserveLine(item) {
    if (!item.productId) return null;
    const qty = item.quantity;
    if (item.variantId) {
        const res = await Product.updateOne(
            {
                _id: item.productId,
                active: true,
                variants: { $elemMatch: { _id: item.variantId, active: true, stock: { $gte: qty } } }
            },
            { $inc: { "variants.$[elem].stock": -qty } },
            { arrayFilters: [{ "elem._id": item.variantId, "elem.stock": { $gte: qty } }] }
        );
        if (res && res.modifiedCount === 1) {
            return Product.findById(item.productId);
        }
        return null;
    }
    // Legacy weight/unit product (root stock).
    const res = await Product.updateOne(
        { _id: item.productId, active: true, stock: { $gte: qty } },
        { $inc: { stock: -qty } }
    );
    if (res && res.modifiedCount === 1) {
        return Product.findById(item.productId);
    }
    return null;
}

// Compensate a reserved line (rollback used at order-create failure and an
// admin/customer cancellation path that returns stock to the shelf).
async function restoreLine(item) {
    if (!item.productId) return;
    const qty = item.quantity;
    if (item.variantId) {
        const res = await Product.updateOne(
            { _id: item.productId },
            { $inc: { "variants.$[elem].stock": qty } },
            { arrayFilters: [{ "elem._id": item.variantId }] }
        );
        if (res && res.matchedCount === 1) {
            const product = await Product.findById(item.productId).lean();
            const variant = product && product.variants ? product.variants.find(function (v) { return String(v._id) === String(item.variantId); }) : null;
            await logStockChange({
                product: item.productId, variantId: item.variantId, scope: "variant", change: qty,
                previousStock: variant ? Math.max(0, variant.stock - qty) : 0, newStock: variant ? variant.stock : 0,
                reason: "order_cancelled", order: item.orderId || null,
                changedByType: item.changedByType || "system", changedBy: item.changedBy || null,
                note: (item.variantUnit || item.name || "item")
            });
        }
        return;
    }
    const product = await Product.findOneAndUpdate(
        { _id: item.productId },
        { $inc: { stock: qty } },
        { new: true }
    );
    if (product) {
        await logStockChange({
            product: item.productId, variantId: null, scope: "stock", change: qty,
            previousStock: Math.max(0, product.stock - qty), newStock: product.stock,
            reason: "order_cancelled", order: item.orderId || null,
            changedByType: item.changedByType || "system", changedBy: item.changedBy || null,
            note: (item.name || "item")
        });
    }
}

// Restore stock for cancelled orders (once).
async function restoreStockOnce(order, changedByType, changedBy) {
    if (!order.items) return;
    for (const sub of order.items) {
        // Mongoose subdocuments do not expose their paths to Object.assign
        // (fields live in _doc), so materialize a plain object first.
        const item = sub && typeof sub.toObject === "function" ? sub.toObject() : sub;
        if (item && item.productId) {
            await restoreLine(Object.assign({}, item, { orderId: order._id, changedByType: changedByType, changedBy: changedBy }));
        }
    }
}

// Shared cancellation logic (admin + customer). Idempotent per order.
async function applyCancellation(order, by) {
    if (order.status === "Cancelled") return { ok: false, message: "Order is already cancelled" };
    if (order.status === "Delivered") return { ok: false, message: "Delivered orders cannot be cancelled" };

    const byType = by && String(by).indexOf("admin:") === 0 ? "admin" : "customer";
    const byId = by ? String(by).split(":")[1] : null;
    await restoreStockOnce(order, byType, byId && require("mongoose").Types.ObjectId.isValid(byId) ? byId : null);

    // Give the coupon use back exactly once; the flag makes cancellation
    // idempotent even if it is attempted again later.
    //
    // BIZ-03: the GLOBAL Coupon.usageCount is claimed at checkout for guest
    // and member orders alike (CAS at order creation), so the global release
    // must run for guests too - otherwise every guest cancellation permanently
    // burns one use of the code for ALL customers. The per-user CouponUsage
    // row only exists for signed-in customers, so that release stays gated.
    //
    // Ordering: the couponReleased flag is CLAIMED first with a conditional
    // update. Only the request that wins the claim performs the decrements, so
    // concurrent/duplicate cancellations can never double-release, and the
    // flag is never set for a release that did not happen (the old code set it
    // unconditionally, even after a failed release, silently losing it).
    if (order.couponCode && !order.couponReleased) {
        const claimed = await Order.updateOne(
            { _id: order._id, couponCode: order.couponCode, couponReleased: { $ne: true } },
            { $set: { couponReleased: true } }
        );
        if (claimed && claimed.matchedCount === 1) {
            order.couponReleased = true;
            try {
                const couponDoc = await Coupon.findOne({ code: order.couponCode });
                if (couponDoc) {
                    await Coupon.updateOne(
                        { _id: couponDoc._id, usageCount: { $gt: 0 } },
                        { $inc: { usageCount: -1 } }
                    );
                    if (order.user) {
                        await releaseCouponUsage(couponDoc._id, order.user);
                    }
                }
            } catch (e) {
                // The claim already happened, so this cannot double-release on
                // a retry. Loud log: the freed use needs manual attention.
                console.warn("[coupon] release failed after claim: " + (e && e.message ? e.message : "unknown"));
                require("../utils/logger").error({
                    ev: "coupon_release_failed_after_claim",
                    code: order.couponCode,
                    orderId: String(order._id),
                    err: (e && e.message) || "unknown",
                });
            }
        }
    }

    // ----- payment settlement (BIZ-01 / BIZ-02) --------------------------
    // The order is being cancelled, so its payment lifecycle has to land in a
    // legal, truthful terminal (or refund-pending) state:
    //
    //   * never collected (PENDING/FAILED) -> CANCELLED ("not charged")
    //   * already settled (REFUNDED/CANCELLED/PENDING_REFUND) -> untouched
    //   * money collected (PAID):
    //       - member order: issue store credit NOW (idempotent wallet credit,
    //         keyed on the order id) -> REFUNDED. If the credit cannot be
    //         delivered, the status stays PAID/PENDING_REFUND so the refund
    //         remains owed and retryable - never recorded as done.
    //       - guest order: no wallet exists to receive store credit, so the
    //         refund is queued as PENDING_REFUND for manual/admin settlement.
    if (order.paymentStatus === "PAID") {
        const refundAmount = round2(
            Number(order.refund && order.refund.amount) > 0 ? order.refund.amount : order.total
        );
        let credited = false;
        if (order.user) {
            try {
                const c = await creditStoreCredit({
                    userId: order.user,
                    amount: refundAmount,
                    referenceType: "order",
                    referenceId: String(order._id),
                    description: "Store credit refund - cancelled order " + (order.orderNumber || ""),
                    createdBy: by || "system",
                });
                credited = c.ok;
            } catch (e) {
                // Delivery failed: keep the refund owed (PAID below) so a retry
                // can complete it. Never fake a settled refund.
                require("../utils/logger").error({
                    ev: "cancel_store_credit_failed",
                    orderId: String(order._id),
                    err: (e && e.message) || "unknown",
                });
            }
        }
        if (credited) {
            order.paymentStatus = "REFUNDED";
            order.refund.status = "store_credit";
            order.refund.amount = refundAmount;
            order.refund.reference = (order.refund && order.refund.reference) || "STORE-CREDIT";
            order.refund.initiatedAt = order.refund.initiatedAt || new Date();
        } else {
            // Guest (no wallet to credit) or credit delivery failed:
            // queue the refund instead of voiding it.
            order.paymentStatus = "PENDING_REFUND";
            order.refund.amount = refundAmount;
            order.refund.status = order.refund.status || "pending";
            order.refund.initiatedAt = order.refund.initiatedAt || new Date();
        }
    } else if (order.paymentStatus === "PENDING" || order.paymentStatus === "FAILED") {
        order.paymentStatus = "CANCELLED";
    }
    // REFUNDED / CANCELLED / PENDING_REFUND: already settled or already owed -
    // never overwrite a refund state with CANCELLED (BIZ-02).

    order.status = "Cancelled";
    pushHistory(order, "Cancelled", by);
    await order.save();

    // SEC-06: a colony reward that was already credited has to come back when
    // the order behind it is cancelled, otherwise the customer keeps money for
    // an order that no longer exists. Best-effort: the reversal is idempotent,
    // and any failure is logged rather than blocking the cancellation (the
    // customer asked to cancel; that must always succeed).
    try {
        await require("../utils/groupRewards").reverseRewardsForOrder(order._id);
    } catch (e) {
        require("../utils/logger").error({
            ev: "group_reward_reversal_on_cancel_failed",
            orderId: String(order._id),
            err: (e && e.message) || "unknown"
        });
    }

    return { ok: true, order: order };
}

// ===============================
// CREATE ORDER
// ===============================
exports.createOrder = async (req, res) => {
    try {
        const { customer, items, payment, paymentMethod, paid, deliverySlot, subscription, subscriptionPlan, clientRef, paymentReference, couponCode, deliveryLocation, groupId } = req.body;

        // Server-side address validation
        const customerError = validateCustomer(customer);
        if (customerError) {
            return res.status(400).json({ success: false, message: customerError });
        }

        // Group / colony order context (Phase 2.6): if present the order links
        // to an OPEN group so the shared reward can apply after its threshold is
        // reached. Requires a logged-in customer (rewards go to an account).
        let groupDoc = null;
        if (groupId && String(groupId).trim()) {
            if (!req.user) {
                return res.status(400).json({ success: false, message: "A login is required to place a group order" });
            }
            const GroupOrder = require("../models/GroupOrder");
            groupDoc = await GroupOrder.findById(String(groupId).trim());
            if (!groupDoc) return res.status(404).json({ success: false, message: "Group not found" });
            if (groupDoc.status !== "OPEN") return res.status(400).json({ success: false, message: "This group is no longer accepting orders" });
            if (new Date(groupDoc.expiresAt).getTime() < Date.now()) return res.status(400).json({ success: false, message: "This group has expired" });
            if ((groupDoc.orders || []).length >= groupDoc.maxParticipants) return res.status(400).json({ success: false, message: "This group has reached its order capacity" });
        }

        // Idempotency: retrying the same clientRef returns the existing order
        // instead of creating a duplicate (double click / browser retry / webhook
        // retry). The lookup is scoped to the caller so a guessed or re-used
        // reference can never expose another customer's order, and only a minimal
        // stub is returned if it is the caller's own order.
        if (clientRef && String(clientRef).trim()) {
            const ref = String(clientRef).trim();
            let existing = await Order.findOne(
                req.user
                    ? { clientRef: ref, user: req.user._id }
                    : { clientRef: ref, user: null }
            );
            if (existing) {
                let allowed = true;
                if (!req.user) {
                    const cName = String((customer && customer.name) || "").trim().toLowerCase();
                    const cPhone = String((customer && customer.phone) || "").trim();
                    const cEmail = String((customer && customer.email && String(customer.email).trim()) || "").toLowerCase();
                    const eName = existing.customer && existing.customer.name ? String(existing.customer.name).toLowerCase() : "";
                    const ePhone = existing.customer && existing.customer.phone ? String(existing.customer.phone) : "";
                    const eEmail = existing.customerEmail ? String(existing.customerEmail).toLowerCase() : "";
                    allowed = Boolean(eName && ePhone && cName === eName && cPhone === ePhone) || Boolean(eEmail && cEmail && cEmail === eEmail);
                }
                if (allowed) {
                    return res.status(200).json({
                        success: true,
                        already: true,
                        data: {
                            _id: existing._id,
                            orderNumber: existing.orderNumber,
                            trackingId: existing.trackingId,
                            status: existing.status,
                            paymentStatus: existing.paymentStatus,
                            subtotal: existing.subtotal,
                            delivery: existing.delivery,
                            discount: existing.discount,
                            total: existing.total
                        }
                    });
                }
                existing = null;
            }
        }

        // Optional GPS capture. Throws { status: 400 } on malformed values.
        const deliveryLocationData = normalizeDeliveryLocation(deliveryLocation);

        // Authoritative delivery-radius enforcement (server-side only). Disabled
        // when the admin has not set a radius, so address-only customers never break.
        await assertDeliveryWithinRadius(deliveryLocationData);

const totals = await computeServerTotals(items, { couponCode: couponCode, userId: req.user ? req.user._id : null });

        let orderNumber = generateOrderNumber();
        let trackingId = generateTrackingId();
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
            deliveryLocation: deliveryLocationData,
            subscription: subscription === true,
            subscriptionPlan: subscriptionPlan || null,
            total: totals.total,
            status: "Placed",
            user: req.user ? req.user._id : null,
            customerEmail: customerEmail
        };

        if (groupDoc) {
            orderData.group = groupDoc._id;
        }

        if (finalPaymentMethod === "cod") {
            // COD starts UNPAID/PENDING. The payment is collected at the door,
            // so the delivery partner flips it to PAID when the order reaches
            // DELIVERED (see deliveryRoutes /status). Never paid at creation.
            orderData.paid = false;
            orderData.paymentStatus = "PENDING";
            orderData.paymentMode = "cod";
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

        // Notify admins about the new order (push notification, fire-and-forget).
        try {
            const pushController = require("../controllers/pushController");
            pushController.sendPushToAdmins(
                "New Order " + orderNumber,
                "Order " + orderNumber + " placed. Total: ₹" + totals.total,
                "/admin.html"
            ).catch(function () { /* non-fatal */ });
        } catch (e) { /* non-fatal */ }

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
            // Per-customer cap (only for logged-in customers). Throws 400 when
            // their allowance is spent, in which case the global increment is
            // rolled back so no usage is burned by a rejected checkout.
            if (req.user) {
                try {
                    await reserveCouponUsage(reservedCoupon, req.user._id);
                } catch (perUserErr) {
                    try { await Coupon.updateOne({ _id: reservedCoupon._id }, { $inc: { usageCount: -1 } }); } catch (e) { /* non-fatal */ }
                    if (perUserErr && perUserErr.status) {
                        return res.status(perUserErr.status).json({ success: false, message: perUserErr.message });
                    }
                    throw perUserErr;
                }
            }
        }

        // Reserve item stock with an atomic guard so two parallel checkouts can
        // never both oversell the last unit. On any failure ALL reservations so
        // far (stock + coupon) are compensated before responding.
        const reservedLines = [];
        const restored = [];
        for (const item of totals.items) {
            const product = await tryReserveLine(item);
            if (!product) {
                // Nothing reserved for this line: what is the actual shortfall?
                for (const prev of reservedLines) {
                    if (restored.indexOf(prev) === -1) {
                        await restoreLine(prev);
                        restored.push(prev);
                    }
                }
                if (item.variantId) {
                    const prod = await Product.findById(item.productId).lean();
                    const variant = prod && prod.variants ? prod.variants.find(function (v) { return String(v._id) === String(item.variantId); }) : null;
                    if (!prod || !variant || !variant.active) {
                        return res.status(400).json({ success: false, message: (prod ? prod.name : item.name || "Item") + (variant ? " (" + variant.unit + ") is no longer available" : " pack is no longer available") });
                    }
                    return res.status(400).json({ success: false, message: "Only " + variant.stock + " of " + prod.name + " (" + variant.unit + ") left in stock" });
                }
                const prod = await Product.findById(item.productId).lean();
                return res.status(400).json({ success: false, message: "Only " + (prod ? prod.stock : 0) + " units of " + (prod ? prod.name : item.name || "Item") + " left in stock" });
            }
            reservedLines.push(Object.assign({}, item, { orderId: null }));
        }

let order;
        const MAX_RETRIES = 5;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                order = await Order.create(Object.assign(orderData, { statusHistory: [{ status: "Placed", by: req.user ? "customer:" + String(req.user._id) : "guest", at: new Date() }] }));
                break; // success — exit the retry loop
            } catch (createError) {
                // Compensate coupon usage + reserved stock so retries/aborts do not
                // burn the coupon or the inventory (same compensation as before).
                if (reservedCoupon) {
                    try { await Coupon.updateOne({ _id: reservedCoupon._id }, { $inc: { usageCount: -1 } }); } catch (e) { /* non-fatal */ }
                    if (req.user) { try { await releaseCouponUsage(reservedCoupon._id, req.user._id); } catch (e) { /* non-fatal */ } }
                }
                for (const prev of reservedLines) {
                    if (restored.indexOf(prev) === -1) { await restoreLine(prev); restored.push(prev); }
                }

                // If this is a genuine duplicate-order-number collision (E11000) and we
                // haven't exhausted retries, generate a fresh order number and try again.
                // Non-11000 errors (validation, database unavailable, etc.) must NOT be
                // retried blindly — they indicate a real problem that a retry wouldn't fix.
                if (createError && createError.code === 11000 && attempt < MAX_RETRIES) {
                    // Regenerate order number and tracking id for the retry
                    orderNumber = generateOrderNumber();
                    trackingId = generateTrackingId();
                    // Update orderData with the new number before the next Iteration
                    orderData.orderNumber = orderNumber;
                    orderData.trackingId = trackingId;
                    // Also push a fresh entry into statusHistory so the retry is
                    // distinguishable from the original attempt.
                    orderData.statusHistory = [{ status: "Placed", by: req.user ? "customer:" + String(req.user._id) : "guest", at: new Date() }];
                    continue; // retry the loop
                }
                // Either a non-11000 error, or we've exhausted retries — re-throw.
                throw createError;
            }
        }

        // Audit trail tied to the real order id (read-only Product lookups; the
        // quantities were already reserved atomically above).
        for (const item of totals.items) {
            const product = await Product.findById(item.productId).lean();
            if (!product) continue;
            if (item.variantId) {
                const variant = product.variants ? product.variants.find(function (v) { return String(v._id) === String(item.variantId); }) : null;
                if (variant) {
                    await logStockChange({
                        product: product._id, variantId: variant._id, scope: "variant", change: -item.quantity,
                        previousStock: variant.stock + item.quantity, newStock: variant.stock,
                        reason: "order_placed", order: order._id, changedByType: "system", note: product.name + " (" + variant.unit + ")"
                    });
                }
            } else {
                await logStockChange({
                    product: product._id, variantId: null, scope: "stock", change: -item.quantity,
                    previousStock: product.stock + item.quantity, newStock: product.stock,
                    reason: "order_placed", order: order._id, changedByType: "system", note: product.name
                });
            }
        }

        // Low-stock alert to admins (awaited so the admin inbox is consistent
        // by the time the response is received; a failure must never block the
        // order, so it stays fully guarded by try/catch).
        try {
            const productIds = totals.items.filter(function (i) { return i.productId; }).map(function (i) { return i.productId; });
            if (productIds.length) {
                const products = await Product.find({ _id: { $in: productIds } }).select("_id name stock variants");
                const low = products.filter(function (p) {
                    if (p.variants && p.variants.length) {
                        return p.variants.some(function (v) { return v.active && v.stock <= 5; });
                    }
                    return p.stock <= 5;
                });
                if (low.length) {
                    const labels = low.map(function (p) {
                        if (p.variants && p.variants.length) {
                            const worst = p.variants.filter(function (v) { return v.active; }).sort(function (a, b) { return a.stock - b.stock; })[0];
                            return p.name + " (" + worst.unit + ": " + worst.stock + " left)";
                        }
                        return p.name + " (" + p.stock + " left)";
                    });
                    await notificationController.notifyRole("admin", {
                        type: "low_stock",
                        title: "Low stock alert",
                        message: labels.join(", ") + " — restock soon.",
                        data: { link: "admin.html", count: low.length },
                    });
                }
            }
        } catch (e) { console.warn("[notification] low-stock failed: " + ((e && e.message) || "unknown")); }

        // Growth analytics + reminder-conversion tracking (fire-and-forget).
        try {
            const analyticsSvc = require("../utils/analytics");
            analyticsSvc.track({
                eventName: "order_created",
                user: req.user,
                orderId: String(order._id),
                metadata: {
                    orderNumber: orderNumber,
                    total: order.total,
                    itemCount: Array.isArray(order.items) ? order.items.length : 0,
                    paymentMethod: order.paymentMethod || "cod",
                },
            });
            const reminderSvc = require("../utils/reminders");
            reminderSvc.maybeMarkReminderConverted(order);
            // Coupon redemption attribution (Phase 2): one event per real,
            // persisted order so promotion performance can be measured without
            // trusting any client-side value.
            if (totals.coupon) {
                analyticsSvc.track({
                    eventName: "coupon_redeemed",
                    user: req.user,
                    orderId: String(order._id),
                    productId: null,
                    metadata: {
                        code: totals.coupon.code,
                        segment: totals.coupon.segment || null,
                        discount: totals.discount,
                        orderTotal: order.total,
                    },
                });
            }
        } catch (e) { console.warn("[analytics] order_created failed: " + ((e && e.message) || "unknown")); }

        // Group/colony reward check (Phase 2.6): after the order is persisted,
        // register it in the group and apply the shared reward when that
        // registration crosses the participants threshold. Fire-and-forget.
        if (groupDoc) {
            try {
                const groupRewards = require("../utils/groupRewards");
                Promise.resolve()
                    .then(function () { return groupRewards.recordOrderInGroup(groupDoc._id, order._id); })
                    .then(function (group) {
                        if (group) {
                            notificationController.notifyBase(group.host, {
                                type: "group_order",
                                title: "Sale on!  Order threshold reached",
                                message: "Order #" + order.orderNumber + " took your group over " + group.minParticipants + " orders. Rewards are being issued.",
                                dedupeKey: "group_threshold:" + String(group._id),
                                data: { link: "groups.html" },
                            });
                            return groupRewards.applyRewards(group._id);
                        }
                        return null;
                    })
                    .catch(function (e) { console.warn("[groups] reward failed: " + ((e && e.message) || "unknown")); });
            } catch (e) { /* non-fatal */ }
        }

        res.status(201).json({
            success: true,
            data: order
        });

        // Alert every online delivery partner that a real order is waiting to
        // be claimed (Phase 2). Fire-and-forget: the customer already has their
        // response, and a delivery-broadcast problem must never fail checkout.
        // Running the sweep here also retires offers that expired while nobody
        // had a dashboard open.
        try {
            const deliveryOps = require("../controllers/deliveryOpsController");
            Promise.resolve()
                .then(function () { return deliveryOps.sweepExpiredOffers(20); })
                .then(function () { return deliveryOps.broadcastNewOrder(order); })
                .catch(function (e) {
                    console.warn("[delivery-ops] broadcast failed: " + ((e && e.message) || "unknown"));
                });
        } catch (e) { /* non-fatal */ }

        // In-app inbox notification for the buyer (fire-and-forget; never affects
        // the response).
        if (req.user) {
            notificationController.notifyBase(req.user._id, {
                type: "order_status",
                title: "Order placed",
                message: "Your order " + orderNumber + " is placed and being packed.",
                dedupeKey: "order_inbox:" + String(order._id) + ":status:Placed",
                data: { link: "orders.html", orderId: String(order._id), orderNumber: orderNumber },
            });
        }

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
            return res.status(error.status).json({ success: false, message: safeErrorMessage(error) });
        }
        if (error && error.name === "CastError") {
            return res.status(400).json({ success: false, message: "Invalid product in cart" });
        }
        if (error && error.code === 11000) {
            return res.status(409).json({ success: false, message: "This order reference is already in use. Please try again." });
        }
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
    }
};

// ===============================
// QUOTE ORDER (server-validated totals, nothing persisted)
// ===============================
exports.quoteOrder = async (req, res) => {
    try {
        // Optional coverage pre-check: only when the caller supplies a delivery
        // location. The authoritative gate remains createOrder; this simply lets
        // the checkout surface the radius error before the final submit.
        if (req.body.deliveryLocation) {
            const checked = normalizeDeliveryLocation(req.body.deliveryLocation);
            await assertDeliveryWithinRadius(checked);
        }
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
            return res.status(error.status).json({ success: false, message: safeErrorMessage(error) });
        }
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// ===============================
// GET MY ORDERS (customer, backend-enforced ownership)
// ===============================
exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
        const docs = [];
        for (const order of orders) {
            const doc = order.toObject ? order.toObject() : Object.assign({}, order);
            const track = await deliveryTrackFor(order._id);
            if (track) doc.deliveryTrack = track;
            // The owner of an order may see (and call) the rider who is bringing
            // it. This is never exposed on the public tracking endpoint.
            const partner = await deliveryPartnerFor(order._id);
            if (partner) doc.deliveryPartner = partner;
            doc.eta = await deliveryEta(order, track);
            docs.push(doc);
        }
        res.json({ success: true, count: docs.length, data: docs });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        // order.user may be a populated document or a raw ObjectId.
        const ownerId = order.user && (order.user._id ? order.user._id : order.user);
        const isOwner = req.user && ownerId && String(ownerId) === String(req.user._id);
        if (!isAdmin && !isOwner) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        // Owner/admin view: include the assigned delivery partner (name + phone)
        // and the latest delivery state. Admin additionally receives the
        // partner's live location so the admin map can pin where they are now.
        const partner = await deliveryPartnerFor(order._id);
        const track = await deliveryTrackFor(order._id, isAdmin);
        const doc = order.toObject ? order.toObject() : Object.assign({}, order);
        if (partner) doc.deliveryPartner = partner;
        if (track) doc.deliveryTrack = track;
        doc.eta = await deliveryEta(order, track);
        res.json({ success: true, data: doc });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
            inboxNotify(result.order, "Order cancelled", "Order " + (result.order.orderNumber || "") + " was cancelled.", "Cancelled");
            try {
                require("../utils/analytics").track({ eventName: "order_cancelled", userId: order.user, orderId: String(order._id), metadata: { orderNumber: order.orderNumber } });
            } catch (e) { /* non-fatal */ }
            return res.json({ success: true, data: result.order });
        }

        if (order.status === "Cancelled" || order.status === "Delivered") {
            return res.status(400).json({ success: false, message: "Final status " + order.status + " cannot be changed" });
        }
        if (STATUS_RANK[status] < STATUS_RANK[order.status]) {
            return res.status(400).json({ success: false, message: "Cannot move status backwards" });
        }

        // AUD-06: a manual "Delivered" is an override of the (OTP verified)
        // partner-completion path, so it is held to the same bar:
        //   1. it is only valid from "Out for Delivery" (no free jumps from
        //      Placed/Confirmed/Preparing),
        //   2. it always requires an audit reason (non-blank, <= 300 chars),
        //   3. it runs through the same completion primitive as the partner
        //      path and consumes the active delivery assignment.
        if (status === "Delivered") {
            if (order.status !== "Out for Delivery") {
                return res.status(400).json({
                    success: false,
                    message: "Order can only be marked Delivered from Out for Delivery. Advance it first.",
                });
            }
            const reason = String(req.body.reason || "").trim();
            if (!reason) {
                return res.status(400).json({
                    success: false,
                    message: "A reason is required to manually mark an order as Delivered.",
                });
            }
            if (reason.length > 300) {
                return res.status(400).json({
                    success: false,
                    message: "Reason must be 300 characters or fewer.",
                });
            }

            const previousStatus = order.status;
            // Consume the active assignment, if one is still in flight, so a
            // manual completion never leaves a contradictory active path open.
            const activeAssignment = await DeliveryAssignment.findOne({
                order: order._id,
                status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
            }).select("deliveryUser");
            const done = await completeOrderDelivery(order, activeAssignment, {
                by: "admin:" + String(req.user._id),
                reason: reason,
            });
            // Retire any still-open claim offer for this order: the run is over.
            await DeliveryOffer.updateMany(
                { order: order._id, status: "OPEN" },
                { $set: { status: "ASSIGNED" } }
            );
            emailOnStatusChange(done.order, previousStatus);
            inboxNotify(done.order, "Order Delivered", "Order " + (done.order.orderNumber || "") + " was delivered.",
                "Delivered");
            return res.json({ success: true, data: done.order });
        }

        const previousStatus = order.status;
        order.status = status;
        pushHistory(order, status, "admin:" + String(req.user._id));
        await order.save();

        emailOnStatusChange(order, previousStatus);
        inboxNotify(order, "Order " + status, "Order " + order.orderNumber + " is now " + status + ".", status);

        // WhatsApp order update (Phase 2.5): hard opt-in + provider-gated,
        // fire-and-forget so a WhatsApp outage can never fail a status change.
        if (status === "Confirmed" || status === "Out for Delivery") {
            try {
                const whatsapp = require("../utils/whatsapp");
                const UserModel = require("../models/User");
                const event = status === "Confirmed" ? "order_confirmed" : "order_out_for_delivery";
                UserModel.findById(order.user)
                    .then(function (user) { return whatsapp.notifyOrderUpdate(order, event, user); })
                    .catch(function () { /* non-fatal */ });
            } catch (e) { /* non-fatal */ }
        }

        // Growth analytics for the confirmation milestone (fire-and-forget).
        if (status === "Confirmed") {
            try {
                require("../utils/analytics").track({ eventName: "order_confirmed", userId: order.user, orderId: String(order._id), metadata: { orderNumber: order.orderNumber } });
            } catch (e) { /* non-fatal */ }
        }

        res.json({ success: true, data: order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        inboxNotify(result.order, "Order cancelled", "Order " + (result.order.orderNumber || "") + " was cancelled.", "Cancelled");
        res.json({ success: true, data: result.order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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

        // BIZ-01: a REFUNDED transition must actually move the money. For
        // store-credit refunds the wallet credit is issued FIRST (idempotent,
        // keyed on the order id) - if it cannot be delivered, the status stays
        // untouched and the admin can retry; the refund is never recorded as
        // done while the customer holds nothing.
        if (paymentStatus === "REFUNDED") {
            const refundAmount = round2(
                Number(order.refund && order.refund.amount) > 0 ? order.refund.amount : order.total
            );
            if (order.user) {
                let credited;
                try {
                    credited = await creditStoreCredit({
                        userId: order.user,
                        amount: refundAmount,
                        referenceType: "order",
                        referenceId: String(order._id),
                        description: "Store credit refund - order " + (order.orderNumber || ""),
                        createdBy: "admin:" + String(req.user._id),
                    });
                } catch (e) {
                    return res.status(500).json({
                        success: false,
                        message: "Refund could not be issued to the customer's wallet. Please retry."
                    });
                }
                if (!credited.ok) {
                    return res.status(400).json({
                        success: false,
                        message: credited.reason === "no_account"
                            ? "This order has no customer account to receive store credit"
                            : "Refund amount must be greater than 0"
                    });
                }
                order.refund.amount = refundAmount;
            } else {
                // Guest checkout: no wallet exists. Record the settlement only
                // and say so in the log (admin settles guests out-of-band).
                require("../utils/logger").warn({
                    ev: "order_refund_recorded_without_wallet",
                    orderId: String(order._id),
                    reason: "guest_order",
                });
            }
            order.refund.status = "store_credit";
            order.refund.reference = (reference && String(reference).trim()) || order.refund.reference || "STORE-CREDIT";
            order.refund.initiatedAt = order.refund.initiatedAt || new Date();
        }

        order.paymentStatus = paymentStatus;
        if (paymentStatus === "PAID") {
            order.paid = true;
            order.paymentAt = new Date();
            if (reference && String(reference).trim()) order.paymentReference = String(reference).trim();
        }
        await order.save();

        res.json({ success: true, data: order });
    } catch (error) {
        if (error && error.name === "CastError") {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        // Tracking IDs (FM-YYYYMMDD-XXXXXX) are high-entropy per-order tokens and
        // may be looked up anonymously, like a package-tracking link. Order numbers
        // are sequential / low-entropy, so a lookup by order number is restricted to
        // the owner (or an admin) to stop anonymous enumeration of order info.
        let order = null;
        if (/^FM-\d{8}-[0-9A-F]{6}$/i.test(n)) {
            order = await Order.findOne({ trackingId: n });
        } else if (req.user) {
            order = req.user.role === "admin"
                ? await Order.findOne({ orderNumber: n })
                : await Order.findOne({ orderNumber: n, user: req.user._id });
        } else {
            return res.status(401).json({
                success: false,
                message: "Please log in to track an order by Order Number, or use your Track ID."
            });
        }
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        // Tracking-view safe fields: NEVER leak phone, address, payment ids or refund id.
        // The delivery partner's name (never their phone/address) is shown so the
        // customer can recognise whom to expect, when assigned.
        const partner = await deliveryPartnerFor(order._id);
        const track = await deliveryTrackFor(order._id);
        const eta = await deliveryEta(order, track);
        res.json({
            success: true,
            data: {
                orderNumber: order.orderNumber,
                trackingId: order.trackingId,
                status: order.status,
                // Delivery pipeline state (safe status label; no PII).
                deliveryStatus: track ? track.status : null,
                paymentStatus: order.paymentStatus,
                date: order.createdAt,
                // Real ETA when the pipeline/rider data exists, else the slot label.
                eta: eta,
                items: (order.items || []).map(function (i) {
                    return { name: i.name || i.productName, quantity: i.quantity || 1, price: i.price || 0, variantUnit: i.variantUnit || null };
                }),
                total: order.total,
                deliveryPartner: partner ? { name: partner.name } : null,
                timeline: (order.statusHistory || []).map(function (h) {
                    return { status: h.status, at: h.at };
                })
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};