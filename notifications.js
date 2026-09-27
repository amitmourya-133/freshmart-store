// ===============================
// PUSH NOTIFICATION SUBSCRIPTION (frontend)
// Subscribes the user to Web Push notifications via the VAPID public key.
// ===============================

const PushNotifications = (function () {
    "use strict";

    let swRegistration = null;

    async function init() {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
            return false;
        }
        try {
            swRegistration = await navigator.serviceWorker.ready;
            return true;
        } catch (e) {
            return false;
        }
    }

    async function getSubscription() {
        if (!swRegistration) await init();
        if (!swRegistration) return null;
        return swRegistration.pushManager.getSubscription();
    }

    async function subscribe() {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
            return { ok: false, error: "unsupported" };
        }
        try {
            swRegistration = await navigator.serviceWorker.ready;
            const perm = await Notification.requestPermission();
            if (perm !== "granted") {
                return { ok: false, error: "denied" };
            }

            let sub = await swRegistration.pushManager.getSubscription();
            if (!sub) {
                const keyRes = await fetch("/api/notifications/vapid-key");
                const keyData = await keyRes.json();
                if (!keyData.publicKey) return { ok: false, error: "no_key" };

                const appKey = urlBase64ToUint8Array(keyData.publicKey);
                sub = await swRegistration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: appKey
                });
            }

            const res = await fetch("/api/notifications/subscribe", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ subscription: sub.toJSON() })
            });
            const data = await res.json();
            return { ok: data.success === true, error: data.error };
        } catch (e) {
            return { ok: false, error: (e && e.message) || "error" };
        }
    }

    async function unsubscribe() {
        try {
            swRegistration = await navigator.serviceWorker.ready;
            const sub = await swRegistration.pushManager.getSubscription();
            if (sub) {
                await fetch("/api/notifications/unsubscribe", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ endpoint: sub.endpoint })
                });
                await sub.unsubscribe();
            }
            return { ok: true };
        } catch (e) {
            return { ok: false, error: (e && e.message) || "error" };
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
        const base64 = (base64String + padding).replace(/\-/g, "+").replace(/_/g, "/");
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    // Auto-subscribe on login when permission is already granted.
    async function autoSubscribeIfPossible() {
        if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
        if (Notification.permission !== "granted") return;
        try {
            const sub = await getSubscription();
            if (!sub) await subscribe();
        } catch (e) { /* silent */ }
    }

    return { init, subscribe, unsubscribe, autoSubscribeIfPossible, getSubscription };
})();

if (typeof module !== "undefined" && module.exports) module.exports = PushNotifications;
