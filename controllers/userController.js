// ===============================
// USER / AUTH CONTROLLER
// ===============================

const User = require("../models/User");
const Order = require("../models/Order");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const mongoose = require("mongoose");
const googleAuth = require("../utils/googleAuth");
const { sendOtpEmail } = require("../utils/emailService");

// ---------- OTP / VERIFICATION CONSTANTS ----------
const OTP_TTL_MS = 5 * 60 * 1000;          // OTP valid for 5 minutes
const OTP_MAX_ATTEMPTS = 5;                // max verification attempts per OTP
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;  // resend cooldown of 60 seconds
const RESET_TOKEN_TTL_MS = 10 * 60 * 1000; // hashed reset token valid for 10 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- OTP HELPERS (only hashes are ever stored) ----------

// Cryptographically-random 6-digit OTP (100000 - 999999).
function generateOtp() {
    return String(crypto.randomInt(100000, 1000000));
}

// SHA-256 digest of an OTP / reset token. This is the ONLY thing persisted.
function hashSecret(value) {
    return crypto.createHash("sha256").update(String(value)).digest("hex");
}

// Constant-time comparison of two plain strings (hashes are fixed-length hex).
function safeEqual(a, b) {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function normalizeEmail(email) {
    return String(email || "").trim().toLowerCase();
}

function validEmail(email) {
    return EMAIL_RE.test(String(email || ""));
}

// Generate an OTP for the given field prefix ("otp" or "resetOtp"),
// store only its hash (+ expiry + resend timestamp) and return the plain OTP
// so the caller can email it. Generating a new OTP automatically invalidates
// any previous one (its hash is replaced).
async function issueOtp(user, prefix) {
    const otp = generateOtp();
    const now = Date.now();
    user[prefix + "Hash"] = hashSecret(otp);
    user[prefix + "Expiry"] = new Date(now + OTP_TTL_MS);
    user[prefix + "Attempts"] = 0;
    user[prefix + "ResendAt"] = new Date(now);
    await user.save();
    return otp;
}

// Verify an OTP. Never reveals the correct value; returns a result string:
//   "ok"           verified (fields cleared -> single use)
//   "invalid"      wrong code (attempt counter incremented)
//   "expired"      no active / expired code
//   "max_attempts" attempt limit reached
async function verifyOtp(user, otp, prefix) {
    const attempts = Number(user[prefix + "Attempts"] || 0);
    const storedHash = user[prefix + "Hash"];
    const expiry = user[prefix + "Expiry"];

    if (!storedHash || !expiry || new Date(expiry).getTime() < Date.now()) {
        return "expired";
    }
    if (attempts >= OTP_MAX_ATTEMPTS) {
        return "max_attempts";
    }
    if (!safeEqual(hashSecret(otp), storedHash)) {
        user[prefix + "Attempts"] = attempts + 1;
        await user.save();
        return "invalid";
    }

    // Verified -> single-use: clear every OTP field for this prefix.
    user[prefix + "Hash"] = null;
    user[prefix + "Expiry"] = null;
    user[prefix + "Attempts"] = null;
    user[prefix + "ResendAt"] = null;
    await user.save();
    return "ok";
}

// Enforce the 60-second resend cooldown. Returns remaining seconds when
// cooling down (0 when the user may resend right away).
async function resendCooling(user, prefix) {
    const last = user[prefix + "ResendAt"];
    if (!last) return 0;
    const elapsed = Date.now() - new Date(last).getTime();
    if (elapsed >= OTP_RESEND_COOLDOWN_MS) return 0;
    return Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
}

// Send an OTP email and enforce fail-closed delivery: callers must never
// report an OTP as sent unless Gmail actually accepted it. Only sanitized
// failure codes/reasons are logged - never credentials or OTP values.
async function deliverOtp(user, otp, purpose) {
    let result;
    try {
        result = await sendOtpEmail({ to: user.email, otp: otp, purpose: purpose });
    } catch (err) {
        console.error("[email] OTP send threw (purpose=" + purpose + "): " + ((err && (err.code || err.name)) || "unknown"));
        return false;
    }
    if (!result || result.sent !== true) {
        console.error("[email] OTP send failed (purpose=" + purpose + "): " +
            ((result && (result.reason + (result.code ? "/" + result.code : ""))) || "unknown"));
        return false;
    }
    return true;
}

// Generate JWT token
function generateToken(id) {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}

// Only return the JWT in the response body to explicit API/script clients.
// Browser sessions use the httpOnly cookie, so exposing the token in the body
// would needlessly widen the impact of any future XSS.
function wantsToken(req) {
    return req.get("X-Request-Token") === "1" || String(req.query.token || "").toLowerCase() === "1";
}

// HttpOnly session cookie options. The JWT is delivered in an httpOnly cookie
// so page JS (and therefore any XSS payload) can never read it; `secure` is
// detected per-request (Vercel terminates TLS at the proxy -> x-forwarded-proto
// is https, while local dev runs plain http and would reject a Secure cookie).
function sessionCookieOptions(req) {
    const forwardedProto = req.headers["x-forwarded-proto"];
    const isHttps = forwardedProto ? String(forwardedProto).split(",")[0].trim() === "https" : req.secure;
    return {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: !!isHttps,
        maxAge: 7 * 24 * 60 * 60 * 1000 // 7d - matches JWT expiry
    };
}

// Issue the session as an httpOnly cookie. The JWT is returned in the JSON
// body ONLY when the client explicitly asks for it (wantsToken) - legacy
// API/script clients - never for normal browser sessions.
function setAuthCookie(req, res, userId) {
    res.cookie("freshmart_token", generateToken(userId), sessionCookieOptions(req));
}

// Sanitized public representation of a user (never passwords, OTPs, hashes).
function publicUser(user) {
    return {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        role: user.role,
        isAdmin: user.isAdmin,
        emailVerified: user.emailVerified !== false
    };
}

function validatePassword(pw) {
    return typeof pw === "string" && pw.length >= 6;
}

// ===============================
// SIGNUP (email + password, OTP-verified)
// ===============================
// Step 1 of signup: validate the input, (re)create the NOT-yet-verified
// account, generate a signup OTP and email it. A JWT is NEVER issued here -
// it is only issued after /signup/verify-otp succeeds.
exports.signup = async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        const normalized = normalizeEmail(email);

        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ success: false, message: "Password must be at least 6 characters long." });
        }

        let user = await User.findOne({ email: normalized });

        // Email already belongs to a confirmed account. Respond with the same
        // generic message as a fresh signup (no OTP is delivered in this case)
        // so the endpoint cannot be used to enumerate registered emails.
        if (user && user.emailVerified !== false) {
            return res.status(201).json({
                success: true,
                message: "If an account exists for this email, an OTP has been sent. Please verify your email to complete signup."
            });
        }

        // Either no account yet, or an abandoned unverified signup.
        const createdFresh = !user;
        if (createdFresh) {
            user = await User.create({
                name: name || "",
                email: normalized,
                phone: phone || "",
                password: password,
                emailVerified: false
            });
        } else {
            // Same person retrying signup -> refresh the pending details.
            user.name = name || user.name;
            user.phone = phone !== undefined ? phone : user.phone;
            if (password) user.password = password;
            await user.save();
        }

        const otp = await issueOtp(user, "otp");
        if (!(await deliverOtp(user, otp, "signup"))) {
            // Roll back ONLY the account created in this request so a broken
            // email config never litters the DB. An existing (abandoned,
            // unverified) account is left untouched so the same user can retry.
            if (createdFresh) await User.deleteOne({ _id: user._id });
            return res.status(500).json({ success: false, message: "Unable to send OTP email. Please try again later." });
        }

        res.status(201).json({
            success: true,
            message: "If an account exists for this email, an OTP has been sent. Please verify your email to complete signup."
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// Step 2 of signup: verify the emailed OTP and ONLY THEN issue the session JWT.
exports.signupVerifyOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const normalized = normalizeEmail(email);
        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const user = await User.findOne({ email: normalized });
        if (!user) {
            return res.status(400).json({ success: false, message: "Invalid or expired verification code." });
        }
        if (user.emailVerified !== false) {
            return res.status(400).json({ success: false, message: "This account is already verified. Please log in." });
        }

        const result = await verifyOtp(user, otp, "otp");
        if (result === "ok") {
            user.emailVerified = true;
            await user.save();
            setAuthCookie(req, res, user._id);
            const body = {
                success: true,
                message: "Email verified. Your account is ready!",
                data: publicUser(user)
            };
            if (wantsToken(req)) body.token = generateToken(user._id);
            return res.json(body);
        }
        if (result === "invalid") {
            const attempts = Number(user.otpAttempts || 0);
            const remaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
            return res.status(400).json({ success: false, message: "Incorrect verification code. " + remaining + " attempt(s) left." });
        }
        if (result === "expired") {
            return res.status(400).json({ success: false, message: "This verification code has expired. Request a new one." });
        }
        return res.status(429).json({ success: false, message: "Too many incorrect attempts. Request a new code." });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// Resend a signup OTP (60s cooldown; a new OTP invalidates the previous one).
exports.signupResendOtp = async (req, res) => {
    try {
        const { email } = req.body;
        const normalized = normalizeEmail(email);
        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const user = await User.findOne({ email: normalized });
        if (!user || user.emailVerified !== false) {
            // Generic message - never reveals whether an account exists.
            return res.json({ success: true, message: "If an account exists for this email, an OTP has been sent." });
        }

        const wait = await resendCooling(user, "otp");
        if (wait > 0) {
            return res.status(429).json({ success: false, message: "Please wait " + wait + " seconds before requesting a new code." });
        }

        const otp = await issueOtp(user, "otp");
        if (!(await deliverOtp(user, otp, "signup"))) {
            return res.status(500).json({ success: false, message: "Unable to send OTP email. Please try again later." });
        }

        res.json({ success: true, message: "A new verification code has been sent to your email." });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// ===============================
// LOGIN (email + password)
// ===============================
// Existing users (emailVerified missing/true) log in exactly as before.
// Only brand-new signup accounts that have NOT verified their email are asked
// to verify first - the password is still validated so no enumeration occurs.
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password required" });
        }

        const user = await User.findOne({ email: normalizeEmail(email) });
        if (!user) {
            return res.status(400).json({ success: false, message: "No account found. Please create an account first." });
        }

        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Invalid email or password" });
        }

        if (user.emailVerified === false) {
            return res.status(403).json({
                success: false,
                message: "Please verify your email before logging in. Check your inbox for the OTP.",
                needsVerification: true
            });
        }

        setAuthCookie(req, res, user._id);
        const body = {
            success: true,
            message: "Login successful.",
            data: publicUser(user)
        };
        if (wantsToken(req)) body.token = generateToken(user._id);
        res.json(body);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ===============================
// FORGOT PASSWORD (OTP -> hashed reset token -> new password)
// ===============================

// Step 1: email the user a password-reset OTP. Response is always generic so
// the endpoint cannot be used to discover registered addresses.
exports.forgotPasswordRequest = async (req, res) => {
    try {
        const { email } = req.body;
        const normalized = normalizeEmail(email);
        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const user = await User.findOne({ email: normalized });
        if (user && user.emailVerified !== false) {
            const otp = await issueOtp(user, "resetOtp");
            if (!(await deliverOtp(user, otp, "reset"))) {
                return res.status(500).json({ success: false, message: "Unable to send OTP email. Please try again later." });
            }
        }

        res.json({ success: true, message: "If an account exists for this email, an OTP has been sent." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Step 2: verify the reset OTP and issue a short-lived, single-use reset token
// (only its SHA-256 hash is persisted - see the User model resetTokenHash).
exports.forgotPasswordVerify = async (req, res) => {
    try {
        const { email, otp } = req.body;
        const normalized = normalizeEmail(email);
        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const user = await User.findOne({ email: normalized });
        if (!user) {
            return res.status(400).json({ success: false, message: "Invalid or expired OTP." });
        }

        const result = await verifyOtp(user, otp, "resetOtp");
        if (result === "ok") {
            // Single-use hashed reset token, 10-minute lifetime.
            const rawToken = crypto.randomBytes(32).toString("hex");
            user.resetTokenHash = hashSecret(rawToken);
            user.resetTokenExpiry = new Date(Date.now() + RESET_TOKEN_TTL_MS);
            await user.save();
            return res.json({ success: true, resetToken: rawToken, message: "OTP verified. You can now set a new password." });
        }
        if (result === "invalid") {
            const attempts = Number(user.resetOtpAttempts || 0);
            const remaining = Math.max(0, OTP_MAX_ATTEMPTS - attempts);
            return res.status(400).json({ success: false, message: "Incorrect OTP. " + remaining + " attempt(s) left." });
        }
        if (result === "expired") {
            return res.status(400).json({ success: false, message: "This OTP has expired. Request a new one." });
        }
        return res.status(429).json({ success: false, message: "Too many incorrect attempts. Request a new code." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Resend a password-reset OTP (60s cooldown; generic for unknown addresses).
exports.forgotPasswordResendOtp = async (req, res) => {
    try {
        const { email } = req.body;
        const normalized = normalizeEmail(email);
        if (!validEmail(normalized)) {
            return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }

        const user = await User.findOne({ email: normalized });
        if (!user || user.emailVerified === false) {
            return res.json({ success: true, message: "If an account exists for this email, an OTP has been sent." });
        }

        const wait = await resendCooling(user, "resetOtp");
        if (wait > 0) {
            return res.status(429).json({ success: false, message: "Please wait " + wait + " seconds before requesting a new code." });
        }

        const otp = await issueOtp(user, "resetOtp");
        if (!(await deliverOtp(user, otp, "reset"))) {
            return res.status(500).json({ success: false, message: "Unable to send OTP email. Please try again later." });
        }

        res.json({ success: true, message: "A new OTP has been sent to your email." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// Step 3: validate the hashed reset token, set the new password (bcrypt hash
// is applied by the User model pre-save hook), and invalidate the token.
exports.forgotPasswordReset = async (req, res) => {
    try {
        const { resetToken, newPassword } = req.body;
        if (!resetToken) {
            return res.status(400).json({ success: false, message: "Reset token is required." });
        }
        if (!validatePassword(newPassword)) {
            return res.status(400).json({ success: false, message: "New password must be at least 6 characters long." });
        }

        const user = await User.findOne({ resetTokenHash: hashSecret(resetToken) });
        if (!user || !user.resetTokenExpiry || new Date(user.resetTokenExpiry).getTime() < Date.now()) {
            return res.status(400).json({ success: false, message: "This reset token is invalid or has expired. Please request a new OTP." });
        }

        user.password = newPassword;
        user.resetTokenHash = null;
        user.resetTokenExpiry = null;
        await user.save();

        res.json({ success: true, message: "Your password has been reset. You can now log in with your new password." });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET CURRENT USER
exports.getMe = async (req, res) => {
    res.json({ success: true, data: req.user });
};

// Update profile (name, phone, addresses, password)
// Protected — customer can update their own profile
exports.updateMe = async (req, res) => {
    try {
        const updates = Object.keys(req.body);
        const allowedUpdates = ["name", "phone", "addresses", "password"];
        const isValidUpdate = updates.every((update) => allowedUpdates.includes(update));

        if (!isValidUpdate) {
            return res.status(400).json({
                success: false,
                message: "Invalid updates! Allowed updates: name, phone, addresses, password",
            });
        }

        // Handle password update separately
        if (req.body.password) {
            if (req.body.password.length < 6) {
                return res.status(400).json({
                    success: false,
                    message: "Password must be at least 6 characters",
                });
            }
            // We'll handle password after applying other updates
            // For now, just validate and remember to hash it later
        }

        // Handle address deletion request
        if (req.body.deleteAddressIndex !== undefined) {
            const idx = parseInt(req.body.deleteAddressIndex, 10);
            if (req.user.addresses && req.user.addresses[idx]) {
                req.user.addresses.splice(idx, 1);
            }
        }

        // Handle setting default address
        if (req.body.setDefaultIndex !== undefined) {
            const idx = parseInt(req.body.setDefaultIndex, 10);
            if (req.user.addresses && req.user.addresses[idx]) {
                req.user.addresses.forEach(function(addr, i) {
                    addr.isDefault = (i === idx);
                });
            }
        }

        // Apply allowed updates (excluding password for now - handled separately)
        var passwordToHash = null;
        if (req.body.password && req.body.password.length >= 6) {
            passwordToHash = req.body.password;
            // Remove password from updates list so it's not applied as a string field
            updates = updates.filter(function(u) { return u !== "password"; });
        }

        updates.forEach((update) => (req.user[update] = req.body[update]));

        if (passwordToHash) {
            const salt = await bcrypt.genSalt(10);
            req.user.password = await bcrypt.hash(passwordToHash, salt);
        }

        await req.user.save({ validateBeforeSave: false });

        // Build response - remove sensitive fields
        const userResponse = req.user.toObject();
        delete userResponse.password;
        delete userResponse.otpHash;
        delete userResponse.otpExpiry;
        delete userResponse.otpAttempts;
        delete userResponse.resetOtpHash;
        delete userResponse.resetOtpExpiry;
        delete userResponse.resetOtpAttempts;
        delete userResponse.resetTokenHash;
        delete userResponse.resetTokenExpiry;
        delete userResponse.googleId;

        return res.json({
            success: true,
            message: "Profile updated successfully",
            data: userResponse,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
};

// ===============================
// GOOGLE SIGN-IN (real OAuth 2.0 authorization-code flow)
// Start -> accounts.google.com -> callback with code -> server exchange +
// ID-token verification -> upsert user -> normal session. Never fake/mock.
// ===============================

// Public configuration probe used by the login page BEFORE redirecting.
// Exposes only whether OAuth creds exist — never the values.
exports.googleConfigStatus = async (req, res) => {
    res.json({ success: true, configured: googleAuth.isGoogleConfigured() });
};

// Step 1: build the Google authorization URL and redirect the browser.
// Sets a short-lived HttpOnly state cookie to defeat CSRF on the callback.
exports.googleAuthStart = async (req, res) => {
    if (!googleAuth.isGoogleConfigured()) {
        return res.status(503).json({
            success: false,
            message: "Google Sign-In is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI."
        });
    }
    const state = googleAuth.randomState();
    res.setHeader(
        "Set-Cookie",
        "freshmart_oauth_state=" + state +
        "; Path=/; HttpOnly; SameSite=Lax; Max-Age=300"
    );
    res.redirect(302, googleAuth.buildAuthorizeUrl(state));
};

// Step 2: OAuth callback — receives { code, state } from the browser after
// Google redirects the user back to the app. Exchanges the code for an ID
// token, verifies it (signature/issuer/audience/expiry/email_verified),
// then finds-or-creates the customer and issues the normal JWT session.
// This replaces the old demo googleLogin which trusted a client-supplied email.
exports.googleLogin = async (req, res) => {
    try {
        const { code, state } = req.body || {};

        if (!googleAuth.isGoogleConfigured()) {
            return res.status(503).json({
                success: false,
                message: "Google Sign-In is not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI."
            });
        }
        if (!code || !state) {
            return res.status(400).json({ success: false, message: "Google OAuth parameters missing." });
        }

        // The state must match the one we set in the HttpOnly cookie at start.
        const cookies = String(req.headers.cookie || "");
        const match = /(?:^|;\s*)freshmart_oauth_state=([^;]+)/.exec(cookies);
        const sentState = match ? match[1] : "";
        const okLen = Math.min(Buffer.byteLength(sentState, "utf8"), Buffer.byteLength(String(state), "utf8"));
        const equalLen = okLen === Buffer.byteLength(String(state), "utf8") &&
            Buffer.byteLength(sentState, "utf8") === Buffer.byteLength(String(state), "utf8") &&
            cryptoTimingSafeEqual(String(state), sentState);
        res.setHeader(
            "Set-Cookie",
            "freshmart_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        );
        if (!equalLen) {
            return res.status(400).json({ success: false, message: "Google sign-in failed. Please try again." });
        }

        let idToken;
        try {
            idToken = await googleAuth.exchangeCodeForIdToken(code);
        } catch (e) {
            return res.status(e.status || 400).json({ success: false, message: e.message });
        }

        let claims;
        try {
            claims = await googleAuth.verifyIdToken(idToken, googleAuth.clientId());
        } catch (e) {
            return res.status(e.status || 400).json({ success: false, message: e.message });
        }

        // Find-or-create by googleId; if the email already has an account
        // (created with email+password), link the googleId to it so the same
        // person keeps their history. googleId is unique per Google account.
        let user = await User.findOne({ googleId: claims.sub });
        if (!user) {
            user = await User.findOne({ email: claims.email });
            if (user) {
                user.googleId = claims.sub;
                await user.save();
            } else {
                // Google has already verified this email, so no OTP is needed.
                user = await User.create({
                    name: claims.name || claims.email.split("@")[0],
                    email: claims.email,
                    googleId: claims.sub,
                    password: googleAuth.randomPassword(),
                    emailVerified: true
                });
            }
        }

        setAuthCookie(req, res, user._id);
        const body = {
            success: true,
            data: publicUser(user)
        };
        if (wantsToken(req)) body.token = generateToken(user._id);
        res.json(body);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// LOGOUT: clear the httpOnly session cookie. Works with or without a valid
// token (idempotent); never touches the DB.
exports.logout = (req, res) => {
    res.clearCookie("freshmart_token", {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        secure: req.secure || String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
    });
    res.json({ success: true, message: "Logged out." });
};

function cryptoTimingSafeEqual(a, b) {
    const ab = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

// ORDER HISTORY FOR A SPECIFIC USER (admin only)
// Returns an admin-visible list of a customer's orders (never exposes secrets).
exports.getUserOrders = async (req, res) => {
    try {
        const id = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(String(id || ""))) {
            return res.status(400).json({ success: false, message: "Invalid user id" });
        }
        const user = await User.findById(id).select("name email phone role isAdmin");
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        const orders = await Order.find({ user: id }).sort({ createdAt: -1 }).limit(200);
        res.json({ success: true, count: orders.length, user: user, data: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// LIST ALL USERS (admin only) - never expose passwords / otp
exports.listUsers = async (req, res) => {
    try {
        const { search } = req.query;

        let filter = {};
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
                { phone: { $regex: search, $options: "i" } }
            ];
        }

        const users = await User.find(filter)
            .select("name email phone role isAdmin createdAt")
            .sort({ createdAt: -1 })
            .limit(500);

        // Per-customer order counts so the admin Customer list shows order history.
        const orderAgg = await Order.aggregate([
            { $match: { user: { $ne: null } } },
            { $group: { _id: "$user", count: { $sum: 1 } } }
        ]);
        const countMap = {};
        orderAgg.forEach(function (row) { countMap[String(row._id)] = row.count; });

        const data = users.map(function (u) {
            return {
                _id: u._id,
                name: u.name,
                email: u.email,
                phone: u.phone,
                role: u.role,
                isAdmin: u.isAdmin,
                createdAt: u.createdAt,
                orderCount: countMap[String(u._id)] || 0
            };
        });

        res.json({ success: true, count: data.length, data: data });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};