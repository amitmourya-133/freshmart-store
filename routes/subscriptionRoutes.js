const express = require("express");
const { safeErrorMessage } = require("../utils/safeError");
const router = express.Router();
const mongoose = require("mongoose");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const { protect, admin } = require("../middleware/auth");
const notificationController = require("../controllers/notificationController");
const analytics = require("../utils/analytics");
const subscriptionBox = require("../utils/subscriptionBox");

const BOX_FEATURE_NAMES = ["free_delivery", "priority_slots", "customizable_box", "extra_kg", "extra_fruits", "all_products", "skip_any_week", "pause_subscription"];
const PAY_MODES = ["cod", "manual"];

// Normalizes the box-related fields shared by create + update. Returns the
// fields to persist or an error string (null when valid).
function normalizeBoxPayload(body) {
    const out = {};
    if (body.boxItems !== undefined) {
        if (!Array.isArray(body.boxItems)) return { error: "boxItems must be an array" };
        const items = [];
        for (const it of body.boxItems) {
            if (!it || !it.productId) continue;
            const qty = Number(it.quantity);
            if (!it.productId || !/^[0-9a-f]{24}$/i.test(String(it.productId)) || !Number.isFinite(qty) || qty <= 0) {
                return { error: "Each box item needs a valid productId and quantity > 0" };
            }
            items.push({ productId: String(it.productId), unit: String(it.unit || "kg").slice(0, 10), quantity: qty });
        }
        out.boxItems = items;
    }
    if (body.deliveryEveryDays !== undefined) {
        const d = Number(body.deliveryEveryDays);
        if (!Number.isInteger(d) || d < 3 || d > 120) return { error: "deliveryEveryDays must be between 3 and 120" };
        out.deliveryEveryDays = d;
    }
    if (body.deliveryDayOfWeek !== undefined) {
        const dow = Number(body.deliveryDayOfWeek);
        if (!Number.isInteger(dow) || dow < -1 || dow > 6) return { error: "deliveryDayOfWeek must be -1..6" };
        out.deliveryDayOfWeek = dow;
    }
    if (body.paymentMode !== undefined) {
        if (!PAY_MODES.includes(String(body.paymentMode))) return { error: "paymentMode must be cod or manual" };
        out.paymentMode = String(body.paymentMode);
    }
    return { fields: out };
}

function inboxSub(userId, title, message, planName, dedupeKey) {
    notificationController.notifyBase(userId, {
        type: "subscription",
        title: title,
        message: message,
        dedupeKey: dedupeKey || undefined,
        data: { link: "subscription.html", plan: planName || "" },
    });
}

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(String(id || ""));
}

// NOTE: literal admin routes MUST be declared BEFORE the /:planId and
// /:subscriptionId param routes, otherwise Express matches e.g. POST /admin
// against /:planId (with planId="admin") and produces a CastError.

