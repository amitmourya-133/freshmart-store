// ===============================
// COUPON CONTROLLER
// Customer: POST /api/coupons/validate  (apply during checkout)
// Admin:    GET/POST/PUT/DELETE /api/coupons (CRUD + usage) — admin middleware
// Server-authoritative: the discount is always recomputed from the Coupon doc.
// ===============================

const Coupon = require("../models/Coupon");
const CouponUsage = require("../models/CouponUsage");
const User = require("../models/User");
const segments = require("../utils/segments");
const analytics = require("../utils/analytics");
const { normalizeCode, findValidCoupon, computeCouponDiscount } = require("../utils/coupons");

const MAX_VALUE = 1000000;

function validCouponPayload(body) {
    const errors = [];
    const code = normalizeCode(body.code);
    if (!code || !/^[A-Z0-9_-]+$/.test(code)) errors.push("Coupon code must contain only letters, numbers, _ or -");
    const discountType = body.discountType;
    if (discountType !== "percentage" && discountType !== "fixed") errors.push("discountType must be 'percentage' or 'fixed'");
    const discountValue = Number(body.discountValue);
    if (!Number.isFinite(discountValue) || discountValue <= 0 || discountValue > MAX_VALUE) {
        errors.push("Enter a discount value greater than 0");
    } else if (discountType === "percentage" && discountValue > 100) {
        errors.push("Percentage discount cannot exceed 100%");
    }
    const minimumOrderValue = body.minimumOrderValue === undefined || body.minimumOrderValue === null || body.minimumOrderValue === ""
        ? 0
        : Number(body.minimumOrderValue);
    if (!Number.isFinite(minimumOrderValue) || minimumOrderValue < 0 || minimumOrderValue > MAX_VALUE) {
        errors.push("Minimum order value must be 0 or more");
    }
    let expiryDate = null;
    if (body.expiryDate) {
        const t = new Date(body.expiryDate).getTime();
        if (!Number.isFinite(t)) errors.push("Enter a valid expiry date");
        else expiryDate = new Date(t);
    } else {
        errors.push("Expiry date is required");
    }
    let usageLimit = null;
    if (body.usageLimit !== undefined && body.usageLimit !== null && body.usageLimit !== "") {
        const ul = Number(body.usageLimit);
        if (!Number.isInteger(ul) || ul < 0 || ul > 999999999) errors.push("Usage limit must be a positive whole number");
        else usageLimit = ul || null;
    }
    let perUserLimit = null;
    if (body.perUserLimit !== undefined && body.perUserLimit !== null && body.perUserLimit !== "") {
        const p = Number(body.perUserLimit);
        if (!Number.isInteger(p) || p < 0 || p > 999999999) errors.push("Per-user limit must be a positive whole number or empty for unlimited");
        else perUserLimit = p || null;
    }
    const active = body.active === undefined || body.active === null || String(body.active) === "true";
    // Segment targeting (Phase 2): validated against the enum; null = general.
    let segment = null;
    if (body.segment && String(body.segment).trim()) {
        const SEGMENTS = ["NEW_CUSTOMER", "INACTIVE_30_DAYS", "FREQUENT_BUYER", "HIGH_VALUE", "AT_RISK"];
        if (!SEGMENTS.includes(String(body.segment).trim())) errors.push("Unknown customer segment");
        else segment = String(body.segment).trim();
    }
    let maxDiscountAmount = null;
    if (body.maxDiscountAmount !== undefined && body.maxDiscountAmount !== null && body.maxDiscountAmount !== "") {
        const cap = Number(body.maxDiscountAmount);
        if (!Number.isFinite(cap) || cap < 0 || cap > MAX_VALUE) errors.push("Max discount amount must be a positive amount or empty");
        else maxDiscountAmount = cap || null;
    }
    const segmentOnly = body.segmentOnly === undefined || body.segmentOnly === null
        ? (segment ? true : false)
        : String(body.segmentOnly) === "true";
    return { errors, payload: { code, discountType, discountValue: round2(discountValue), minimumOrderValue: round2(minimumOrderValue), expiryDate, usageLimit, perUserLimit, active, segment, maxDiscountAmount, segmentOnly } };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

// Validate a coupon against the current cart subtotal (customer only).
exports.validateCoupon = async (req, res) => {
    try {
        const code = normalizeCode(req.body.code);
        const subtotal = Number(req.body.subtotal);
        if (!Number.isFinite(subtotal) || subtotal < 0) {
            return res.status(400).json({ success: false, message: "Invalid cart subtotal" });
        }
        const { coupon } = await findValidCoupon(code, { userId: req.user ? req.user._id : null });
        const discountAmount = computeCouponDiscount(coupon, subtotal);
        res.json({
            success: true,
            data: {
                valid: true,
                code: coupon.code,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                minimumOrderValue: coupon.minimumOrderValue,
                expiresAt: coupon.expiryDate,
                discountAmount: discountAmount,
                subtotal: round2(subtotal),
                message: "Coupon applied"
            }
        });
    } catch (error) {
        if (error && error.status) {
            return res.status(error.status).json({ success: false, message: error.message, data: { valid: false } });
        }
        res.status(400).json({ success: false, message: error.message, data: { valid: false } });
    }
};

// Customer: list coupons currently available to THIS user. Segment-scoped
// coupons are hidden unless the user currently belongs to that segment, so a
// targeted promo never leaks to non-targeted customers. Fires coupon_viewed so
// campaign performance is measurable.
exports.listAvailableCoupons = async (req, res) => {
    try {
        const userId = req.user ? req.user._id : null;
        let mySegments = null;
        if (userId) {
            try {
                const seg = await segments.segmentOf(userId);
                mySegments = seg && seg.segments ? seg.segments : [];
            } catch (e) {
                mySegments = [];
            }
        }

        const now = new Date();
        const coupons = await Coupon.find({
            active: true,
            $or: [{ expiryDate: { $gt: now } }, { expiryDate: null }],
            $and: [
                {
                    $or: [
                        { segment: null },
                        ...(mySegments && mySegments.length ? mySegments.map(function (s) { return { segment: s }; }) : [{ segment: { $exists: false } }])
                    ]
                }
            ]
        }).sort({ createdAt: -1 }).limit(50);

        const data = coupons.map(function (c) {
            return c.publicView && typeof c.publicView === "function" ? c.publicView() : {
                code: c.code, discountType: c.discountType, discountValue: c.discountValue,
                minimumOrderValue: c.minimumOrderValue, expiresAt: c.expiryDate, segment: c.segment || null
            };
        });

        // Fire-and-forget engagement signal.
        if (data && data.length) {
            analytics.track({
                eventName: "coupon_viewed",
                user: req.user,
                metadata: { count: data.length, visibleBySegment: mySegments || null },
            });
        }

        res.json({ success: true, count: data.length, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: segment population summary for targeting decisions.
exports.segmentSummary = async (req, res) => {
    try {
        const summary = await segments.segmentCounts();
        res.json({ success: true, data: summary });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: publish a coupon to a specific customer segment. The coupon carries
// segment fields; eligibility itself is always enforced server-side at
// validation/redemption time (utils/coupons + utils/segments), never by the
// campaign UI.
exports.issueSegmentCoupon = async (req, res) => {
    try {
        const { errors, payload } = validCouponPayload(req.body);
        if (errors.length) return res.status(400).json({ success: false, message: errors[0] });
        if (!payload.segment) return res.status(400).json({ success: false, message: "segment is required for a segment coupon" });
        const existing = await Coupon.findOne({ code: payload.code });
        if (existing) return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
        const coupon = await Coupon.create(payload);
        analytics.track({
            eventName: "coupon_issued",
            user: req.user,
            metadata: {
                code: coupon.code,
                segment: coupon.segment,
                discountType: coupon.discountType,
                discountValue: coupon.discountValue,
                maxDiscountAmount: coupon.maxDiscountAmount || null,
                expiresAt: coupon.expiryDate,
            },
        });
        res.status(201).json({ success: true, data: coupon, targetedSegment: coupon.segment });
    } catch (error) {
        if (error && error.code === 11000) return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
        res.status(400).json({ success: false, message: error.message });
    }
};

// Admin: list coupons (includes usage so the admin can adjust limits).
exports.listCoupons = async (req, res) => {
    try {
        const coupons = await Coupon.find({}).sort({ createdAt: -1 });

        // Per-coupon redemption summary: total uses and the top customers.
        const usageRows = await CouponUsage.aggregate([{ $group: { _id: "$coupon", users: { $sum: 1 }, uses: { $sum: "$count" } } }]);
        const usageMap = new Map(usageRows.map(function (r) { return [String(r._id), r]; }));

        // Resolve top customers per coupon (bounded, for the admin panel).
        const topUserRows = await CouponUsage.aggregate([
            { $sort: { count: -1 } },
            { $limit: 200 },
            { $lookup: { from: "users", localField: "user", foreignField: "_id", as: "u" } },
            { $project: { coupon: 1, count: 1, name: { $arrayElemAt: ["$u.name", 0] }, email: { $arrayElemAt: ["$u.email", 0] } } }
        ]);
        const topUsersMap = new Map();
        topUserRows.forEach(function (r) {
            if (!topUsersMap.has(String(r.coupon))) topUsersMap.set(String(r.coupon), []);
            topUsersMap.get(String(r.coupon)).push({ user: r.name || (r.email ? r.email.split("@")[0] : "Customer"), count: r.count });
        });

        const data = coupons.map(function (c) {
            const stat = usageMap.get(String(c._id));
            const used = stat ? stat.uses : 0;
            const perUserUsed = stat ? stat.users : 0;
            return {
                _id: c._id,
                code: c.code,
                discountType: c.discountType,
                discountValue: c.discountValue,
                minimumOrderValue: c.minimumOrderValue,
                expiryDate: c.expiryDate,
                active: c.active,
                usageLimit: c.usageLimit,
                usageCount: c.usageCount,
                perUserLimit: c.perUserLimit,
                segment: c.segment || null,
                maxDiscountAmount: c.maxDiscountAmount || null,
                segmentOnly: c.segmentOnly || false,
                remainingUses: c.usageLimit != null ? Math.max(0, c.usageLimit - c.usageCount) : null,
                perUserRemaining: c.perUserLimit != null ? Math.max(0, c.perUserLimit - perUserUsed) : null,
                totalUserClaims: perUserUsed,
                topUsers: (topUsersMap.get(String(c._id)) || []).slice(0, 5),
                createdAt: c.createdAt
            };
        });

        res.json({ success: true, count: data.length, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: create coupon.
exports.createCoupon = async (req, res) => {
    try {
        const { errors, payload } = validCouponPayload(req.body);
        if (errors.length) {
            return res.status(400).json({ success: false, message: errors[0] });
        }
        const existing = await Coupon.findOne({ code: payload.code });
        if (existing) {
            return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
        }
        const coupon = await Coupon.create(payload);
        res.status(201).json({ success: true, data: coupon });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (error && error.code === 11000) {
            return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: update coupon (partial).
exports.updateCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findById(req.params.id);
        if (!coupon) {
            return res.status(404).json({ success: false, message: "Coupon not found" });
        }
        const { errors, payload } = validCouponPayload(Object.assign({}, coupon.toObject(), req.body, {
            code: req.body.code !== undefined ? req.body.code : coupon.code
        }));
        if (errors.length) {
            return res.status(400).json({ success: false, message: errors[0] });
        }
        if (payload.code !== coupon.code) {
            const dup = await Coupon.findOne({ code: payload.code, _id: { $ne: coupon._id } });
            if (dup) {
                return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
            }
        }
        Object.assign(coupon, payload);
        await coupon.save();
        res.json({ success: true, data: coupon });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            return res.status(400).json({ success: false, message: error.message });
        }
        if (error && error.code === 11000) {
            return res.status(400).json({ success: false, message: "A coupon with this code already exists" });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// Admin: delete coupon.
exports.deleteCoupon = async (req, res) => {
    try {
        const coupon = await Coupon.findByIdAndDelete(req.params.id);
        if (!coupon) {
            return res.status(404).json({ success: false, message: "Coupon not found" });
        }
        res.json({ success: true, message: "Coupon deleted", data: { id: coupon._id } });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};