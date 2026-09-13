// ===============================
// USER / AUTH CONTROLLER
// ===============================

const User = require("../models/User");
const Order = require("../models/Order");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const mongoose = require("mongoose");
const googleAuth = require("../utils/googleAuth");

// Generate JWT token
function generateToken(id) {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}

// SIGNUP (email + password) — creates the account and lets the user log in
// immediately with email + password. No OTP step, no email dependency.
exports.signup = async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password required" });
        }

        const existingUser = await User.findOne({ email: email.toLowerCase() });
        if (existingUser) {
            return res.status(400).json({ success: false, message: "An account with this email already exists" });
        }

        const user = await User.create({ name, email, phone, password });

        res.status(201).json({
            success: true,
            message: "Account created. You can log in now.",
            email: user.email
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// LOGIN (email + password) — direct credential check, issues the JWT session
// immediately. No OTP step.
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ success: false, message: "Email and password required" });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ success: false, message: "No account found. Please create an account first." });
        }

        const isMatch = await user.matchPassword(password);
        if (!isMatch) {
            return res.status(400).json({ success: false, message: "Invalid email or password" });
        }

        res.json({
            success: true,
            message: "Login successful.",
            token: generateToken(user._id),
            data: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, isAdmin: user.isAdmin }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET CURRENT USER
exports.getMe = async (req, res) => {
    res.json({ success: true, data: req.user });
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
                user = await User.create({
                    name: claims.name || claims.email.split("@")[0],
                    email: claims.email,
                    googleId: claims.sub,
                    password: googleAuth.randomPassword()
                });
            }
        }

        res.json({
            success: true,
            token: generateToken(user._id),
            data: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, isAdmin: user.isAdmin }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
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
