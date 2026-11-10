// ===============================
// CHROME DESKTOP NOTIFICATION CONTROLLER
// Handles Chrome-specific desktop notifications for admins
// ===============================

const Notification = require("../models/Notification");
const { safeErrorMessage } = require("../utils/safeError");

// Admin notification preferences stored in user profile
// We'll use the user model to track admin notification preferences
const User = require("../models/User");

// Send Chrome desktop notification to a specific admin
async function sendChromeNotification(userId, title, body, data = {}) {
    if (!userId || !title || !body) return;
    
    try {
        // Check if this admin has Chrome notifications enabled
        const user = await User.findById(userId);
        if (!user || !user.chromeNotificationsEnabled) {
            return;
        }
        
        // Only send notification if permission is granted
        if (typeof Notification !== "undefined" && Notification.permission !== "granted") {
            return;
        }
        
        // Create the notification
        const notificationOptions = {
            body: body,
            icon: "/images/Jackfruit.png", // Use existing FreshMart logo
            badge: "/images/Jackfruit.png",
            tag: `freshmart-order-${data.orderId || Date.now()}`, // Prevent duplicates
            data: {
                orderId: data.orderId,
                orderNumber: data.orderNumber,
                total: data.total,
                url: data.url || "/admin.html"
            },
            requireInteraction: true,
            silent: !(data.soundEnabled !== false) // Use sound unless explicitly disabled
        };
        
        const notification = new Notification(title, notificationOptions);
        
        // Handle notification click
        notification.onclick = (event) => {
            event.preventDefault();
            if (event.notification && event.notification.data && event.notification.data.url) {
                window.location.href = event.notification.data.url;
            }
        };
        
        // Log for audit (non-sensitive)
        await Notification.create({
            user: userId,
            type: "chrome_desktop",
            title: title,
            message: body,
            data: notificationOptions.data
        });
        
        return { sent: true, notificationId: notification.tag };
        
    } catch (error) {
        // Non-fatal error - Chrome notifications shouldn't break order creation
        console.warn("[chrome-notification] failed to send:", error.message);
        return { sent: false, error: error.message };
    }
}

// Send Chrome notification to all admins
async function sendChromeNotificationToAdmins(title, body, data = {}) {
    try {
        const admins = await User.find({ role: "admin" }).select("_id").lean();
        const results = [];
        
        for (const admin of admins) {
            const result = await sendChromeNotification(admin._id, title, body, data);
            results.push(result);
        }
        
        return {
            sent: results.filter(r => r && r.sent).length,
            total: results.length,
            errors: results.filter(r => r && !r.sent).length
        };
        
    } catch (error) {
        console.warn("[chrome-notification] bulk send failed:", error.message);
        return { sent: 0, total: 0, errors: 1, error: error.message };
    }
}

// Update admin notification preferences
async function updateChromeNotificationPrefs(userId, enabled, soundEnabled = true) {
    try {
        const user = await User.findById(userId);
        if (!user) {
            return { success: false, message: "Admin not found" };
        }
        
        user.chromeNotificationsEnabled = Boolean(enabled);
        user.chromeNotificationSound = Boolean(soundEnabled);
        // Establish a safe baseline when enabling so old orders aren't reported.
        if (Boolean(enabled)) {
            user.lastOrderCheck = new Date();
        }
        await user.save();
        
        return { success: true };
        
    } catch (error) {
        return { success: false, message: safeErrorMessage(error) };
    }
}

// Get admin notification preferences
async function getChromeNotificationPrefs(userId) {
    try {
        const user = await User.findById(userId).select("chromeNotificationsEnabled chromeNotificationSound role");
        if (!user) {
            return { success: false, message: "Admin not found" };
        }
        
        return {
            success: true,
            enabled: Boolean(user.chromeNotificationsEnabled),
            soundEnabled: Boolean(user.chromeNotificationSound),
            isAdmin: user.role === "admin"
        };
        
    } catch (error) {
        return { success: false, message: safeErrorMessage(error) };
    }
}

// Get last checked order timestamp for an admin
async function getAdminLastChecked(userId) {
    try {
        const user = await User.findById(userId);
        if (!user) return null;
        
        return user.lastOrderCheck || null;
        
    } catch (error) {
        return null;
    }
}

// Update last checked timestamp
async function updateAdminLastChecked(userId, timestamp) {
    try {
        await User.findByIdAndUpdate(userId, {
            lastOrderCheck: timestamp
        });
        return true;
        
    } catch (error) {
        console.warn("[chrome-notification] failed to update last checked:", error.message);
        return false;
    }
}

module.exports = {
    sendChromeNotification,
    sendChromeNotificationToAdmins,
    updateChromeNotificationPrefs,
    getChromeNotificationPrefs,
    getAdminLastChecked,
    updateAdminLastChecked
};