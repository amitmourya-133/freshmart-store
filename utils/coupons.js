// ===============================
// COUPON LOGIC (shared by quote/order + validate endpoints)
// All discount decisions are computed here from the Coupon document only.
// Client-sent discount amounts/values are never trusted.
// ===============================

const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Normalize a coupon code for lookup/creation (always uppercase).
function normalizeCode(code) {
    return String(code || "").trim().toUpperCase();
}

// Locate a coupon that is currently usable. Returns { coupon } or
// throws { status: 400, message } with a customer-safe reason.
// `options.userId` (optional) also enforces the coupon's per-user cap.
async function findValidCoupon(rawCode, options) {
    const userId = options && options.userId ? options.userId : null;
    const code = normalizeCode(rawCode);
    if (!code) {
        throw { status: 400, message: "Please enter a coupon code" };
    }
    const coupon = await Coupon.findOne({ code: code });
    if (!coupon) {
        throw { status: 400, message: "Invalid or unknown coupon code" };
    }
    if (!coupon.active) {
        throw { status: 400, message: "This coupon is no longer active" };
    }
    if (coupon.expiryDate && new Date(coupon.expiryDate).getTime() < Date.now()) {
        throw { status: 400, message: "This coupon has expired" };
    }
    if (coupon.usageLimit != null && coupon.usageLimit > 0 && coupon.usageCount >= coupon.usageLimit) {
        throw { status: 400, message: "This coupon has reached its usage limit" };
    }
    if (userId && coupon.perUserLimit != null && coupon.perUserLimit > 0) {
        const used = await couponUsedCount(coupon._id, userId);
        if (used >= coupon.perUserLimit) {
            throw { status: 400, message: "Coupon usage limit reached for this customer" };
        }
    }
    return { coupon: coupon };
}

// Number of orders a user has already redeemed this coupon on.
async function couponUsedCount(couponId, userId) {
    if (!userId) return 0;
    const usage = await CouponUsage.findOne({ coupon: couponId, user: userId }, "count");
    return usage && usage.count ? usage.count : 0;
}

// Atomically claim one use of a coupon for a user, honoring perUserLimit even
// under concurrency:
//  - guarded compare-and-swap first (only increments while count < cap),
//  - first-ever use falls back to an insert (unique index breaks ties),
//  - an insert race retries the guarded increment once before failing.
// Throws { status: 400, message } when the customer's cap is already hit.
async function reserveCouponUsage(coupon, userId) {
    if (!userId) return;

    const limit = coupon.perUserLimit != null && coupon.perUserLimit > 0 ? Number(coupon.perUserLimit) : null;

    if (limit != null) {
        const cas = await CouponUsage.updateOne(
            { coupon: coupon._id, user: userId, $expr: { $lt: ["$count", limit] } },
            { $inc: { count: 1 } }
        );
        if (cas && cas.matchedCount === 1) return;

        const existing = await CouponUsage.findOne({ coupon: coupon._id, user: userId }, "count");
        if (existing) {
            if (existing.count >= limit) {
                throw { status: 400, message: "Coupon usage limit reached for this customer" };
            }
            // Doc exists but a concurrent update won the slot: retry the CAS once.
            const retry = await CouponUsage.updateOne(
                { coupon: coupon._id, user: userId, $expr: { $lt: ["$count", limit] } },
                { $inc: { count: 1 } }
            );
            if (retry && retry.matchedCount === 1) return;
            throw { status: 400, message: "Coupon usage limit reached for this customer" };
        }

        // First ever use for this customer: create the row (unique index makes
        // exactly one concurrent checkout succeed).
        try {
            await CouponUsage.create({ coupon: coupon._id, user: userId, count: 1 });
        } catch (err) {
            if (err && err.code === 11000) {
                const retry = await CouponUsage.updateOne(
                    { coupon: coupon._id, user: userId, $expr: { $lt: ["$count", limit] } },
                    { $inc: { count: 1 } }
                );
                if (retry && retry.matchedCount === 1) return;
                throw { status: 400, message: "Coupon usage limit reached for this customer" };
            }
            throw err;
        }
        return;
    }

    // No per-user cap: a simple upsert increment.
    await CouponUsage.updateOne(
        { coupon: coupon._id, user: userId },
        { $inc: { count: 1 } },
        { upsert: true }
    );
}

// Give one use back when an order is cancelled. The count is floored at 0; a
// zero-count row is removed so a reused coupon can start fresh.
async function releaseCouponUsage(couponId, userId) {
    if (!userId || !couponId) return;
    await CouponUsage.updateOne(
        { coupon: couponId, user: userId, count: { $gt: 0 } },
        { $inc: { count: -1 } }
    );
    await CouponUsage.findOneAndDelete({ coupon: couponId, user: userId, count: 0 });
}

// Discount amount in rupees for a given cart subtotal.
// Throws when the cart is below the coupon's minimum order value.
function computeCouponDiscount(coupon, subtotal) {
    if (coupon.minimumOrderValue > 0 && subtotal < coupon.minimumOrderValue) {
        throw {
            status: 400,
            message: "This coupon requires a minimum order of ₹" + coupon.minimumOrderValue + ". Add items worth ₹" +
                (coupon.minimumOrderValue - subtotal) + " more to use it."
        };
    }
    let discount = 0;
    if (coupon.discountType === "percentage") {
        const pct = Math.min(Math.max(Number(coupon.discountValue) || 0, 0), 100);
        discount = round2((subtotal * pct) / 100);
    } else if (coupon.discountType === "fixed") {
        discount = Math.min(Number(coupon.discountValue) || 0, subtotal);
    }
    // Never allow the discount to be negative or exceed the goods value.
    discount = round2(Math.max(0, discount));
    return discount;
}

module.exports = { normalizeCode, findValidCoupon, computeCouponDiscount, round2, couponUsedCount, reserveCouponUsage, releaseCouponUsage };