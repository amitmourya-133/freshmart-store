// ===============================
// WHATSAPP ORDER-UPDATE PROVIDER (Phase 2.5)
// Clean provider abstraction for WhatsApp Cloud API. Key contract:
//   * send() NEVER fabricates a delivery notification. When the provider is not
//     configured (env missing) or the customer has not opted in, it simply does
//     nothing and reports { sent: false, reason }.
//   * Mandatory opt-in: updates are only sent to users with User.whatsappOptIn.
//     The opt-in is a user action through the profile UI (whatsapp_opted_in
//     event), never implied by signup.
//   * Fire-and-forget call sites (controllers never await network sends).
//
// Configuration (server-side only, never shipped in the client):
//   WHATSAPP_PROVIDER   = "whatsapp_cloud"  (only recognised value)
//   WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_ID (WhatsApp Cloud API)
//   WHATSAPP_TEMPLATE   = template name for order-update messages
// ===============================

const fetch = global.fetch;

function isConfigured() {
    return process.env.WHATSAPP_PROVIDER === "whatsapp_cloud" &&
        !!process.env.WHATSAPP_ACCESS_TOKEN &&
        !!process.env.WHATSAPP_PHONE_ID;
}

function providerInfo() {
    return {
        configured: isConfigured(),
        provider: "whatsapp_cloud",
        blocker: isConfigured()
            ? null
            : "WHATSAPP_PROVIDER / WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_ID are not configured (owner must supply official WhatsApp Business API credentials)",
    };
}

// Resolve the recipient number. Only digits allowed; strips leading 0/+91.
function normalizeTo(to) {
    let digits = String(to || "").replace(/[^\d]/g, "");
    if (digits.startsWith("91") && digits.length === 12) digits = digits.slice(2);
    if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
    return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

const MESSAGE_TEMPLATES = {
    order_confirmed: function (order) {
        return "FreshMart: Order " + (order.orderNumber || "") + " confirmed! We are packing your " +
            (Array.isArray(order.items) ? order.items.length : 0) + " item(s).";
    },
    order_out_for_delivery: function (order) {
        return "FreshMart: Your order " + (order.orderNumber || "") + " is out for delivery 🛵";
    },
    order_delivered: function (order) {
        return "FreshMart: Your order " + (order.orderNumber || "") + " is delivered 🎉 Enjoy!";
    },
};

const EVENT_KEYS = {
    order_confirmed: "whatsappOrderConfirmedAt",
    order_out_for_delivery: "whatsappOrderOutAt",
    order_delivered: "whatsappOrderDeliveredAt",
};

// Core send. Resolves { sent: boolean, reason?, waid? }.
async function send({ to, event, order, templateArgs }) {
    if (!to) return { sent: false, reason: "no_recipient" };
    if (!isConfigured()) return { sent: false, reason: "provider_not_configured" };
    const phone = normalizeTo(to);
    if (!phone) return { sent: false, reason: "invalid_number" };
    const built = (MESSAGE_TEMPLATES[event] || MESSAGE_TEMPLATES.order_confirmed)(order);
    try {
        const res = await fetch(
            "https://graph.facebook.com/v18.0/" + process.env.WHATSAPP_PHONE_ID + "/messages",
            {
                method: "POST",
                headers: {
                    "Authorization": "Bearer " + process.env.WHATSAPP_ACCESS_TOKEN,
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    messaging_product: "whatsapp",
                    to: phone,
                    type: "text",
                    text: { body: built },
                }),
            }
        );
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        if (res.ok && body && body.messages && body.messages[0]) {
            return { sent: true, waid: body.messages[0].id, reason: null };
        }
        return { sent: false, reason: "whatsapp_api_error", detail: body && body.error ? body.error.message : text.slice(0, 200) };
    } catch (err) {
        return { sent: false, reason: "whatsapp_api_network_error" };
    }
}

// Opt-in-aware, dedupe-aware, fire-and-forget order update.
// order.whatsappEvents (string[]) marks events that already produced a brief to
// avoid spamming on webhook retries.
async function notifyOrderUpdate(order, event, user) {
    if (!order || !order._id || !EVENT_KEYS[event]) return { sent: false, reason: "unknown_event" };

    // Explicit opt-in gate.
    if (!user) return { sent: false, reason: "no_user" };
    if (user.whatsappOptIn !== true) return { sent: false, reason: "not_opted_in" };

    const key = EVENT_KEYS[event];
    // Dedupe: an order already notified for this event is skipped.
    if (order[key]) return { sent: false, reason: "already_notified" };

    const phone = user.phone || (user.addresses && user.addresses[0] && user.addresses[0].phone) || null;
    const to = user.whatsappPhone || phone;

    const result = await send({ to, event, order });
    if (result.sent) {
        // Mark the event fired so retries never double-send.
        await require("../models/Order").updateOne({ _id: order._id }, { $set: { [key]: new Date() } });
        return result;
    }
    return result;
}

module.exports = { notifyOrderUpdate, send, isConfigured, providerInfo, normalizeTo };