// GET /api/subscriptions/plans — list active plans (public)
router.get("/plans", async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find({ isActive: true }).sort({ sortOrder: 1 });
        return res.json({
            success: true,
            plans,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// GET /api/subscriptions/my — customer's active subscription (protected, customer)
router.get("/my", protect, async (req, res) => {
    try {
        const subscription = await UserSubscription.findOne({ user: req.user.id, status: "active" })
            .populate("plan")
            .sort({ createdAt: -1 });
        return res.json({
            success: true,
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// GET /api/subscriptions/admin/all — admin: list all plans (protected, admin)
router.get("/admin/all", protect, admin, async (req, res) => {
    try {
        const plans = await SubscriptionPlan.find({}).sort({ sortOrder: 1 });
        return res.json({
            success: true,
            plans,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// GET /api/subscriptions/admin/subscribers — admin: all subscriptions with
// customer context (bounded, dashboard-feed style).
router.get("/admin/subscribers", protect, admin, async (req, res) => {
    try {
        const subs = await UserSubscription.find({})
            .populate("user", "name email phone")
            .populate("plan", "name pricing")
            .sort({ createdAt: -1 })
            .limit(200)
            .lean();
        return res.json({
            success: true,
            count: subs.length,
            subscriptions: subs,
        });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
});

// POST /api/subscriptions/admin/process-due — admin/cron: run the Veggie Box
// fulfillment engine for all due active subscriptions (bounded batch). Each
// fulfilled cycle creates a real Order; shortfalls notify the customer.
router.post("/admin/process-due", protect, admin, async (req, res) => {
    try {
        const limit = req.body.limit !== undefined ? Number(req.body.limit) : 20;
        const summary = await subscriptionBox.fulfillDueSubscriptions(limit);
        return res.json({ success: true, data: summary });
    } catch (error) {
        return res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
});

// POST /api/subscriptions/admin — admin: create new plan (protected, admin)
router.post("/admin", protect, admin, async (req, res) => {
    try {
        const { name, description, pricing, features } = req.body;
        if (!name || !description || !pricing || !pricing.amount || !pricing.frequency) {
            return res.status(400).json({
                success: false,
                message: "Name, description, pricing amount and frequency are required",
            });
        }

        const plan = new SubscriptionPlan({
            name,
            description,
            pricing,
            features: features || [],
            sortOrder: req.body.sortOrder ?? 0,
        });

        const box = normalizeBoxPayload(req.body);
        if (box.error) {
            return res.status(400).json({ success: false, message: box.error });
        }
        if (box.fields && box.fields.boxItems) {
            // Validate that every box item references a real, active product
            // BEFORE persisting the plan (no dangling box references).
            const Product = require("../models/Product");
            const ids = box.fields.boxItems.map((i) => i.productId).filter(Boolean);
            const found = await Product.find({ _id: { $in: ids }, active: true }).select("_id").lean();
            if (found.length !== new Set(ids.map(String)).size) {
                return res.status(400).json({ success: false, message: "One or more box products are missing or inactive" });
            }
            Object.assign(plan, box.fields);
        }

        await plan.save();

        return res.json({
            success: true,
            message: "Plan created successfully",
            plan,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// PUT /api/subscriptions/admin/:planId — admin: update plan (protected, admin)
router.put("/admin/:planId", protect, admin, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.planId)) {
            return res.status(404).json({ success: false, message: "Plan not found" });
        }
        const box = normalizeBoxPayload(req.body);
        if (box.error) {
            return res.status(400).json({ success: false, message: box.error });
        }
        const updateFields = {
            name: req.body.name,
            description: req.body.description,
            pricing: req.body.pricing,
            features: req.body.features,
            isActive: req.body.isActive !== undefined ? req.body.isActive : true,
            sortOrder: req.body.sortOrder,
        };
        if (box.fields && box.fields.boxItems) {
            const Product = require("../models/Product");
            const ids = box.fields.boxItems.map((i) => i.productId).filter(Boolean);
            const found = await Product.find({ _id: { $in: ids }, active: true }).select("_id").lean();
            if (found.length !== new Set(ids.map(String)).size) {
                return res.status(400).json({ success: false, message: "One or more box products are missing or inactive" });
            }
        }
        Object.assign(updateFields, box.fields || {});
        const plan = await SubscriptionPlan.findByIdAndUpdate(
            req.params.planId,
            updateFields,
            { new: true, runValidators: true }
        );

        if (!plan) {
            return res.status(404).json({
                success: false,
                message: "Plan not found",
            });
        }

        return res.json({
            success: true,
            message: "Plan updated successfully",
            plan,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// DELETE /api/subscriptions/admin/:planId — admin: deactivate plan (protected, admin)
router.delete("/admin/:planId", protect, admin, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.planId)) {
            return res.status(404).json({ success: false, message: "Plan not found" });
        }
        const plan = await SubscriptionPlan.findByIdAndUpdate(
            req.params.planId,
            { isActive: false },
            { new: true }
        );

        if (!plan) {
            return res.status(404).json({
                success: false,
                message: "Plan not found",
            });
        }

        return res.json({
            success: true,
            message: "Plan deactivated successfully",
            plan,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// POST /api/subscriptions/:planId — customer subscribes (protected, customer)
router.post("/:planId", protect, async (req, res) => {
    try {
        const planId = req.params.planId;
        if (!isValidObjectId(planId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid plan id",
            });
        }
        const plan = await SubscriptionPlan.findById(planId);
        if (!plan || !plan.isActive) {
            return res.status(404).json({
                success: false,
                message: "Plan not found or inactive",
            });
        }

// Check if the customer already has a live subscription.
        // SEC-13: this used to match `status: "active"` only, so a PAUSED
        // subscription did not block a second one - the customer could stack a
        // second active subscription (and a second autopay mandate) behind a
        // paused plan, because the copy literally told them to "cancel or pause
        // it first". Any subscription that is not cancelled/expired blocks.
        const existing = await UserSubscription.findOne({
            user: req.user.id,
            status: { $nin: ["cancelled", "expired"] },
        });
        if (existing) {
            return res.status(400).json({
                success: false,
                message: "You already have an active subscription. Cancel or pause it first.",
            });
        }

        const frequencyDays = {
            weekly: 7,
            monthly: 30,
            quarterly: 91,
            "half-yearly": 182,
            yearly: 365,
        };
        const intervalDays = Number(plan.deliveryEveryDays) || frequencyDays[plan.pricing.frequency] || 7;
        // Anchor the first delivery on a whole number of intervals from now so
        // cycles stay aligned to the same weekday (Veggie Box cadence).
        const nextDeliveryDate = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

        // Lock in the box contents the customer just agreed to (Veggie Box).
        let boxSnapshot = [];
        try {
            boxSnapshot = await subscriptionBox.snapshotForPlan(plan.toObject ? plan.toObject() : plan);
        } catch (e) { /* snapshot is best-effort */ }

        const userSubscription = new UserSubscription({
            user: req.user.id,
            plan: planId,
            status: "active",
            nextDeliveryDate,
            boxSnapshot: boxSnapshot,
        });

        await userSubscription.save();
        inboxSub(req.user.id, "Subscription activated", "Your " + plan.name + " subscription is active. Next delivery " + nextDeliveryDate.toISOString().slice(0, 10) + ".", plan.name, "sub:" + String(userSubscription._id) + ":activate");

        analytics.track({
            eventName: "subscription_start",
            user: req.user,
            metadata: {
                plan: plan.name,
                planId: String(plan._id),
                intervalDays: intervalDays,
                boxItemCount: boxSnapshot.length,
                paymentMode: plan.paymentMode || "cod",
            },
        });

        return res.json({
            success: true,
            message: "Subscription activated successfully",
            subscription: userSubscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// SEC-13: subscription lifecycle state machine.
//
// Pause/resume/cancel had no transition guard at all - each handler loaded the
// subscription and assigned its target status unconditionally. That made the
// lifecycle rewritable: `PUT /cancel` then `PUT /resume` brought a CANCELLED
// subscription back to `active` (so a stopped recurring charge could be
// silently re-armed), a cancelled subscription could be "paused" instead of
// reported as already final, and every repeat call re-sent the notification and
// overwrote `cancelDate`.
//
// cancelled is now terminal, and each move only accepts its real predecessor.
const SUBSCRIPTION_TRANSITIONS = {
    paused: ["active"],
    active: ["paused"],
    cancelled: ["active", "paused"],
};

function subscriptionTransitionError(subscription, target) {
    const allowed = SUBSCRIPTION_TRANSITIONS[target] || [];
    if (allowed.indexOf(String(subscription.status)) !== -1) return null;
    if (String(subscription.status) === target) {
        return "Subscription is already " + target;
    }
    return "A " + String(subscription.status) + " subscription cannot be changed to " + target +
        (allowed.length ? " (allowed from: " + allowed.join(", ") + ")" : "");
}

// PUT /api/subscriptions/:subscriptionId/pause — pause subscription (protected, customer)
router.put("/:subscriptionId/pause", protect, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.subscriptionId)) {
            return res.status(404).json({ success: false, message: "Subscription not found" });
        }
        const subscription = await UserSubscription.findOne({
            _id: req.params.subscriptionId,
            user: req.user.id,
        });
        if (!subscription) {
            return res.status(404).json({ success: false, message: "Subscription not found" });
        }

        const bad = subscriptionTransitionError(subscription, "paused");
        if (bad) return res.status(400).json({ success: false, message: bad });

        subscription.status = "paused";
        await subscription.save();
        inboxSub(req.user.id, "Subscription paused", "Your subscription is paused. Resume anytime.", "", "sub:" + String(subscription._id) + ":pause");

        return res.json({
            success: true,
            message: "Subscription paused successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// PUT /api/subscriptions/:subscriptionId/resume — resume paused subscription (protected, customer)
router.put("/:subscriptionId/resume", protect, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.subscriptionId)) {
            return res.status(404).json({ success: false, message: "Subscription not found" });
        }
        const subscription = await UserSubscription.findOne({
            _id: req.params.subscriptionId,
            user: req.user.id,
        });
        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: "Subscription not found",
            });
        }

const bad = subscriptionTransitionError(subscription, "active");
        if (bad) return res.status(400).json({ success: false, message: bad });

        subscription.status = "active";
        await subscription.save();
        inboxSub(req.user.id, "Subscription resumed", "Your subscription is active again.", "", "sub:" + String(subscription._id) + ":resume");

        return res.json({
            success: true,
            message: "Subscription resumed successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

// PUT /api/subscriptions/:subscriptionId/cancel — cancel subscription (protected, customer)
router.put("/:subscriptionId/cancel", protect, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.subscriptionId)) {
            return res.status(404).json({ success: false, message: "Subscription not found" });
        }
        const subscription = await UserSubscription.findOne({
            _id: req.params.subscriptionId,
            user: req.user.id,
        });
        if (!subscription) {
            return res.status(404).json({
                success: false,
                message: "Subscription not found",
            });
        }

const bad = subscriptionTransitionError(subscription, "cancelled");
        if (bad) return res.status(400).json({ success: false, message: bad });

        subscription.status = "cancelled";
        subscription.cancelDate = new Date();
        await subscription.save();
        inboxSub(req.user.id, "Subscription cancelled", "Your subscription has been cancelled.", "", "sub:" + String(subscription._id) + ":cancel");

        analytics.track({
            eventName: "subscription_cancellation",
            user: req.user,
            metadata: { planId: String(subscription.plan || "") },
        });

        return res.json({
            success: true,
            message: "Subscription cancelled successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: safeErrorMessage(error),
        });
    }
});

module.exports = router;