// ===============================
// ANALYTICS EVENT SERVICE
// Server-side fire-and-forget event recording. Used by controllers/routes for
// events the client cannot assert (order_delivered, reminder_sent, ...) and by
// the public tracking endpoint for client-side events. Never throws into the
// calling request path.
// ===============================

const AnalyticsEvent = require("../models/AnalyticsEvent");

const VALID_EVENTS = new Set(AnalyticsEvent.schema.path("eventName").enumValues || []);

function isValidEvent(name) {
    return VALID_EVENTS.has(name);
}

// Record an event without waiting for the disk write. Safe to call in the
// hottest code paths (configurable at the model enum; unknown events are
// silently dropped so callers cannot crash the app with a typo).
async function track(opts) {
    const name = opts && opts.eventName;
    if (!name || !isValidEvent(name)) return null;
    try {
        const doc = {
            eventName: name,
            userId: opts.userId || (opts.user && opts.user._id) || null,
            anonymousId: opts.anonymousId || null,
            sessionId: opts.sessionId || null,
            productId: opts.productId || null,
            orderId: opts.orderId || (opts.order && opts.order._id) || null,
            orderIdRef: opts.order && opts.order._id || null,
            metadata: opts.metadata || {},
            device: opts.device || null,
            page: opts.page || null,
        };
        return await AnalyticsEvent.create(doc);
    } catch (e) {
        console.warn("[analytics] track failed: " + ((e && e.message) || "unknown"));
        return null;
    }
}

module.exports = { track, isValidEvent };