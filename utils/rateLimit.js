// ===============================
// LIGHTWEIGHT IN-MEMORY RATE LIMITER
// ===============================

const buckets = new Map();

function keyFrom(req) {
    return (req.headers["x-forwarded-for"] || req.ip || "unknown").replace(/^.*?:\*\*|\s/g, "") + "|" + (req.route ? req.route.path : req.originalUrl);
}

// Simple sliding-window limiter. Soft guard against brute-force / OTP spam.
// (In-memory only: resets on process restart; on Vercel it is best-effort.)
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