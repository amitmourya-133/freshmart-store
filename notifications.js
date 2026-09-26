// ===============================
// NOTIFICATIONS PAGE (R14)
// Cookie-authed, owner-scoped /api/notifications.
// ===============================

function notificationIcon(type) {
    var map = {
        order_status: "📦",
        delivery_assignment: "🛵",
        low_stock: "⚠️",
        subscription: "📅",
        payment: "💳",
        review: "⭐",
        system: "ℹ️"
    };
    return map[type] || "ℹ️";
}

function formatNotifDate(iso) {
    if (!iso) return "";
    try {
        var d = new Date(iso);
        var now = new Date();
        var diff = (now.getTime() - d.getTime()) / 1000;
        if (diff < 60) return "just now";
        if (diff < 3600) return Math.floor(diff / 60) + " min ago";
        if (diff < 86400) return Math.floor(diff / 3600) + " hr ago";
        return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (e) { return ""; }
}

function loadNotifications() {
    var container = document.getElementById("notificationsContainer");
    if (!container) return;

    container.innerHTML = '<p style="text-align:center;">Loading notifications...</p>';

    apiFetchNotifications({ limit: 60 }).then(function(res) {
        var list = res.data || [];
        var unread = Number(res.unreadCount) || 0;
        var summary = document.getElementById("notifSummary");
        if (summary) summary.textContent = list.length + " notification(s) · " + unread + " unread";

        var markAllBtn = document.getElementById("markAllBtn");
        if (markAllBtn) markAllBtn.disabled = unread === 0;

        if (list.length === 0) {
            container.innerHTML = '<div class="empty-orders"><div class="empty-orders-icon">🔕</div><h2>No notifications yet</h2><p>Order updates, delivery alerts and low-stock warnings will appear here.</p></div>';
            return;
        }

        container.innerHTML = list.map(function(n) {
            var unreadCls = n.read ? " fm-notif-read" : "";
            var link = n.data && n.data.link
                ? '<button type="button" class="secondary-btn" onclick="window.location.href=\'' + jsStr(n.data.link) + '\'">View</button>'
                : "";
            var markBtn = n.read ? "" : '<button type="button" class="secondary-btn" onclick="markReadFromPage(\'' + jsStr(n._id) + '\')">Mark read</button>';
            return '<div class="order-card fm-notif-card' + unreadCls + '">' +
                '<div style="display:flex;justify-content:space-between;gap:10px;align-items:flex-start;">' +
                    '<div><div style="font-weight:600;">' + notificationIcon(n.type) + ' ' + escHtml(n.title) + '</div>' +
                    '<small style="color:var(--text-secondary);">' + escHtml(formatNotifDate(n.createdAt)) + '</small></div>' +
                    (n.read ? '<span style="color:#8a8a8a;font-size:12px;">read</span>' : '') +
                '</div>' +
                (n.message ? '<p style="margin:8px 0;">' + escHtml(n.message) + '</p>' : '') +
                (link || markBtn ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">' + link + markBtn + '</div>' : '') +
                '</div>';
        }).join("");
    }).catch(function(err) {
        container.innerHTML = '<div class="empty-orders"><div class="empty-orders-icon">⚠️</div><h2>Could not load notifications</h2><p>' + escHtml((err && err.message) || "Please try again.") + '</p></div>';
    });
}

function markReadFromPage(id) {
    if (!id) return;
    apiMarkNotificationRead(id).then(function() {
        loadNotifications();
        updateNotifBadge();
    }).catch(function(err) {
        if (typeof showToast === "function") showToast((err && err.message) || "Could not update notification.", "error");
    });
}

function markAllReadFromPage() {
    apiMarkAllNotificationsRead().then(function() {
        loadNotifications();
        updateNotifBadge();
        if (typeof showToast === "function") showToast("All notifications marked as read.", "success");
    }).catch(function(err) {
        if (typeof showToast === "function") showToast((err && err.message) || "Could not update notifications.", "error");
    });
}