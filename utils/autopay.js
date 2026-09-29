// ===============================
// AUTOPAY PROVIDER ABSTRACTION (Phase 3.9)
// Boundary between FreshMart and a UPI Autopay provider. No provider is
// hard-coded as "successful": without AUTOPAY_PROVIDER + credentials everything
// is reported BLOCKED_PROVIDER so the app never fabricates a mandate or a
// payment. When a provider IS configured the integration calls its real API and
// records the real outcome; charges are only marked success from a genuine
// provider response (or its verified webhook).
//
// Configuration (server-side only):
//   AUTOPAY_PROVIDER, AUTOPAY_API_KEY, AUTOPAY_API_BASE, AUTOPAY_WEBHOOK_SECRET
//
// Security: webhook events carry an HMAC signature (AUTOPAY_WEBHOOK_SECRET) and
// the masterWebhook() verifies it with a length-safe compare BEFORE touching any
// data. Credentials are never stored on the mandate.
// ===============================

const crypto = require("crypto");
const AutopayMandate = require("../models/AutopayMandate");
const UserSubscription = require("../models/UserSubscription");
const notificationController = require("../controllers/notificationController");
const analytics = require("./analytics");

function providerConfigured() {
    return process.env.AUTOPAY_PROVIDER &&
        process.env.AUTOPAY_API_KEY &&
        process.env.AUTOPAY_API_BASE;
}

function providerInfo() {
    return {
        provider: process.env.AUTOPAY_PROVIDER || null,
        configured: providerConfigured(),
        blocker: providerConfigured()
            ? null
            : "AUTOPAY_PROVIDER / AUTOPAY_API_KEY / AUTOPAY_API_BASE are not configured (owner must add a real UPI Autopay provider before any charge can run).",
    };
}

// Create the provider-side mandate. With no provider configured this stays a
// clean, honest "BLOCKED_PROVIDER" — the request is refused rather than faked.
async function registerMandateWithProvider(mandate) {
    if (!providerConfigured()) {
        return { ok: false, status: "BLOCKED_PROVIDER", reason: "provider_not_configured" };
    }
    try {
        const res = await fetch(process.env.AUTOPAY_API_BASE + "/mandates", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + process.env.AUTOPAY_API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                amount: mandate.chargeAmount,
                interval_days: mandate.frequencyDays,
                customer_ref: String(mandate.user),
                // explicit consent, disclosed at creation
                consent: true,
            }),
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        if (res.ok && body && body.mandate_id) {
            return { ok: true, status: "ACTIVE", providerMandateId: String(body.mandate_id) };
        }
        return { ok: false, status: "REJECTED", reason: (body && body.error) ? body.error : "provider_refused" };
    } catch (err) {
        return { ok: false, status: "BLOCKED_PROVIDER", reason: "provider_network_error" };
    }
}

// Attempt one real charge on an ACTIVE mandate. Reports the honest result;
// a charge is NEVER enqueued as success without a provider response.
async function attemptCharge(mandate, amount) {
    if (mandate.status !== "ACTIVE") {
        return { ok: false, settled: false, reason: "mandate_not_active" };
    }
    if (!providerConfigured()) {
        return { ok: false, settled: false, reason: "provider_not_configured" };
    }
    try {
        const res = await fetch(process.env.AUTOPAY_API_BASE + "/mandates/" + encodeURIComponent(mandate.providerMandateId) + "/charges", {
            method: "POST",
            headers: {
                "Authorization": "Bearer " + process.env.AUTOPAY_API_KEY,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ amount: amount, reference: String(mandate._id), timestamp_utc: new Date().toISOString() }),
        });
        const text = await res.text();
        let body = null;
        try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
        if (res.ok && body && body.status === "success") {
            return { ok: true, settled: true, providerReference: body.reference || null };
        }
        return { ok: false, settled: false, reason: (body && body.error) ? body.error : "charge_refused" };
    } catch (err) {
        return { ok: false, settled: false, reason: "provider_network_error" };
    }
}

// Verified provider webhook (HMAC). Handles mandate events + charge receipts.
function verifyWebhook(rawBody, signature, secret) {
    if (!secret || !signature) return false;
    const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
    const provided = String(signature || "");
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Apply a charge outcome from a VERIFIED provider event.
async function applyChargeEvent(event) {
    if (!event || !event.mandate_id) return { ok: false };
    const mandate = await AutopayMandate.findOne({ providerMandateId: String(event.mandate_id) });
    if (!mandate) return { ok: false };
    const succeeded = event.status === "success" || event.status === "settled";
    if (succeeded) {
        mandate.consecutiveFailures = 0;
        mandate.lastChargeResult = { status: "success", at: new Date() };
        mandate.lastChargeAt = new Date();
        await mandate.save();
        analytics.track({
            eventName: "autopay_renewal_success",
            userId: mandate.user,
            metadata: { mandateId: String(mandate._id), amount: event.amount || 0 },
        });
    } else {
        mandate.consecutiveFailures = (mandate.consecutiveFailures || 0) + 1;
        mandate.lastChargeResult = { status: "failed", at: new Date(), reason: String(event.reason || "renewal failed") };
        if (mandate.consecutiveFailures >= 3) {
            mandate.status = "BLOCKED_PROVIDER";
            notificationController.notifyBase(mandate.user, {
                type: "autopay",
                title: "Autopay blocked after repeated failures",
                message: "Your UPI mandate failed 3 times and was blocked automatically. Update payment to avoid service interruption.",
                dedupeKey: "autopay_blocked:" + String(mandate._id),
                data: { link: "subscription.html" },
            });
        }
        await mandate.save();
        analytics.track({
            eventName: "autopay_renewal_failed",
            userId: mandate.user,
            metadata: { mandateId: String(mandate._id), failureCount: mandate.consecutiveFailures, reason: String(event.reason || "") },
        });
    }
    return { ok: true, mandate: mandate };
}

module.exports = { providerInfo, registerMandateWithProvider, attemptCharge, verifyWebhook, applyChargeEvent, providerConfigured };