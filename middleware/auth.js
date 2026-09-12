// ===============================
// AUTH MIDDLEWARE
// ===============================

const jwt = require("jsonwebtoken");
const User = require("../models/User");

exports.protect = async (req, res, next) => {
    let token;

    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        token = req.headers.authorization.split(" ")[1];
    }

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "Not authorized, no token"
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select("-password -otpHash -otpExpiry -otpAttempts -otpResendAt");
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "User not found"
            });
        }
        next();
    } catch (error) {
        return res.status(401).json({
            success: false,
            message: "Not authorized, token failed"
        });
    }
};

// Optional auth: attaches req.user when a valid Bearer token is present,
// but never blocks the request (guest checkout stays public).
exports.optionalProtect = async (req, res, next) => {
    let token;
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        token = req.headers.authorization.split(" ")[1];
    }
    if (!token) {
        return next();
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select("-password -otpHash -otpExpiry -otpAttempts -otpResendAt");
    } catch (e) {
        // Tolerate invalid/expired tokens — the request stays anonymous
    }
    next();
};

exports.admin = (req, res, next) => {
    // Strict: only a user with role exactly "admin" may proceed.
    // isAdmin (legacy boolean) is ignored here — role is the single source of truth.
    if (req.user && req.user.role === "admin") {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: "Admin access only"
        });
    }
};
