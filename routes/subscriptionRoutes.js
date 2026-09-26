const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const { protect, admin } = require("../middleware/auth");
const notificationController = require("../controllers/notificationController");

function inboxSub(userId, title, message, planName) {
    notificationController.notifyBase(userId, {
        type: "subscription",
        title: title,
        message: message,
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
            message: error.message,
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
            message: error.message,
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
            message: error.message,
        });
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

        await plan.save();

        return res.json({
            success: true,
            message: "Plan created successfully",
            plan,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/subscriptions/admin/:planId — admin: update plan (protected, admin)
router.put("/admin/:planId", protect, admin, async (req, res) => {
    try {
        if (!isValidObjectId(req.params.planId)) {
            return res.status(404).json({ success: false, message: "Plan not found" });
        }
        const plan = await SubscriptionPlan.findByIdAndUpdate(
            req.params.planId,
            {
                name: req.body.name,
                description: req.body.description,
                pricing: req.body.pricing,
                features: req.body.features,
                isActive: req.body.isActive !== undefined ? req.body.isActive : true,
                sortOrder: req.body.sortOrder,
            },
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
            message: error.message,
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
            message: error.message,
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

        // Check if user already has active subscription
        const existing = await UserSubscription.findOne({
            user: req.user.id,
            status: "active",
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
        const intervalDays = frequencyDays[plan.pricing.frequency] || 7;
        const nextDeliveryDate = new Date(Date.now() + intervalDays * 24 * 60 * 60 * 1000);

        const userSubscription = new UserSubscription({
            user: req.user.id,
            plan: planId,
            status: "active",
            nextDeliveryDate,
        });

        await userSubscription.save();
        inboxSub(req.user.id, "Subscription activated", "Your " + plan.name + " subscription is active. Next delivery " + nextDeliveryDate.toISOString().slice(0, 10) + ".", plan.name);

        return res.json({
            success: true,
            message: "Subscription activated successfully",
            subscription: userSubscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

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
            return res.status(404).json({
                success: false,
                message: "Subscription not found",
            });
        }

        subscription.status = "paused";
        await subscription.save();
        inboxSub(req.user.id, "Subscription paused", "Your subscription is paused. Resume anytime.", "");

        return res.json({
            success: true,
            message: "Subscription paused successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
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

        subscription.status = "active";
        await subscription.save();
        inboxSub(req.user.id, "Subscription resumed", "Your subscription is active again.", "");

        return res.json({
            success: true,
            message: "Subscription resumed successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
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

        subscription.status = "cancelled";
        subscription.cancelDate = new Date();
        await subscription.save();
        inboxSub(req.user.id, "Subscription cancelled", "Your subscription has been cancelled.", "");

        return res.json({
            success: true,
            message: "Subscription cancelled successfully",
            subscription,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

module.exports = router;