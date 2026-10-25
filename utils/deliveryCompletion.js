// ===============================
// SHARED DELIVERY COMPLETION
// The single business-logic primitive that moves an order to "Delivered" and
// consumes the delivery assignment that carried it. Used by:
//   * the delivery-partner OTP path  (routes/deliveryRoutes.js PUT /status)
//   * the admin manual-completion path (controllers/orderController.js
//     updateOrderStatus) - the force-completion equivalent.
// Idempotent by design: once the order is Delivered every later completion is
// a harmless no-op, so a retried request can never double-push history, double
// credit earnings, or fire the completion email twice.
// ===============================

const Order = require("../models/Order");

// Append the Delivered history entry exactly once, whatever path completes the
// order (partner OTP or admin override).
function pushDeliveredEntry(order, by, reason) {
    if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
    const already = order.statusHistory.some(function (h) {
        return h && h.status === "Delivered";
    });
    if (already) return false;
    order.statusHistory.push({
        status: "Delivered",
        by: by || "delivery",
        at: new Date(),
        reason: reason || null,
    });
    return true;
}

// Advance an order to Delivered and consume the assignment that carried it.
// `opts.by` follows the app's audit convention (e.g. "delivery:<userId>" or
// "admin:<userId>"); `opts.reason` is the admin's manual-completion comment.
// Returns { order, assignment, alreadyDelivered }.
//
// Crash safety: the terminal status is claimed atomically first (mutual
// exclusion with cancellation), then every side effect is written idempotently
// and the completion is marked with `deliveryFinalizedAt`. If the process dies
// after the claim but before the effects, a retry re-enters this primitive on the
// already-Delivered order and finishes the outstanding work instead of returning
// a no-op: history is de-duplicated, COD payment is set only when missing, the
// assignment is consumed only if still active, and the post-delivery hooks are
// claimed exactly once with `deliveryHooksFiredAt`.
async function completeOrderDelivery(order, assignment, opts) {
    opts = opts || {};
    if (!order) {
        const err = new Error("Order not found");
        err.status = 404;
        throw err;
    }

    // SEC-07: Cancelled is TERMINAL.
    if (order.status === "Cancelled") {
        const err = new Error("This order was cancelled and cannot be marked delivered. Contact support to resolve the parcel.");
        err.status = 409;
        throw err;
    }

    const wasDelivered = order.status === "Delivered";

    // Atomic terminal-state claim: cancel and delivery completion are mutually
    // exclusive. Only the request that wins this compare-and-set may perform the
    // transition; a concurrent delivery (or a second completion) falls through to
    // the idempotent finalize below.
    if (!wasDelivered) {
        const claim = await Order.updateOne(
            { _id: order._id, status: { $nin: ["Cancelled", "Delivered"] } },
            { $set: { status: "Delivered" } }
        );
        if (!claim || claim.matchedCount !== 1) {
            const fresh = await Order.findById(order._id).lean();
            if (fresh && fresh.status === "Cancelled") {
                const err = new Error("This order was cancelled and cannot be marked delivered. Contact support to resolve the parcel.");
                err.status = 409;
                throw err;
            }
            if (!fresh || fresh.status !== "Delivered") {
                const err = new Error("Order status changed");
                err.status = 409;
                throw err;
            }
            // Lost the claim to a concurrent completion; finish its effects.
        }
        order.status = "Delivered";
    }

    // ---- idempotent finalize -------------------------------------------
    let changed = false;
    if (pushDeliveredEntry(order, opts.by, opts.reason)) changed = true;
    // Payment source of truth is preserved: only COD (cash handed over at the
    // door) advances to PAID here; online/manual stays PENDING until an admin
    // verifies the transfer through the payment-status endpoint.
    if (order.paymentMethod === "cod" && order.paymentStatus !== "PAID") {
        order.paid = true;
        order.paymentStatus = "PAID";
        order.paymentAt = order.paymentAt || new Date();
        changed = true;
    }
    if (!order.deliveryFinalizedAt) {
        order.deliveryFinalizedAt = new Date();
        changed = true;
    }
    if (changed) await order.save();

    // Consume the assignment that carried the order so no contradictory active
    // assignment survives a manual completion, and the OTP becomes single-use
    // under every completion path. Idempotent: a replay sees DELIVERED and skips.
    if (assignment && assignment.status !== "DELIVERED") {
        assignment.status = "DELIVERED";
        assignment.deliveredAt = assignment.deliveredAt || new Date();
        assignment.otpHash = null;
        assignment.otpExpiry = null;
        assignment.otpAttempts = null;
        assignment.otpVerified = true;
        await assignment.save();
    }

    // Fire the post-delivery side-effects exactly once, resumably. The marker is
    // claimed atomically before firing so a duplicate completion cannot double
    // credit the referral reward or double-emit the delivered events.
    if (!order.deliveryHooksFiredAt) {
        const hookClaim = await Order.updateOne(
            { _id: order._id, deliveryHooksFiredAt: null },
            { $set: { deliveryHooksFiredAt: new Date() } }
        );
        if (hookClaim && hookClaim.matchedCount === 1) {
            order.deliveryHooksFiredAt = new Date();
            try {
                const hooks = require("./orderDeliveredHooks");
                const fired = await hooks.fireOrderDelivered(order);
                void fired;
            } catch (e) { /* non-fatal */ }
        }
    }

    return { order: order, assignment: assignment || null, alreadyDelivered: wasDelivered };
}

module.exports = { completeOrderDelivery, pushDeliveredEntry };