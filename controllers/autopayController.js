// ===============================
// AUTOPAY CONTROLLER (Phase 3.9)
// ===============================

const AutopayMandate = require("../models/AutopayMandate");
const { safeErrorMessage } = require("../utils/safeError");
const UserSubscription = require("../models/UserSubscription");
const autopay = require("../utils/autopay");
const analytics = require("../utils/analytics");
const SubscriptionPlan = require("../models/SubscriptionPlan");

// SEC-11: ceiling for a mandate created WITHOUT a subscription (an explicit
// amount the customer typed). Well above any real FreshMart plan, but low
// enough that a tampered request cannot authorise a five-figure recurring pull.
const MAX_STANDALONE_MANDATE_AMOUNT = 100000;

// POST /api/autopay/mandate — request a mandate. Requires EXPLICIT consent
// (consentAccepted: true in the body). Without a configured provider the
// mandate is created in BLOCKED_PROVIDER and the response states the exact
// blocker — a charge is never implied.
exports.createMandate = async (req, res) => {
    try {
        const { subscriptionId, consentAccepted, bankAccountLast4 } = req.body;
        if (consentAccepted !== true) {
            return res.status(400).json({ success: false, message: "Explicit consent is required to set up autopay (UPDI mandate under NPCI guidelines)" });
        }

let chargeAmount = 0;
        let frequencyDays = 30;
        let planId = null;
        if (subscriptionId) {
            const sub = await UserSubscription.findOne({ _id: subscriptionId, user: req.user._id }).lean();
            if (!sub) return res.status(404).json({ success: false, message: "Subscription not found" });
            if (sub.status !== "active") return res.status(400).json({ success: false, message: "Autopay can only attach to an active subscription" });
            planId = sub.plan || null;

            // SEC-11: the charge amount is SERVER-AUTHORITATIVE. It used to be
            // read straight from `req.body.chargeAmount`, so the browser decided
            // how much a recurring mandate would pull. Fixing the plan price to
            // ₹1 (or to 0 to dodge the charge) needed nothing but a devtools
            // edit. The plan price is now the only source when a subscription is
            // attached, and a conflicting client value is rejected outright
            // rather than silently ignored.
            const plan = planId ? await SubscriptionPlan.findById(planId).lean() : null;
            const serverAmount = plan && Number.isFinite(Number(plan.pricing && plan.pricing.amount))
                ? Math.round(Number(plan.pricing.amount) * 100) / 100
                : null;
            if (serverAmount == null) {
                return res.status(400).json({ success: false, message: "This plan has no chargeable price. Autopay cannot be set up for it." });
            }
            if (req.body.chargeAmount != null && req.body.chargeAmount !== "") {
                const clientAmount = Math.round(Number(req.body.chargeAmount) * 100) / 100;
                if (!Number.isFinite(clientAmount) || Math.abs(clientAmount - serverAmount) > 0.01) {
                    return res.status(400).json({
                        success: false,
                        message: "The requested autopay amount does not match your plan price. Refresh and try again.",
                    });
                }
            }
            chargeAmount = serverAmount;
            if (plan && plan.deliveryEveryDays) {
                frequencyDays = Math.min(366, Math.max(1, Math.round(Number(plan.deliveryEveryDays) || 30)));
            }
        } else {
            // No subscription attached: an explicit amount is still required, but
            // it is bounded and rounded so it cannot be used to set up an
            // arbitrary recurring pull (or a negative/NaN one).
            const raw = req.body.chargeAmount != null && req.body.chargeAmount !== "" ? Number(req.body.chargeAmount) : 0;
            if (!Number.isFinite(raw) || raw < 0 || raw > MAX_STANDALONE_MANDATE_AMOUNT) {
                return res.status(400).json({
                    success: false,
                    message: "A valid chargeAmount between 0 and " + MAX_STANDALONE_MANDATE_AMOUNT + " is required.",
                });
            }
            chargeAmount = Math.round(raw * 100) / 100;
        }

        const last4 = String(bankAccountLast4 || "").trim();
        if (last4 && !/^\d{4}$/.test(last4)) return res.status(400).json({ success: false, message: "bankAccountLast4 must be exactly 4 digits (optional)" });

        // One clean pending mandate per user at a time, unless an old one is
        // already BLOCKED_PROVIDER (in which case we supersede it).
        const existing = await AutopayMandate.findOne({ user: req.user._id, status: { $in: ["PENDING_AUTHORIZATION", "ACTIVE"] } });
        if (existing) return res.status(400).json({ success: false, message: "You already have an autopay mandate" });

        const mandate = await AutopayMandate.create({
            user: req.user._id,
            subscription: subscriptionId || null,
            plan: planId,
chargeAmount: Number.isFinite(chargeAmount) && chargeAmount > 0 ? chargeAmount : 0,
            // SEC-11: frequency follows the server-side plan when there is one;
            // the client value is only honoured for a standalone mandate.
            frequencyDays: subscriptionId ? frequencyDays : Math.min(366, Math.max(1, Math.round(Number(req.body.frequencyDays) || 30))),
            consentAcceptedAt: new Date(),
            consentInfo: "FreshMart recurring subscription charge; user-reviewed and accepted at " + new Date().toISOString() + ".",
            bankAccountLast4: last4 || null,
            expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
            provider: process.env.AUTOPAY_PROVIDER || null,
        });

        const providerCall = await autopay.registerMandateWithProvider(mandate);
        if (providerCall.ok) {
            mandate.status = "ACTIVE";
            mandate.providerMandateId = providerCall.providerMandateId;
            await mandate.save();
        } else {
            mandate.status = providerCall.status || "BLOCKED_PROVIDER";
            mandate.lastChargeResult = { status: "blocked", at: new Date(), reason: providerCall.reason || "provider_not_configured" };
            await mandate.save();
        }

        analytics.track({
            eventName: "autopay_mandate_created",
            user: req.user,
            metadata: { mandateId: String(mandate._id), status: mandate.status, provider: providerConfiguredAt(mandate), reason: mandate.lastChargeResult && mandate.lastChargeResult.reason },
        });

        res.status(201).json({
            success: true,
            data: safeMandate(mandate),
            provider: autopay.providerInfo(),
            note: mandate.status === "BLOCKED_PROVIDER"
                ? "Autopay is set up with REAL consent but is awaiting a provider. No charge has run and no payment was assumed. Configure AUTOPAY_* env vars, then the mandate authorizes automatically on its next attempt."
                : "Mandate " + (mandate.status === "ACTIVE" ? "activated" : "pending"),
        });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

function providerConfiguredAt(mandate) {
    return mandate && mandate.provider ? mandate.provider : "none";
}

// GET /api/autopay/mandate — the caller's own mandate.
exports.myMandate = async (req, res) => {
    try {
        const mandate = await AutopayMandate.findOne({ user: req.user._id }).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: mandate ? safeMandate(mandate) : null, provider: autopay.providerInfo() });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/autopay/mandate/:id/cancel — owner-only cancel.
exports.cancelMandate = async (req, res) => {
    try {
        const mandate = await AutopayMandate.findOne({ _id: req.params.id, user: req.user._id });
        if (!mandate) return res.status(404).json({ success: false, message: "Mandate not found" });
        if (mandate.status !== "ACTIVE" && mandate.status !== "PENDING_AUTHORIZATION") {
            return res.status(400).json({ success: false, message: "Mandate is already " + mandate.status });
        }
        mandate.status = "CANCELLED";
        mandate.lastChargeResult = { status: "rejected", at: new Date(), reason: "customer_cancelled" };
        await mandate.save();
        res.json({ success: true, data: safeMandate(mandate) });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// POST /api/autopay/webhook — verified provider events only (HMAC).
exports.webhook = async (req, res) => {
    try {
        const signature = String(req.headers["x-autopay-signature"] || req.headers["x-signature"] || "");
        const raw = req.rawBody || (req.body ? JSON.stringify(req.body) : "");
        const secret = process.env.AUTOPAY_WEBHOOK_SECRET;
        if (!autopay.verifyWebhook(raw, signature, secret)) {
            return res.status(401).json({ success: false, message: "Bad signature" });
        }
        const event = req.body;
        if (!event || !event.type) return res.status(400).json({ success: false, message: "Missing event type" });
        const result = await autopay.applyChargeEvent(event);
        res.json({ success: true, applied: result.ok });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// Admin: GET /api/admin/autopay — all mandates.
exports.adminList = async (req, res) => {
    try {
        const mandates = await AutopayMandate.find({}).sort({ createdAt: -1 }).limit(200).populate("user", "name email").lean();
        res.json({ success: true, count: mandates.length, data: mandates.map(safeMandate), provider: autopay.providerInfo() });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// Sanitized view — strips provider references that belong to the platform.
function safeMandate(m) {
    return {
        _id: m._id,
        status: m.status,
        chargeAmount: m.chargeAmount,
        frequencyDays: m.frequencyDays,
        createdAt: m.createdAt,
        consentAcceptedAt: m.consentAcceptedAt,
        bankAccountLast4: m.bankAccountLast4 || null,
        consecutiveFailures: m.consecutiveFailures || 0,
        lastChargeResult: m.lastChargeResult || null,
        expiresAt: m.expiresAt,
        user: m.user && m.user._id ? { _id: m.user._id, name: m.user.name, email: m.user.email } : (m.user ? m.user : null),
        plan: m.plan || null,
    };
}

module.exports.safeMandate = safeMandate;