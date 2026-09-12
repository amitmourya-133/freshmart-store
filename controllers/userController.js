// ===============================
// USER / AUTH CONTROLLER
// ===============================

const User = require("../models/User");
const Order = require("../models/Order");
const jwt = require("jsonwebtoken");
const emailService = require("../utils/emailService");
const {
    OTP_TTL_MS,
    OTP_MAX_ATTEMPTS,
    OTP_RESEND_COOLDOWN_MS,
    generateOtp,
    hashOtp,
    otpMatches,
    isOtpExpired
} = require("../utils/otp");

// Generate JWT token
function generateToken(id) {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}

// Generate a fresh OTP for a user, persist ONLY its hash, and email it.
// A new OTP always invalidates the previous one (overwrite + attempts reset).
async function issueOtpToUser(user) {
    const otp = generateOtp();
    user.otpHash = hashOtp(otp);
    user.otpExpiry = new Date(Date.now() + OTP_TTL_MS);
    user.otpAttempts = 0;
    user.otpResendAt = new Date();
    await user.save();

    const html = `
        <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:10px;">
            <h2 style="color:#159447;">🥬 FreshMart</h2>
            <p>Your One-Time Password (OTP) is:</p>
            <div style="font-size:32px;font-weight:bold;color:#159447;background:#eaffef;padding:15px;text-align:center;border-radius:8px;letter-spacing:6px;">
                ${otp}
            </div>
            <p>This code is valid for 5 minutes and can be used once.</p>
            <p style="color:#888;font-size:12px;">If you did not request this code, you can ignore this email.</p>
        </div>`;

    // Email through the envelope (never logs, never echoes the OTP back).
    const delivery = await emailService.sendMail({
        to: user.email,
        subject: "FreshMart - Your OTP Code",
        html: html
    });
    return delivery.sent;
}

// SIGNUP (email + password) — creates the account and immediately sends an OTP.
// NO authenticated session is issued until the OTP is verified.
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

        let sent = false;
        try {
            sent = await issueOtpToUser(user);
        } catch (e) {
            // OTP delivery failure must not leak the code; the account exists
            // and the customer can request a fresh OTP from the login screen.
        }

        res.status(201).json({
            success: true,
            message: "Account created. Enter the 6-digit OTP sent to your email to finish.",
            email: user.email,
            otpRequired: true,
            emailSent: sent
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// LOGIN (email + password) — credential check only.
// No session/token is issued: the OTP step must follow.
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
            message: "Credentials verified. Enter the OTP sent to your email.",
            email: user.email,
            otpRequired: true
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET CURRENT USER
exports.getMe = async (req, res) => {
    res.json({ success: true, data: req.user });
};

// SEND OTP
// purpose "login" (default): requires the account to exist AND the password
// to match — a wrong credential prevents the OTP from being sent.
// purpose "signup": used right after account creation.
exports.sendOTP = async (req, res) => {
    try {
        const { email, password, purpose } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email required" });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ success: false, message: "No account found. Please create an account first." });
        }

        // Purpose "signup" — the account was just created; credentials are already proven.
        // Any other purpose requires a password check so OTPs are only sent to real owners.
        if (purpose !== "signup") {
            if (!password) {
                return res.status(400).json({ success: false, message: "Password required" });
            }
            const isMatch = await user.matchPassword(password);
            if (!isMatch) {
                return res.status(400).json({ success: false, message: "Invalid email or password" });
            }
        }

        // 60-second resend cooldown
        if (user.otpResendAt) {
            const elapsed = Date.now() - new Date(user.otpResendAt).getTime();
            if (elapsed < OTP_RESEND_COOLDOWN_MS) {
                const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - elapsed) / 1000);
                return res.status(429).json({
                    success: false,
                    message: `Please wait ${wait}s before requesting a new OTP.`
                });
            }
        }

        const sent = await issueOtpToUser(user);

        // The OTP itself is NEVER returned or logged.
        res.json({
            success: true,
            message: "OTP sent to your email.",
            email: user.email,
            otpRequired: true,
            emailSent: sent
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// VERIFY OTP & LOGIN
// Single-use OTP; max 5 attempts; 5-minute expiry; only the hash is stored.
exports.verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) {
            return res.status(400).json({ success: false, message: "Email and OTP required" });
        }

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ success: false, message: "No account found" });
        }

        if (!user.otpHash) {
            return res.status(400).json({ success: false, message: "No OTP requested. Please request a new code." });
        }

        if (isOtpExpired(user.otpExpiry)) {
            // Expired OTPs are invalidated immediately and can never be used.
            user.otpHash = undefined;
            user.otpExpiry = undefined;
            user.otpAttempts = 0;
            await user.save();
            return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
        }

        if (user.otpAttempts >= OTP_MAX_ATTEMPTS) {
            // Attempt limit exhausted: the code is burned and a new one is required.
            user.otpHash = undefined;
            user.otpExpiry = undefined;
            user.otpAttempts = 0;
            await user.save();
            return res.status(400).json({ success: false, message: "Too many failed attempts. Please request a new OTP." });
        }

        if (!otpMatches(otp, user.otpHash)) {
            user.otpAttempts = (user.otpAttempts || 0) + 1;
            const burned = user.otpAttempts >= OTP_MAX_ATTEMPTS;
            if (burned) {
                user.otpHash = undefined;
                user.otpExpiry = undefined;
                user.otpAttempts = 0;
            }
            await user.save();
            return res.status(400).json({
                success: false,
                message: burned ? "Too many failed attempts. Please request a new OTP." : "Invalid OTP"
            });
        }

        // Success: single-use, wipe everything OTP-related before issuing the session.
        user.otpHash = undefined;
        user.otpExpiry = undefined;
        user.otpAttempts = 0;
        await user.save();

        res.json({
            success: true,
            token: generateToken(user._id),
            data: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role, isAdmin: user.isAdmin }
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GOOGLE LOGIN (demo - sign with google, actual OAuth needs client redirect/keys)
exports.googleLogin = async (req, res) => {
    try {
        const { email, name, googleId } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email required" });
        }

        let user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {
            user = await User.create({
                name: name || email.split("@")[0],
                email: email.toLowerCase(),
                googleId: googleId || "google-" + email
            });
        }

        res.json({
            success: true,
            token: generateToken(user._id),
            data: { _id: user._id, name: user.name, email: user.email, role: user.role, isAdmin: user.isAdmin }
        });
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

        // Per-customer order counts so the admin Customer list shows order history
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
