// ===============================
// COUPON LOGIC (shared by quote/order + validate endpoints)
// All discount decisions are computed here from the Coupon document only.
// Client-sent discount amounts/values are never trusted.
// ===============================

const Coupon = require("../models/Coupon");

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Normalize a coupon code for lookup/creation (always uppercase).
function normalizeCode(code) {
    return String(code || "").trim().toUpperCase();
}

// Locate a coupon that is currently usable. Returns { coupon } or
// throws { status: 400, message } with a customer-safe reason.
async function findValidCoupon(rawCode) {
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
    return { coupon: coupon };
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

module.exports = { normalizeCode, findValidCoupon, computeCouponDiscount, round2 };