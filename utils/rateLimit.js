// ===============================
// LIGHTWEIGHT IN-MEMORY RATE LIMITER
// ===============================

const buckets = new Map();

// Client identifier for rate limiting. Express's req.ip already uses the
// X-Forwarded-For chain correctly when `trust proxy` is on, so we MUST NOT
// trust a raw X-Forwarded-For header here — on any host without a trusted
// proxy in front, a client could otherwise spoof the header and reset its own
// bucket (`req.headers["x-forwarded-for"]` is attacker-controlled input).
function keyFrom(req) {
    const ip = String(req.ip || (req.socket && req.socket.remoteAddress) || "unknown").replace(/^.*?:\*\*|\s/g, "");
    return ip + "|" + (req.route ? req.route.path : req.originalUrl);
}

// Simple sliding-window limiter. Soft guard against brute-force / OTP spam.
// (In-memory only: resets on process restart; on Vercel it is best-effort —
// each serverless instance keeps its own bucket, so a determined attacker with
// many real IPs can exceed the limit, but per-IP abuse is still bounded.)
function rateLimit({ windowMs = 10 * 60 * 1000, max = 30 } = {}) {
    return function (req, res, next) {
        const key = keyFrom(req);
        const now = Date.now();
        let hits = buckets.get(key) || [];
        hits = hits.filter(function (t) { return now - t < windowMs; });

        if (hits.length >= max) {
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

module.exports = { rateLimit };