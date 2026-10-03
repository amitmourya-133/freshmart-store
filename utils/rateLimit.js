// ===============================
// LIGHTWEIGHT IN-MEMORY RATE LIMITER
// ===============================

const buckets = new Map();

// Client identifier for rate limiting. Express's req.ip already uses the
// X-Forwarded-For chain correctly when `trust proxy` is on, so we MUST NOT
// trust a raw X-Forwarded-For header here — on any host without a trusted
// proxy in front, a client could otherwise spoof the header and reset its own
// bucket (`req.headers["x-forwarded-for"]` is attacker-controlled input).
//
// The second half of the key is the ROUTE, not the URL:
//   * `req.route.path` is the matched route template (`/:assignmentId/otp`),
//     which is what we want on a router-level limiter.
//   * `req.baseUrl` is the mount point (`/api/delivery`), so an app-wide
//     limiter produces ONE bucket per IP per API area instead of one bucket per
//     literal URL. Otherwise an attacker evades the global limit simply by
//     varying the path (`/api/products/a`, `/api/products/b`, ...), which is
//     exactly what a "limit per endpoint" limit is supposed to prevent.
function keyFrom(req) {
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^.*?:\*\*|\s/g, "");
    const route = (req.route && req.route.path) ? String(req.route.path) : null;
    const scope = route || (req.baseUrl ? String(req.baseUrl) : "global");
    return ip + "|" + scope;
}

// Simple sliding-window limiter. Soft guard against brute-force / OTP spam.
// (In-memory only: resets on process restart; on Vercel it is best-effort —
// each serverless instance keeps its own bucket, so a determined attacker with
// many real IPs can exceed the limit, but per-IP abuse is still bounded.)
function keyFrom(req) {
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^.*?:\*\*|\s/g, "");
    const route = (req.route && req.route.path) ? String(req.route.path) : null;
    const scope = route || (req.baseUrl ? String(req.baseUrl) : "global");
    return ip + "|" + scope;
}

// Same bucket scope, but keyed on the AUTHENTICATED ACCOUNT when there is one
// (`keyBy: "user"`), falling back to the IP for anonymous traffic.
//
// This matters for any authenticated surface. Delivery partners do not come
// from unique IPs: they run off carrier NAT, office Wi-Fi and shared VPN egress,
// so an entire fleet can share one public address. An IP-keyed write limit is
// then a self-inflicted outage - the first busy partner to trip the bucket gets
// a 429 and every other partner behind that address is collateral damage, with
// no way for them to do anything about it. Keying on the account also stops the
// trivial bypass of rotating source IPs against a logged-in endpoint, and one
// abusive account can no longer exhaust a shared bucket that other users need.
//
// Anonymous requests still fall back to the IP, so unauthenticated endpoints
// (login, coupon lookup, OTP send) keep exactly the protection they had.
function userKeyFrom(req) {
    const id = req.user && (req.user._id || req.user.id);
    if (!id) return keyFrom(req);
    const route = (req.route && req.route.path) ? String(req.route.path) : null;
    const scope = route || (req.baseUrl ? String(req.baseUrl) : "global");
    return "u:" + String(id) + "|" + scope;
}

function rateLimit({ windowMs = 10 * 60 * 1000, max = 30, keyBy = "ip" } = {}) {
    const buildKey = keyBy === "user" ? userKeyFrom : keyFrom;
    return function (req, res, next) {
        const key = buildKey(req);
        const now = Date.now();
        let hits = buckets.get(key) || [];
        hits = hits.filter(function (t) { return now - t < windowMs; });

        if (hits.length >= max) {
            res.setHeader("Retry-After", String(Math.ceil(windowMs / 1000)));
            return res.status(429).json({ success: false, message: "Too many requests. Please try again later." });
        }

        hits.push(now);
        buckets.set(key, hits);

        // Prevent unbounded growth: drop stale buckets occasionally
        if (buckets.size > 10000) {
            for (const [k, times] of buckets) {
                if (times.every(function (t) { return now - t >= windowMs; })) buckets.delete(k);
            }
        }

        next();
    };
}

// Clears every bucket. Exposed for the test suites only; production never
// needs it (restarting the process has the same effect).
function resetBuckets() {
    buckets.clear();
}

module.exports = { rateLimit, resetBuckets, keyFrom, userKeyFrom };