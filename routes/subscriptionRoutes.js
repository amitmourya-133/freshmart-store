const express = require("express");
const router = express();
const SubscriptionPlan = require("../models/SubscriptionPlan");
const UserSubscription = require("../models/UserSubscription");
const { protect, admin } = require("../middleware/auth");

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

// POST /api/subscriptions/:planId — customer subscribes (protected, customer)
router.post("/:planId", protect, async (req, res) => {
    try {
        const planId = req.params.planId;
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

        const userSubscription = new UserSubscription({
            user: req.user.id,
            plan: planId,
            status: "active",
            nextDeliveryDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now for weekly
        });

        await userSubscription.save();

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
        if (!name || !description || !pricing || !pricing.amount) {
            return res.status(400).json({
                success: false,
                message: "Name, description, and pricing amount are required",
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

module.exports = router;