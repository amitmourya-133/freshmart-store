// ===============================
// PUSH NOTIFICATION CONTROLLER
// Stores subscriptions per user and sends Web Push notifications.
// Uses VAPID keys from environment variables.
// ===============================

const webpush = require("web-push");
const fs = require("fs");
const path = require("path");

const pubKey = process.env.VAPID_PUBLIC_KEY;
const privKey = process.env.VAPID_PRIVATE_KEY;

if (pubKey && privKey) {
    webpush.setVapidDetails(
        "mailto:admin@freshmart.com",
        pubKey,
        privKey
    );
}

const SUB_FILE = path.join(__dirname, "..", "push-subscriptions.json");

function loadSubs() {
    try {
        return JSON.parse(fs.readFileSync(SUB_FILE, "utf8"));
    } catch (e) {
        return {};
    }
}

function saveSubs(subs) {
    fs.writeFileSync(SUB_FILE, JSON.stringify(subs, null, 2));
}

// POST /api/notifications/subscribe — store a push subscription for the user.
exports.subscribe = async (req, res) => {
    try {
        if (!pubKey || !privKey) {
            return res.status(503).json({ success: false, message: "Push notifications not configured" });
        }
        const subscription = req.body.subscription;
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ success: false, message: "Invalid subscription" });
        }
        const subs = loadSubs();
        const userId = req.user._id.toString();
        if (!subs[userId]) subs[userId] = [];
        const exists = subs[userId].find(s => s.endpoint === subscription.endpoint);
        if (!exists) {
            subs[userId].push({
                endpoint: subscription.endpoint,
                keys: subscription.keys,
                createdAt: new Date().toISOString()
            });
            saveSubs(subs);
        }
        res.json({ success: true, message: "Subscribed to push notifications" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

// DELETE /api/notifications/unsubscribe — remove a push subscription.
exports.unsubscribe = async (req, res) => {
    try {
        const subs = loadSubs();
        const userId = req.user._id.toString();
        if (subs[userId]) {
            subs[userId] = subs[userId].filter(s => s.endpoint !== req.body.endpoint);
            saveSubs(subs);
        }
        res.json({ success: true, message: "Unsubscribed" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
};

// GET /api/notifications/vapid-key — expose the public VAPID key to the frontend.
exports.getVapidKey = async (req, res) => {
    res.json({ success: true, publicKey: pubKey || null });
};

// Send a push notification to all subscriptions of a user.
exports.sendPushToUser = async (userId, title, body, url) => {
    if (!pubKey || !privKey) return;
    const subs = loadSubs();
    const userSubs = subs[userId.toString()] || [];
    const payload = JSON.stringify({
        title: title || "FreshMart",
        body: body || "",
        icon: "/jacfruit.png",
        url: url || "/index.html"
    });
    for (const sub of userSubs) {
        try {
            await webpush.sendNotification(sub, payload);
        } catch (e) {
            if (e.statusCode === 410 || e.statusCode === 404) {
                subs[userId.toString()] = subs[userId.toString()].filter(s => s.endpoint !== sub.endpoint);
                saveSubs(subs);
            }
        }
    }
};

// Send a push notification to all admin subscriptions.
exports.sendPushToAdmins = async (title, body, url) => {
    if (!pubKey || !privKey) return;
    const User = require("../models/User");
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    for (const admin of admins) {
        await exports.sendPushToUser(admin._id, title, body, url);
    }
};
