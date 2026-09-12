// ===============================
// USER / AUTH CONTROLLER
// ===============================

const User = require("../models/User");
const Order = require("../models/Order");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");

// Generate JWT token
function generateToken(id) {
    return jwt.sign({ id }, process.env.JWT_SECRET, {
        expiresIn: "7d"
    });
}

// SIGNUP (email + password)
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
            token: generateToken(user._id),
            data: { _id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role }
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// LOGIN (email + password)
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

// SEND OTP
exports.sendOTP = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ success: false, message: "Email required" });
        }

        // Generate 6 digit OTP
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpiry = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

        let user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            user = new User({ email: email.toLowerCase(), name: email.split("@")[0] });
        }

        user.otp = otp;
        user.otpExpiry = otpExpiry;
        await user.save();

        // Send email if configured
        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: {
                    user: process.env.EMAIL_USER,
                    pass: process.env.EMAIL_PASS
                }
            });
            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: email,
                subject: "FreshMart - Your OTP Code",
                html: `
                    <div style="font-family:Arial,sans-serif;max-width:500px;margin:auto;padding:20px;border:1px solid #ddd;border-radius:10px;">
                        <h2 style="color:#159447;">🥬 FreshMart</h2>
                        <p>Your One-Time Password (OTP) is:</p>
                        <div style="font-size:32px;font-weight:bold;color:#159447;background:#eaffef;padding:15px;text-align:center;border-radius:8px;">
                            ${otp}
                        </div>
                        <p>This code is valid for 10 minutes.</p>
                    </div>
                `
            });
        }

        // In development/demo, send OTP in response so you can test.
        // NEVER expose the OTP in production.
        const dev = (process.env.NODE_ENV !== "production");
        res.json({
            success: true,
            message: "OTP sent",
            ...(dev ? { devOTP: otp } : {})
        });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// VERIFY OTP & LOGIN
exports.verifyOTP = async (req, res) => {
    try {
        const { email, otp } = req.body;

        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user) {
            return res.status(400).json({ success: false, message: "No account found" });
        }

        if (!user.otp || user.otp !== otp) {
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }

        if (!user.otpExpiry || new Date(user.otpExpiry) < new Date()) {
            return res.status(400).json({ success: false, message: "OTP has expired. Please request a new one." });
        }

        // Clear OTP
        user.otp = undefined;
        user.otpExpiry = undefined;
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
