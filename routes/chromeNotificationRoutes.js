// ===============================
// CHROME NOTIFICATION ROUTES
// Routes for Chrome desktop notification management
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const chromeNotificationController = require("../controllers/chromeNotificationController");

// All routes require authentication and admin role

// GET /api/admin/chrome-notifications/prefs - Get admin notification preferences
router.get("/prefs", protect, admin, async (req, res) => {
    try {
        const result = await chromeNotificationController.getChromeNotificationPrefs(req.user._id);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to get notification preferences" });
    }
});

// PUT /api/admin/chrome-notifications/prefs - Update admin notification preferences
router.put("/prefs", protect, admin, async (req, res) => {
    try {
        const { enabled, soundEnabled } = req.body;
        const result = await chromeNotificationController.updateChromeNotificationPrefs(
            req.user._id,
            enabled,
            soundEnabled
        );
        if (result.success) {
            res.json(result);
        } else {
            res.status(400).json(result);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to update notification preferences" });
    }
});

// POST /api/admin/chrome-notifications/check - Poll for new orders
router.post("/check", protect, admin, async (req, res) => {
    try {
        const userId = req.user._id;
        const { lastChecked } = req.body || {};
        
        // Get admin's last checked timestamp
        let lastCheckedTime = null;
        if (lastChecked) {
            const d = new Date(lastChecked);
            if (!isNaN(d.getTime())) lastCheckedTime = d;
        } else {
            lastCheckedTime = await chromeNotificationController.getAdminLastChecked(userId);
        }
        
        const Order = require("../models/Order");
        
        // Establish a safe baseline on first use so old orders are not reported.
        if (!lastCheckedTime) {
            const now = new Date();
            await chromeNotificationController.updateAdminLastChecked(userId, now);
            return res.json({
                success: true,
                lastChecked: now,
                orders: [],
                count: 0
            });
        }
        
        // Get orders created after last check (only the minimal info for notifications)
        const filter = { createdAt: { $gt: lastCheckedTime } };
        
        // Only select safe fields for notifications (no customer PII)
        const orders = await Order.find(filter, {
            orderNumber: 1,
            total: 1,
            status: 1,
            createdAt: 1
        })
        .sort({ createdAt: 1 })
        .limit(20);
        
        const now = new Date();
        await chromeNotificationController.updateAdminLastChecked(userId, now);
        
        const safeOrders = orders.map(order => {
            const o = order.toObject();
            return {
                _id: o._id,
                orderNumber: o.orderNumber,
                total: o.total,
                status: o.status,
                createdAt: o.createdAt
            };
        });
        
        res.json({
            success: true,
            lastChecked: now,
            orders: safeOrders,
            count: safeOrders.length
        });
        
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to check for new orders" });
    }
});

// POST /api/admin/chrome-notifications/send - Send Chrome notification manually (for testing)
router.post("/send", protect, admin, async (req, res) => {
    try {
        const { title, body, data } = req.body;
        const result = await chromeNotificationController.sendChromeNotificationToAdmins(
            title,
            body,
            data || {}
        );
        res.json({
            success: true,
            ...result
        });
    } catch (error) {
        res.status(500).json({ success: false, message: "Failed to send Chrome notification" });
    }
});

module.exports = router;