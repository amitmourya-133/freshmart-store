// ===============================
// GOOGLE OAUTH (server-side, env-configured)
// Implements the authorization-code flow: start URL -> code exchange ->
// ID-token verification (RS256, Google JWKS). No secrets are ever hardcoded
// or logged; access/refresh tokens are discarded immediately.
// ===============================

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

let certsCache = { keys: null, fetchedAt: 0 };

function clientId() {
    return process.env.GOOGLE_CLIENT_ID || "";
}

function clientSecret() {
    return process.env.GOOGLE_CLIENT_SECRET || "";
}

function redirectUri() {
    return process.env.GOOGLE_REDIRECT_URI || "";
}

function isGoogleConfigured() {
    return Boolean(clientId() && clientSecret() && redirectUri());
}

function randomState() {
    return crypto.randomBytes(32).toString("hex");
}

// Build the Google authorization URL (the account-selection screen).
function buildAuthorizeUrl(state, redirectUriOverride) {
    const params = new URLSearchParams({
        client_id: clientId(),
        redirect_uri: redirectUriOverride || redirectUri(),
        response_type: "code",
        scope: "openid email profile",
        state: state,
        prompt: "select_account",
        include_granted_scopes: "true"
    });
    return AUTH_URL + "?" + params.toString();
}

// Exchange the one-time authorization code for an ID token.
// Returns the raw id_token; it is verified in verifyIdToken() and never stored.
async function exchangeCodeForIdToken(code, redirectUriOverride) {
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: String(code || ""),
        client_id: clientId(),
        client_secret: clientSecret(),
        redirect_uri: redirectUriOverride || redirectUri()
    });

    let res;
    try {
        res = await fetch(TOKEN_URL, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: body.toString()
        });
    } catch (e) {
        const err = new Error("Google token exchange failed");
        err.status = 502;
        err.code = "google_token_error";
        throw err;
    }
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok || !data.id_token) {
        const err = new Error("Google token exchange failed");
        err.status = 400;
        err.code = "google_token_error";
        throw err;
    }
    return data.id_token;
}

async function fetchCerts() {
    const now = Date.now();
    if (certsCache.keys && now - certsCache.fetchedAt < 5 * 60 * 1000) {
        return certsCache.keys;
    }
    let res;
    try {
        res = await fetch(CERTS_URL);
    } catch (e) {
        const err = new Error("Could not fetch Google signing keys");
        err.status = 502;
        err.code = "google_certs_error";
        throw err;
    }
    if (!res.ok) {
        const err = new Error("Could not fetch Google signing keys");
        err.status = 502;
        err.code = "google_certs_error";
        throw err;
    }
    const data = await res.json().catch(function () { return {}; });
    certsCache = {
        keys: Array.isArray(data.keys) ? data.keys : [],
        fetchedAt: now
    };
    return certsCache.keys;
}

function decodeSegment(segment) {
    const pad = segment.length % 4 === 0 ? "" : "=".repeat(4 - (segment.length % 4));
    const b64 = segment.replace(/-/g, "+").replace(/_/g, "/") + pad;
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}

// Verify the Google ID token: RS256 signature against Google's JWKS,
// issuer + audience + expiry, and email_verified claim. Returns profile claims.
async function verifyIdToken(idToken, expectedAudience) {
    const parts = String(idToken || "").split(".");
    if (parts.length !== 3) {
        const err = new Error("Invalid Google token");
        err.status = 400;
        err.code = "google_invalid_token";
        throw err;
    }

    let header, payload;
    try {
        header = decodeSegment(parts[0]);
        payload = decodeSegment(parts[1]);
    } catch (e) {
        const err = new Error("Invalid Google token");
        err.status = 400;
        err.code = "google_invalid_token";
        throw err;
    }

    if (header.alg && header.alg !== "RS256") {
        const err = new Error("Invalid Google token algorithm");
        err.status = 400;
        err.code = "google_invalid_token";
        throw err;
    }

    const keys = await fetchCerts();
    const cert = keys.find(function (k) {
        return k && k.kid && header.kid && k.kid === header.kid;
    });
    if (!cert || cert.kty !== "RSA" || !cert.n || !cert.e) {
        const err = new Error("Google token key not found");
        err.status = 401;
        err.code = "google_verification_failed";
        throw err;
    }

    let publicKey;
    try {
        publicKey = crypto.createPublicKey({
            key: { kty: cert.kty, n: cert.n, e: cert.e },
            format: "jwk"
        });
    } catch (e) {
        const err = new Error("Google token key not found");
        err.status = 401;
        err.code = "google_verification_failed";
        throw err;
    }

    let decoded;
    try {
        decoded = jwt.verify(idToken, publicKey, {
            algorithms: ["RS256"],
            audience: expectedAudience,
            issuer: GOOGLE_ISSUERS
        });
    } catch (e) {
        const err = new Error("Google token verification failed");
        err.status = 401;
        err.code = "google_verification_failed";
        throw err;
    }

    if (!decoded.sub || !decoded.email || decoded.email_verified !== true) {
        const err = new Error("Google account email is not verified");
        err.status = 400;
        err.code = "google_email_unverified";
        throw err;
    }

    return {
        sub: String(decoded.sub),
        email: String(decoded.email).toLowerCase(),
        name: typeof decoded.name === "string" ? decoded.name : ""
    };
}

// Unusable random password for accounts created purely via Google Sign-In.
// Keeps the schema single-path (password never left null) without storing
// anything a user would ever type.
function randomPassword() {
    return crypto.randomBytes(24).toString("hex");
}

module.exports = {
    isGoogleConfigured,
    randomState,
    buildAuthorizeUrl,
    exchangeCodeForIdToken,
    verifyIdToken,
    randomPassword,
    clientId,
    redirectUri
};