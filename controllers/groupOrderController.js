// ===============================
// GROUP / COLONY ORDER CONTROLLER (Phase 2.6)
// ===============================

const mongoose = require("mongoose");
const { safeErrorMessage } = require("../utils/safeError");
const GroupOrder = require("../models/GroupOrder");
const notificationController = require("../controllers/notificationController");
const analytics = require("../utils/analytics");
const groupRewards = require("../utils/groupRewards");

function publicGroup(g) {
    return {
        _id: g._id,
        title: g.title,
        description: g.description || "",
        area: g.area || null,
        rewardType: g.rewardType,
        rewardPercent: g.rewardPercent || null,
        minParticipants: g.minParticipants,
        maxParticipants: g.maxParticipants,
        expiresAt: g.expiresAt,
        status: g.status,
        participantCount: Array.isArray(g.participants) ? g.participants.length : 0,
        orderCount: Array.isArray(g.orders) ? g.orders.length : 0,
        remainingToThreshold: Math.max(0, g.minParticipants - (Array.isArray(g.orders) ? g.orders.length : 0)),
        host: g.host ? (g.hostObject && g.hostObject.name ? g.hostObject.name : String(g.host)) : null,
        createdAt: g.createdAt,
    };
}

// POST /api/groups — host creates a colony group.
exports.createGroup = async (req, res) => {
    try {
        const { title, description, area, minParticipants, maxParticipants, rewardType, rewardPercent, expiresAt } = req.body;

        if (!title || String(title).trim().length < 3) return res.status(400).json({ success: false, message: "Group title must be at least 3 characters" });
        const min = Number(minParticipants);
        const max = Number(maxParticipants);
        if (!Number.isInteger(min) || min < 2 || min > 100) return res.status(400).json({ success: false, message: "minParticipants must be 2..100" });
        if (!Number.isInteger(max) || max < min || min > 200) return res.status(400).json({ success: false, message: "maxParticipants must be >= minParticipants and <= 200" });

        let reward = "free_delivery";
        if (rewardType) {
            if (!["discount_percent", "free_delivery"].includes(String(rewardType))) return res.status(400).json({ success: false, message: "rewardType must be discount_percent or free_delivery" });
            reward = String(rewardType);
        }
        const rp = rewardPercent === undefined || rewardPercent === null ? 10 : Number(rewardPercent);
        if (reward === "discount_percent" && (!Number.isFinite(rp) || rp < 1 || rp > 25)) {
            return res.status(400).json({ success: false, message: "rewardPercent must be 1..25 when using discount_percent" });
        }
        const expObj = new Date(expiresAt || Date.now() + (24 * 60 * 60 * 1000));
        if (!Number.isFinite(expObj.getTime()) || expObj.getTime() <= Date.now() + 10 * 60 * 1000) {
            return res.status(400).json({ success: false, message: "expiresAt must be at least 10 minutes in the future" });
        }
        // Cap lifetime to keep collection bounded.
        if (expObj.getTime() > Date.now() + 14 * 24 * 60 * 60 * 1000) {
            return res.status(400).json({ success: false, message: "A group may stay open at most 14 days" });
        }
        // Owners must not dominate their own group runaway: cap groups per host.
        const recent = await GroupOrder.countDocuments({ host: req.user._id, status: "OPEN", expiresAt: { $gt: new Date() } });
        if (recent >= 5) return res.status(400).json({ success: false, message: "You already have 5 open groups. Close or wait for one to finish." });

        const group = await GroupOrder.create({
            host: req.user._id,
            title: String(title).trim().slice(0, 90),
            description: String(description || "").trim().slice(0, 300),
            area: String(area || "").trim().slice(0, 60) || null,
            minParticipants: min,
            maxParticipants: max,
            rewardType: reward,
            rewardPercent: reward === "discount_percent" ? rp : null,
            expiresAt: expObj,
        });

        analytics.track({
            eventName: "group_created",
            user: req.user,
            metadata: { groupId: String(group._id), minParticipants: min, rewardType: reward, rewardPercent: rp },
        });

        res.status(201).json({ success: true, data: publicGroup(group.toObject()) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET /api/groups — public listing of open groups (paginated).
exports.listGroups = async (req, res) => {
    try {
        const page = Math.max(1, Number(req.query.page) || 1);
        const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 10));
        const now = new Date();
        const where = { status: "OPEN", expiresAt: { $gt: now } };
        const total = await GroupOrder.countDocuments(where);
        const groups = await GroupOrder.find(where)
            .sort({ createdAt: -1 })
            .skip((page - 1) * limit)
            .limit(limit)
            .populate("host", "name")
            .lean();
        res.json({
            success: true,
            count: groups.length,
            total: total,
            page: page,
            data: groups.map(publicGroup),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET /api/groups/:id — public group detail.
exports.getGroup = async (req, res) => {
    try {
        if (!/^[0-9a-f]{24}$/i.test(String(req.params.id))) return res.status(404).json({ success: false, message: "Group not found" });
        const group = await GroupOrder.findById(req.params.id).populate("host", "name").lean();
        if (!group) return res.status(404).json({ success: false, message: "Group not found" });
        res.json({ success: true, data: publicGroup(group) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/groups/:id/join — express interest (preserves individual orders).
exports.joinGroup = async (req, res) => {
    try {
        const group = await GroupOrder.findById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: "Group not found" });
        if (group.status !== "OPEN") return res.status(400).json({ success: false, message: "This group is no longer accepting members" });
        if (new Date(group.expiresAt).getTime() < Date.now()) { group.status = "EXPIRED"; await group.save(); return res.status(400).json({ success: false, message: "This group has expired" }); }
        if (Array.isArray(group.participants) && group.participants.length >= group.maxParticipants) return res.status(400).json({ success: false, message: "This group has reached its maximum participants" });

        const existing = Array.isArray(group.participants) && group.participants.find(function (p) { return String(p.user) === String(req.user._id); });
        if (existing) return res.json({ success: true, message: "Already joined", data: publicGroup(group.toObject()) });

        group.participants.push({ user: req.user._id, joinedAt: new Date() });
        await group.save();

        analytics.track({ eventName: "group_joined", user: req.user, metadata: { groupId: String(group._id), title: group.title } });

        res.json({ success: true, message: "Joined group", data: publicGroup(group.toObject()) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/groups/:id/leave
exports.leaveGroup = async (req, res) => {
    try {
        const group = await GroupOrder.findById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: "Group not found" });
        if (group.status !== "OPEN") return res.status(400).json({ success: false, message: "This group is no longer accepting changes" });
        group.participants = (group.participants || []).filter(function (p) { return String(p.user) !== String(req.user._id); });
        await group.save();
        res.json({ success: true, message: "Left group", data: publicGroup(group.toObject()) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/groups/:id/order — place an individual order inside the group.
// Reuses the order pipeline with groupId pinned; the order is individually
// owned and paid; reward is credited once the group crosses its threshold.
exports.orderForGroup = async (req, res) => {
    try {
        const group = await GroupOrder.findById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: "Group not found" });
        if (group.status !== "OPEN") return res.status(400).json({ success: false, message: "This group is no longer accepting orders" });
        if (new Date(group.expiresAt).getTime() < Date.now()) { group.status = "EXPIRED"; await group.save(); return res.status(400).json({ success: false, message: "This group has expired" }); }
        if ((group.orders || []).length >= group.maxParticipants) return res.status(400).json({ success: false, message: "This group has reached its order capacity" });

        // Pin the group into the create-order payload and reuse the pipeline.
        req.body.groupId = String(group._id);
        const orderController = require("./orderController");
        return await orderController.createOrder(req, res, { honorGroupId: true });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/groups/:id/close — host closes their own group.
exports.closeGroup = async (req, res) => {
    try {
        const group = await GroupOrder.findById(req.params.id);
        if (!group) return res.status(404).json({ success: false, message: "Group not found" });
        if (String(group.host) !== String(req.user._id)) return res.status(403).json({ success: false, message: "Only the host can close this group" });
        if (group.status === "ACHIEVED" || group.status === "CLOSED") return res.status(400).json({ success: false, message: "Group already finished" });
        group.status = "CLOSED";
        await group.save();
        res.json({ success: true, message: "Group closed", data: publicGroup(group.toObject()) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/groups/ops/sweep — admin/cron sweep.
exports.sweep = async (req, res) => {
    try {
        const summary = await groupRewards.sweepGroups(Number(req.body.limit) || 50);
        res.json({ success: true, data: summary });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// publicGroup helper retained as a named export alongside the route handlers.
module.exports.publicGroup = publicGroup;