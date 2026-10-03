// ===============================
// REFERRAL CONTROLLER
// GET /api/referral/me        — my shareable code + who referred me.
// POST /api/referral/claim    — link this account to a friend's code.
// ===============================

const referral = require("../utils/referral");
const { safeErrorMessage } = require("../utils/safeError");
const analytics = require("../utils/analytics");
const User = require("../models/User");

// GET /api/referral/me (auth).
exports.getMyReferral = async (req, res) => {
    try {
        const code = await referral.ensureReferralCode(req.user._id);
        const me = await User.findById(req.user._id).select("referredBy referredAt");
        let referredByName = null;
        if (me && me.referredBy) {
            const rb = await User.findById(me.referredBy).select("name");
            referredByName = rb ? rb.name : null;
        }
        return res.json({
            success: true,
            data: {
                code,
                referredBy: me ? me.referredBy : null,
                referredByName,
                rewardPerFriend: referral.REFERRAL_REWARD,
                shareLink: "signup.html?ref=" + code,
            },
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/referral/claim { code } (auth). Immutable once linked.
exports.claim = async (req, res) => {
    try {
        const code = String((req.body && req.body.code) || "").trim();
        if (!code) {
            return res.status(400).json({ success: false, message: "Referral code required" });
        }
        const result = await referral.claimReferral(req.user._id, code);
        if (!result.ok) {
            return res.status(400).json({ success: false, message: result.message });
        }
        analytics.track({
            eventName: "referral_signup",
            userId: req.user._id,
            metadata: { referrerId: String(result.referrerId) },
        });
        return res.json({ success: true, message: "Referral code applied!", data: { referredBy: result.referrerId } });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};