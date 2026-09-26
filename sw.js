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