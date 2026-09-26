// ===============================
// NOTIFICATION CONTROLLER
// ===============================

const Notification = require("../models/Notification");

// Fire-and-forget inbox addition. Never throws and never affects the calling
// request — a notification failure must not fail an order/payment/delivery.
async function notifyBase(userId, payload) {
    if (!userId) return;
    try {
        const doc = await Notification.create({
            user: userId,
            type: payload.type || "system",
            title: String(payload.title || "Update"),
            message: String(payload.message || ""),
            data: payload.data || {},
        });
        return doc;
    } catch (e) {
        console.warn("[notification] create failed: " + ((e && e.message) || "unknown"));
        return null;
    }
}

// Convenience: notify every user with a given role (e.g. low-stock to admins).
async function notifyRole(role, payload) {
    try {
        const User = require("../models/User");
        const users = await User.find({ role }).select("_id").limit(50);
        for (const u of users) await notifyBase(u._id, payload);
    } catch (e) {
        console.warn("[notification] role-notify failed: " + ((e && e.message) || "unknown"));
    }
}

// GET /api/notifications — recipient's inbox (newest first, unread first).
exports.getMyNotifications = async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
        const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
        const type = req.query.type;
        const read = req.query.read; // "true" | "false"

        const filter = { user: req.user._id };
        if (type && typeof type === "string") filter.type = type;
        if (read === "true") filter.read = true;
        else if (read === "false") filter.read = false;

        const notifications = await Notification.find(filter).sort({ read: 1, createdAt: -1 }).skip(skip).limit(limit);
        const unreadCount = await Notification.countDocuments({ user: req.user._id, read: false });

        return res.json({ success: true, count: notifications.length, unreadCount, data: notifications });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// GET /api/notifications/unread-count — cheap badge value for the bell.
exports.getUnreadCount = async (req, res) => {
    try {
        const unreadCount = await Notification.countDocuments({ user: req.user._id, read: false });
        return res.json({ success: true, unreadCount });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /api/notifications/read-all — mark everything read (owner).
exports.markAllRead = async (req, res) => {
    try {
        await Notification.updateMany(
            { user: req.user._id, read: false },
            { $set: { read: true, readAt: new Date() } }
        );
        return res.json({ success: true, message: "All notifications marked as read" });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

// PUT /api/notifications/:id/read — mark a single notification read (owner).
exports.markRead = async (req, res) => {
    try {
        if (!req.params.id || !/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) {
            return res.status(400).json({ success: false, message: "Invalid notification id" });
        }
        const notification = await Notification.findOneAndUpdate(
            { _id: req.params.id, user: req.user._id },
            { $set: { read: true, readAt: new Date() } },
            { new: true }
        );
        if (!notification) {
            return res.status(404).json({ success: false, message: "Notification not found" });
        }
        return res.json({ success: true, data: notification });
    } catch (error) {
        return res.status(500).json({ success: false, message: error.message });
    }
};

exports.notifyBase = notifyBase;
exports.notifyRole = notifyRole;