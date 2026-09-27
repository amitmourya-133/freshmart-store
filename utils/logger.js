// ===============================
// LIGHTWEIGHT STRUCTURED LOGGER
// Emits one-line JSON per event so any log aggregator (Vercel logs, DataDog,
// Papertrail) can parse it. Never logs passwords, OTPs, tokens, cookies,
// secrets, or full authorization headers. Best-effort: a write failure is
// swallowed so logging can never break a request.
// ===============================

const LOG_ENABLED = process.env.LOG_JSON !== "0";

function timestamp() {
    return new Date().toISOString();
}

function emit(level, entry) {
    if (!LOG_ENABLED) return;
    try {
        const line = JSON.stringify(Object.assign({ t: timestamp(), lvl: level }, entry || {}));
        if (level === "error") console.error(line);
        else if (level === "warn") console.warn(line);
        else console.log(line);
    } catch (e) { /* never break on logging */ }
}

module.exports = {
    info: (entry) => emit("info", entry),
    warn: (entry) => emit("warn", entry),
    error: (entry) => emit("error", entry),

    // Per-request middleware: request id (carried from CDN when present,
    // otherwise a short random one), route, status and duration.
    requestLogger: function (req, res, next) {
        const start = Date.now();
        const reqid = req.headers["x-request-id"] || String("r" + Math.random().toString(36).slice(2, 10));
        res.on("finish", function () {
            emit("info", {
                ev: "request",
                reqid: reqid,
                method: req.method,
                route: req.route ? req.route.path : String(req.originalUrl || req.url),
                status: res.statusCode,
                duration: Date.now() - start
            });
        });
        next();
    }
};