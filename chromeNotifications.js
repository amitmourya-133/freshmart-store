// ===============================
// CHROME DESKTOP NOTIFICATIONS MANAGEMENT
// Frontend management of Chrome desktop notifications for FreshMart admin
// ===============================

const ChromeNotifications = (function () {
    "use strict";
    
    let notificationPermission = "default";
    let isPolling = false;
    let pollingInterval = null;
    let initialized = false;
    const seenOrderIds = new Set();
    let adminPrefs = {
        enabled: false,
        soundEnabled: true,
        isAdmin: false
    };
    
    // ===============================
    // INITIALIZATION
    // ===============================
    
    async function init() {
        if (initialized) return true;
        // Check if Chrome notifications are supported
        if (!("Notification" in window)) {
            console.warn("[chrome-notifications] Chrome notifications not supported");
            return false;
        }
        
        // Get current permission
        notificationPermission = Notification.permission;
        
        // Load admin preferences
        await loadAdminPrefs();
        
        // Setup polling for new orders
        setupPolling();
        
        // Setup notification click handler
        setupNotificationClickHandler();
        
        initialized = true;
        return true;
    }
    
    // ===============================
    // ADMIN PREFERENCES MANAGEMENT
    // ===============================
    
    async function loadAdminPrefs() {
        try {
            const response = await fetch("/api/admin/chrome-notifications/prefs", {
                method: "GET",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" }
            });
            
            if (!response.ok) {
                console.warn("[chrome-notifications] failed to load preferences");
                return;
            }
            
            const data = await response.json();
            if (data.success) {
                adminPrefs = {
                    enabled: Boolean(data.enabled),
                    soundEnabled: Boolean(data.soundEnabled),
                    isAdmin: Boolean(data.isAdmin)
                };
            }
        } catch (error) {
            console.warn("[chrome-notifications] failed to load admin prefs:", error.message);
        }
    }
    
    async function updateAdminPrefs(enabled, soundEnabled) {
        try {
            const response = await fetch("/api/admin/chrome-notifications/prefs", {
                method: "PUT",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    enabled: enabled,
                    soundEnabled: soundEnabled
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                if (data.success) {
                    adminPrefs.enabled = enabled;
                    adminPrefs.soundEnabled = soundEnabled;
                    return true;
                }
            }
            
            return false;
        } catch (error) {
            console.warn("[chrome-notifications] failed to update admin prefs:", error.message);
            return false;
        }
    }
    
    // ===============================
    // NOTIFICATION PERMISSION
    // ===============================
    
    async function requestNotificationPermission() {
        if (!("Notification" in window)) return false;
        if (typeof Notification.requestPermission !== "function") return false;
        
        try {
            const permission = await Notification.requestPermission();
            notificationPermission = permission;
            
            if (permission === "granted") {
                return true;
            } else if (permission === "denied") {
                console.warn("[chrome-notifications] notification permission denied");
                return false;
            }
            
            return false;
        } catch (error) {
            console.warn("[chrome-notifications] permission request failed:", error.message);
            return false;
        }
    }
    
    function getNotificationStatus() {
        if ("Notification" in window) {
            notificationPermission = Notification.permission;
        }
        const supported = "Notification" in window;
        return {
            supported: supported,
            permission: notificationPermission,
            enabled: supported && adminPrefs.enabled && notificationPermission === "granted",
            preferenceEnabled: adminPrefs.enabled,
            soundEnabled: adminPrefs.soundEnabled,
            isAdmin: adminPrefs.isAdmin
        };
    }
    
    // ===============================
    // POLLING FOR NEW ORDERS
    // ===============================
    
    function setupPolling() {
        // Always install the 15s loop; pollForNewOrders guards on isAdmin/enabled.
        if (pollingInterval) return;
        pollingInterval = setInterval(async () => {
            await pollForNewOrders();
        }, 15000);
        setTimeout(async () => {
            await pollForNewOrders();
        }, 1000);
    }
    
    async function pollForNewOrders() {
        if (!adminPrefs.enabled || !adminPrefs.isAdmin) {
            return;
        }
        
        if (isPolling) return;
        isPolling = true;
        
        try {
            const response = await fetch("/api/admin/chrome-notifications/check", {
                method: "POST",
                credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({})
            });
            
            if (!response.ok) {
                console.warn("[chrome-notifications] polling request failed:", response.status);
                return;
            }
            
            const data = await response.json();
            if (!data.success) {
                console.warn("[chrome-notifications] polling API error:", data.message);
                return;
            }
            
            // Process new orders
            if (data.orders && data.orders.length > 0) {
                for (const order of data.orders) {
                    await handleNewOrder(order);
                }
            }
            
        } catch (error) {
            console.warn("[chrome-notifications] polling failed:", error.message);
        } finally {
            isPolling = false;
        }
    }
    
    async function handleNewOrder(order) {
        if (!adminPrefs.enabled) return;
        if (!order || !order._id) return;
        if (seenOrderIds.has(String(order._id))) return;
        seenOrderIds.add(String(order._id));
        
        const title = "🔔 FreshMart — New Order Received!";
        const body = "Order: #" + order.orderNumber + "\nAmount: ₹" + order.total + "\nStatus: " + order.status;
        
        if (!("Notification" in window) || Notification.permission !== "granted") return;
        
        const icon = "/images/Jackfruit.png";
        
        const showViaSW = async function () {
            if ("serviceWorker" in navigator) {
                try {
                    const readyPromise = navigator.serviceWorker.ready;
                    const timeoutPromise = new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 1500); });
                    const reg = await Promise.race([readyPromise, timeoutPromise]);
                    if (reg && typeof reg.showNotification === "function") {
                        await reg.showNotification(title, {
                            body: body,
                            icon: icon,
                            badge: icon,
                            tag: "freshmart-order-" + order._id,
                            requireInteraction: true,
                            silent: !adminPrefs.soundEnabled,
                            data: { url: "/admin.html" }
                        });
                        return true;
                    }
                } catch (e) {
                    console.warn("[chrome-notifications] SW showNotification failed:", e && e.message);
                }
            }
            return false;
        };
        
        const shown = await showViaSW();
        if (!shown) {
            try {
                const notification = new Notification(title, {
                    body: body,
                    icon: icon,
                    badge: icon,
                    tag: "freshmart-order-" + order._id,
                    requireInteraction: true,
                    silent: !adminPrefs.soundEnabled
                });
                notification.onclick = function () {
                    window.location.href = "/admin.html";
                };
            } catch (e) {
                console.warn("[chrome-notifications] Notification constructor failed:", e && e.message);
            }
        }
        
        console.log("[chrome-notifications] new order notification:", title, body);
    }
    
    // ===============================
    // NOTIFICATION CLICK HANDLING
    // ===============================
    
    function setupNotificationClickHandler() {
        // Click handling is done via the service worker notificationclick
        // event for SW-based notifications and via notification.onclick for
        // the direct Notification constructor. Nothing to register here.
    }
    
    // (updateLastChecked removed: it advanced the polling baseline on focus
    //  without surfacing orders, causing missed notifications.)
    
    // ===============================
    // PUBLIC API
    // ===============================
    
    return {
        init,
        getNotificationStatus,
        requestNotificationPermission,
        updateAdminPrefs,
        sendTestNotification,
        destroy
    };
    
    // ===============================
    // UTILITY FUNCTIONS
    // ===============================
    
    async function sendTestNotification() {
        if (!adminPrefs.enabled) {
            console.warn("[chrome-notifications] notifications disabled");
            return false;
        }
        
        const title = "🔔 FreshMart — Test Notification";
        const body = "Chrome desktop notifications are working!";
        
        const notification = new Notification(title, {
            body: body,
            icon: "/images/Jackfruit.png",
            badge: "/images/Jackfruit.png",
            tag: "freshmart-test-" + Date.now(),
            requireInteraction: true,
            silent: !adminPrefs.soundEnabled
        });
        
        notification.onclick = () => {
            window.location.href = "/admin.html";
        };
        
        return true;
    }
    
    function destroy() {
        if (pollingInterval) {
            clearInterval(pollingInterval);
            pollingInterval = null;
        }
    }
})();

// ===============================
// AUTO-INITIALIZATION
// ===============================

// Auto-initialize when DOM is ready
if (document.readyState === "complete" || document.readyState === "interactive") {
    ChromeNotifications.init();
} else {
    document.addEventListener("DOMContentLoaded", function () {
        ChromeNotifications.init();
    });
}

// Export for external use
if (typeof module !== "undefined" && module.exports) {
    module.exports = ChromeNotifications;
} else {
    window.ChromeNotifications = ChromeNotifications;
}