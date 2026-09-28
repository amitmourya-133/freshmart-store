// FreshMart service worker — network-first with cache fallback.
// Never caches /api responses so order/payment data is always fresh.
// Same-origin static assets are cached on successful fetches and used as an
// offline fallback when the network is unavailable.

var CACHE_NAME = "freshmart-v1";

self.addEventListener("install", function (event) {
    self.skipWaiting();
});

self.addEventListener("activate", function (event) {
    event.waitUntil(
        caches.keys().then(function (keys) {
            return Promise.all(
                keys.filter(function (k) { return k !== CACHE_NAME; })
                    .map(function (k) { return caches.delete(k); })
            );
        }).then(function () { return self.clients.claim(); })
    );
});

function isCacheable(request) {
    if (request.method !== "GET") return false;
    var url = new URL(request.url);
    if (url.origin !== self.location.origin) return false;
    if (url.pathname.indexOf("/api/") === 0) return false;
    return true;
}

// Handle push notifications
self.addEventListener("push", function (event) {
    var data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) {}

    event.waitUntil(
        self.registration.showNotification(data.title || "FreshMart", {
            body: data.body || "",
            icon: data.icon || "/jacfruit.png",
            badge: "/jacfruit.png",
            // Same tag => a newer alert replaces the older one instead of
            // stacking a wall of banners on the lock screen.
            tag: data.tag || undefined,
            renotify: Boolean(data.tag),
            // Keeps a delivery offer on screen until it is acted on.
            requireInteraction: Boolean(data.requireInteraction),
            // [200,100,200,100,400] vibration pattern in ms (mobile only,
            // ignored where unsupported).
            vibrate: data.vibrate || undefined,
            // silent:true would suppress the vibration above, so alerts stay
            // audible/vibrating by default. Callers that want a quiet banner
            // send silent:true in the payload.
            silent: Boolean(data.silent),
            timestamp: Date.now(),
            data: { url: data.url || "/index.html" }
        })
    );
});

// Handle notification click
self.addEventListener("notificationclick", function (event) {
    event.notification.close();
    var url = (event.notification.data && event.notification.data.url) || "/index.html";
    event.waitUntil(
        self.clients.matchAll({ type: "window" }).then(function (clientList) {
            for (var i = 0; i < clientList.length; i++) {
                if (clientList[i].url.indexOf(url) !== -1 && "focus" in clientList[i]) {
                    return clientList[i].focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow(url);
            }
        })
    );
});

self.addEventListener("fetch", function (event) {
    var request = event.request;
    if (!isCacheable(request)) return;

    event.respondWith(
        fetch(request)
            .then(function (response) {
                if (response && response.ok) {
                    var copy = response.clone();
                    caches.open(CACHE_NAME).then(function (cache) {
                        cache.put(request, copy);
                    });
                }
                return response;
            })
            .catch(function () {
                return caches.match(request).then(function (cached) {
                    return cached || caches.match("./index.html");
                });
            })
    );
});