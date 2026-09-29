// ===============================
// REFERRAL SERVICE
// Shareable FMXXXXXX codes + the first-delivery reward. Rules:
//   * a code belongs to one user (generated on first request, stored on User)
//   * a user can be referred only once (referredBy is immutable once set)
//   * self-referral is rejected
//   * the referrer is paid ₹50 only after the referred friend's FIRST
//     qualifying Delivered order (idempotent via wallet ledger referenceId).
// ===============================

const User = require("../models/User");
const Order = require("../models/Order");
const wallet = require("./wallet");

const REFERRAL_REWARD = 50;

// Unambiguous alphabet (no 0/O/1/I) so codes survive handwriting/typos.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function randomSuffix(len) {
    let out = "";
    for (let i = 0; i < len; i++) {
        out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return out;
}

// Generate + persist a unique referral code for a user (lazy, idempotent).
async function ensureReferralCode(userId) {
    const user = await User.findById(userId);
    if (!user) throw Object.assign(new Error("User not found"), { status: 404 });
    if (user.referralCode) return user.referralCode;

    for (let attempt = 0; attempt < 6; attempt++) {
        const code = "FM" + randomSuffix(6);
        try {
            await User.updateOne({ _id: userId, referralCode: null }, { $set: { referralCode: code } });
            const again = await User.findById(userId).select("referralCode");
            if (again && again.referralCode) return again.referralCode;
        } catch (err) {
            if (!(err && err.code === 11000)) throw err;
        }
    }
    throw Object.assign(new Error("Could not allocate a referral code"), { status: 500 });
}

function normalizeCode(code) {
    return String(code || "").trim().toUpperCase();
}

async function findUserByCode(code) {
    const c = normalizeCode(code);
    if (!c) return null;
    return User.findOne({ referralCode: c });
}

// Attach a referrer to an account. Immutable once set; self-referral rejected.
// Returns { ok, message } (never throws for business rejections).
async function claimReferral(targetUserId, code) {
    const c = normalizeCode(code);
    if (!c || !/^FM[A-Z2-9]{6}$/.test(c) || !/^[A-Z0-9]+$/i.test(c.replace("FM", ""))) {
        return { ok: false, message: "That referral code does not look valid." };
    }
    const target = await User.findById(targetUserId);
    if (!target) return { ok: false, message: "Account not found." };
    if (target.referredBy) return { ok: false, message: "This account is already linked to a referral." };

    const referrer = await findUserByCode(c);
    if (!referrer) return { ok: false, message: "That referral code does not exist." };
    if (String(referrer._id) === String(targetUserId)) {
        return { ok: false, message: "You cannot use your own referral code." };
    }

    const updated = await User.findOneAndUpdate(
        { _id: targetUserId, referredBy: null },
        { $set: { referredBy: referrer._id, referredAt: new Date() } },
        { new: true }
    );
    if (!updated) return { ok: false, message: "This account is already linked to a referral." };
    return { ok: true, referrerId: referrer._id };
}

// Is `order` the referred user's first qualifying delivered order?
// Qualifying = paid orders (COD delivered advances to PAID) with a positive total.
async function isFirstQualifyingOrder(order) {
    if (!order || !order.user) return false;
    if (!order.paid || !order.total || order.total <= 0) return false;
    const prior = await Order.countDocuments({
        user: order.user,
        _id: { $ne: order._id },
        status: "Delivered",
        paid: true,
        total: { $gt: 0 },
    });
    return prior === 0;
}

// Pay the referrer after the referred friend's first qualifying delivery.
// Idempotent by wallet referenceId = "referral:<orderId>".
// Returns { rewarded, referrerId } or { rewarded:false, reason }.
async function applyReferralReward(order) {
    if (!order || !order.user) return { rewarded: false, reason: "anonymous_order" };
    if (!(await isFirstQualifyingOrder(order))) return { rewarded: false, reason: "not_first_qualifying" };

    const referredUser = await User.findById(order.user).select("referredBy");
    if (!referredUser || !referredUser.referredBy) return { rewarded: false, reason: "no_referrer" };

    const result = await wallet.credit({
        userId: referredUser.referredBy,
        type: "REFERRAL_REWARD",
        amount: REFERRAL_REWARD,
        referenceType: "ReferralOrder",
        referenceId: "referral:" + String(order._id),
        description: "Referral reward — your friend's first order was delivered",
        createdBy: "system",
    });

    if (result.created) {
        return { rewarded: true, referrerId: referredUser.referredBy, amount: REFERRAL_REWARD };
    }
    return { rewarded: false, reason: "already_rewarded" };
}

module.exports = {
    REFERRAL_REWARD,
    ensureReferralCode,
    referenceCode: normalizeCode,
    findUserByCode,
    claimReferral,
    applyReferralReward,
    isFirstQualifyingOrder,
};