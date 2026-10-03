// ===============================
// PUSH NOTIFICATION CONTROLLER
// Sends Web Push notifications using VAPID keys from the environment.
// Subscriptions are stored in MongoDB: a filesystem store does not survive
// serverless invocations (ephemeral, per-instance disk), which is why Chrome
// alerts used to disappear. Dead endpoints (404/410) are deactivated
// automatically so a revoked browser permission never spams failures.
// ===============================

const webpush = require("web-push");
const { safeErrorMessage } = require("../utils/safeError");
const PushSubscription = require("../models/PushSubscription");

const pubKey = process.env.VAPID_PUBLIC_KEY;
const privKey = process.env.VAPID_PRIVATE_KEY;

if (pubKey && privKey) {
    webpush.setVapidDetails(
        "mailto:admin@freshmart.com",
        pubKey,
        privKey
    );
}

function isConfigured() {
    return Boolean(pubKey && privKey);
}

// Keep only what the Web Push library needs, in the shape it expects.
function toWebPushSubscription(doc) {
    return {
        endpoint: doc.endpoint,
        keys: {
            p256dh: doc.keys && doc.keys.p256dh,
            auth: doc.keys && doc.keys.auth,
        },
    };
}

function errorText(e) {
    const msg = (e && (e.body || e.message)) || "unknown";
    return String(msg).slice(0, 300);
}

// POST /api/notifications/subscribe - store a push subscription for the user.
exports.subscribe = async (req, res) => {
    try {
        if (!isConfigured()) {
            return res.status(503).json({ success: false, message: "Push notifications not configured" });
        }
        const subscription = req.body.subscription;
        if (!subscription || !subscription.endpoint) {
            return res.status(400).json({ success: false, message: "Invalid subscription" });
        }
        if (!subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
            return res.status(400).json({ success: false, message: "Invalid subscription keys" });
        }

        // One endpoint == one browser. Upserting re-activates a subscription the
        // same browser makes again after a permission reset.
        await PushSubscription.findOneAndUpdate(
            { endpoint: String(subscription.endpoint) },
            {
                $set: {
                    user: req.user._id,
                    keys: {
                        p256dh: String(subscription.keys.p256dh),
                        auth: String(subscription.keys.auth),
                    },
                    userAgent: String(req.get("user-agent") || "").slice(0, 200),
                    active: true,
                    failureCount: 0,
                    lastError: null,
                },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        return res.json({ success: true, message: "Subscribed to push notifications" });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// DELETE /api/notifications/unsubscribe - remove a push subscription.
exports.unsubscribe = async (req, res) => {
    try {
        const endpoint = req.body && req.body.endpoint;
        if (endpoint) {
            // Scoped to the caller: a user can only drop their own endpoint.
            await PushSubscription.deleteOne({ endpoint: String(endpoint), user: req.user._id });
        } else {
            await PushSubscription.deleteMany({ user: req.user._id });
        }
        return res.json({ success: true, message: "Unsubscribed from push notifications" });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/notifications/vapid-key - expose the public VAPID key to the frontend.
exports.getVapidKey = async (req, res) => {
    res.json({ success: true, publicKey: pubKey || null });
};

// GET /api/notifications/push-status - is push wired up for THIS user?
// Lets the UI skip the permission prompt when there is nothing to subscribe to.
exports.getMyPushStatus = async (req, res) => {
    try {
        const active = await PushSubscription.countDocuments({ user: req.user._id, active: true });
        return res.json({ success: true, configured: isConfigured(), activeSubscriptions: active });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// Send a push notification to every active subscription of ONE user.
// Never throws for a delivery problem: push is best-effort by design.
exports.sendPushToUser = async (userId, title, body, url, extra) => {
    const result = { sent: 0, failed: 0, deactivated: 0, configured: isConfigured() };
    if (!userId || !isConfigured()) return result;

    try {
        const subs = await PushSubscription.find({ user: userId, active: true }).lean();
        if (!subs.length) return result;

        const payload = JSON.stringify({
            title: title || "FreshMart",
            body: body || "",
            icon: "/jacfruit.png",
            badge: "/jacfruit.png",
            url: url || "/index.html",
            data: (extra && extra.data) || undefined,
            tag: (extra && extra.tag) || undefined,
            requireInteraction: Boolean(extra && extra.requireInteraction),
            // A time-boxed vibration pattern: enough to be felt in a pocket,
            // short enough not to be unpleasant. Ignored where unsupported.
            vibrate: (extra && extra.vibrate) || undefined,
            // Opt-in quiet banner; everything else is allowed to sound/vibrate.
            silent: Boolean(extra && extra.silent),
        });

        for (const sub of subs) {
            try {
                await webpush.sendNotification(toWebPushSubscription(sub), payload);
                result.sent += 1;
                await PushSubscription.updateOne(
                    { _id: sub._id },
                    { $set: { lastSentAt: new Date(), lastSuccessAt: new Date(), failureCount: 0, lastError: null } }
                );
            } catch (e) {
                result.failed += 1;
                const code = e && e.statusCode;
                if (code === 404 || code === 410) {
                    // The browser threw the subscription away: never retry it.
                    result.deactivated += 1;
                    await PushSubscription.updateOne(
                        { _id: sub._id },
                        { $set: { active: false, lastError: "gone (" + code + ")", failureCount: 1 } }
                    );
                } else {
                    // Transient (429 rate limit, network): keep the subscription
                    // but remember the failure so a flapping endpoint is visible.
                    await PushSubscription.updateOne(
                        { _id: sub._id },
                        { $inc: { failureCount: 1 }, $set: { lastSentAt: new Date(), lastError: errorText(e) } }
                    );
                }
            }
        }
        return result;
    } catch (e) {
        console.warn("[push] send failed: " + ((e && e.message) || "unknown"));
        return result;
    }
};

// Fan out to many users (used for a broadcast to every online partner).
// `pushed` lists the users that actually had at least one live subscription
// succeed, so callers can keep a per-partner audit without guessing.
exports.sendPushToUsers = async (userIds, title, body, url, extra) => {
    const result = { sent: 0, failed: 0, deactivated: 0, recipients: 0, pushed: [] };
    const ids = Array.isArray(userIds) ? userIds.filter(Boolean) : [];
    for (const id of ids) {
        const r = await exports.sendPushToUser(id, title, body, url, extra);
        result.sent += r.sent;
        result.failed += r.failed;
        result.deactivated += r.deactivated;
        if (r.sent > 0) {
            result.recipients += 1;
            result.pushed.push(String(id));
        }
    }
    return result;
};

// Send a push notification to all admin subscriptions (new-order alert).
exports.sendPushToAdmins = async (title, body, url, extra) => {
    if (!isConfigured()) return { sent: 0, failed: 0, deactivated: 0, recipients: 0 };
    const User = require("../models/User");
    const admins = await User.find({ role: "admin" }).select("_id").lean();
    return exports.sendPushToUsers(admins.map(function (a) { return a._id; }), title, body, url, extra);
};

// Housekeeping: deactivate endpoints that have been failing transiently for a
// long time so a broken browser never accumulates retry noise.
exports.pruneFlakySubscriptions = async (maxFailures) => {
    const limit = Number(maxFailures) > 0 ? Number(maxFailures) : 25;
    const res = await PushSubscription.updateMany(
        { active: true, failureCount: { $gte: limit } },
        { $set: { active: false, lastError: "pruned after repeated failures" } }
    );
    return res.modifiedCount || 0;
};
