// ===============================
// LIGHTWEIGHT STRUCTURED LOGGER
// Emits one-line JSON per event so any log aggregator (Vercel logs, DataDog,
// Papertrail) can parse it. Never logs passwords, OTPs, tokens, cookies,
// secrets, or full authorization headers. Best-effort: a write failure is
// swallowed so logging can never break a request.
// ===============================

const LOG_ENABLED = process.env.LOG_JSON !== "0";

// Secret-bearing query parameter names. The password-reset link is
// `/reset-password.html?token=...`, so a single anonymous GET of that page put
// a live account-recovery token into the log stream. Query strings are dropped
// entirely (see safeRoute) and these names are redacted defensively in case a
// caller passes a full URL through another field.
const SECRET_QUERY_KEYS = [
    "token", "resetToken", "reset_token", "access_token", "refresh_token", "id_token",
    "secret", "client_secret", "api_key", "apikey", "password", "pass", "pwd",
    "otp", "code", "signature", "sig", "hash", "auth", "authorization", "session", "jwt"
];

function timestamp() {
    return new Date().toISOString();
}

// Returns the PATH of a URL, never its query string or fragment, and blanks
// out anything that still looks like a credential. Used for every field that
// could carry client-supplied URL material.
function safeRoute(url) {
    let s = String(url == null ? "" : url);
    const cut = s.search(/[?#]/);
    if (cut !== -1) s = s.slice(0, cut);
    if (!s) return s;
    if (s.length > 200) s = s.slice(0, 200) + "...";
    for (let i = 0; i < SECRET_QUERY_KEYS.length; i++) {
        const key = SECRET_QUERY_KEYS[i];
        const re = new RegExp("([?&#;])" + key + "=[^&#;]*", "gi");
        s = s.replace(re, "$1" + key + "=[redacted]");
    }
    return s;
}

// Strips credential-looking keys from an arbitrary object before it is logged.
// Never logs request bodies or headers, so this only guards the few places
// that deliberately attach a small metadata object.
function redact(obj) {
    if (!obj || typeof obj !== "object") return obj;
    const out = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach(function (k) {
        if (SECRET_QUERY_KEYS.indexOf(k) !== -1 || /pass|secret|token|otp|auth/i.test(k)) {
            out[k] = "[redacted]";
        } else if (obj[k] && typeof obj[k] === "object") {
            out[k] = redact(obj[k]);
        } else {
            out[k] = obj[k];
        }
    });
    return out;
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
    redact: redact,
    safeRoute: safeRoute,

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
                // Route TEMPLATE when matched (e.g. "/history"), otherwise the
                // bare path. originalUrl is deliberately never used raw: it
                // carries the query string, which is where the reset-token leak
                // came from. safeRoute strips it again in case a template ever
                // contains one.
                route: safeRoute(req.route ? req.route.path : (req.originalUrl || req.url)),
                status: res.statusCode,
                duration: Date.now() - start
            });
        });
        next();
    }
};