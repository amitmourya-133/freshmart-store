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
async function completeOrderDelivery(order, assignment, opts) {
    opts = opts || {};
    if (!order) {
        const err = new Error("Order not found");
        err.status = 404;
        throw err;
    }

    // Idempotency marker: a Delivered order is never completed twice.
    if (order.status === "Delivered") {
        return { order: order, assignment: assignment || null, alreadyDelivered: true };
    }

    // SEC-07: Cancelled is TERMINAL. This primitive only guarded against
    // "Delivered", so a partner could still complete a cancelled order: the
    // status flipped back to Delivered, a COD order was flipped to PAID with a
    // paymentAt, the assignment was closed as DELIVERED and the partner earned
    // the fee - all after the customer had already cancelled and had their stock
    // restored. Refuse instead of silently resurrecting the order.
    if (order.status === "Cancelled") {
        const err = new Error("This order was cancelled and cannot be marked delivered. Contact support to resolve the parcel.");
        err.status = 409;
        throw err;
    }

    pushDeliveredEntry(order, opts.by, opts.reason);
    order.status = "Delivered";
    // Payment source of truth is preserved: only COD (cash handed over at the
    // door) advances to PAID here; online/manual stays PENDING until an admin
    // verifies the transfer through the payment-status endpoint.
    if (order.paymentMethod === "cod") {
        order.paid = true;
        order.paymentStatus = "PAID";
        order.paymentAt = order.paymentAt || new Date();
    }
    await order.save();

    // Consume the assignment that carried the order so no contradictory active
    // assignment survives a manual completion, and the OTP becomes single-use
    // under every completion path.
    if (assignment && assignment.status !== "DELIVERED") {
        assignment.status = "DELIVERED";
        assignment.deliveredAt = assignment.deliveredAt || new Date();
        assignment.otpHash = null;
        assignment.otpExpiry = null;
        assignment.otpAttempts = null;
        assignment.otpVerified = true;
        await assignment.save();
    }

    // Fire the post-delivery side-effects exactly once (analytics, referral
    // reward, repeat-order reminder). Lazy require breaks the module cycle and
    // keeps this primitive dependency-light; failures are already swallowed.
    try {
        const hooks = require("./orderDeliveredHooks");
        const fired = await hooks.fireOrderDelivered(order);
        void fired;
    } catch (e) { /* non-fatal */ }

    return { order: order, assignment: assignment || null, alreadyDelivered: false };
}

module.exports = { completeOrderDelivery, pushDeliveredEntry };