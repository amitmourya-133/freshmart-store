// ===============================
// AUTH MIDDLEWARE
// ===============================

const jwt = require("jsonwebtoken");
const User = require("../models/User");

// Token source: Authorization: Bearer header first (API clients, older
// sessions), then the httpOnly session cookie set at login (XSS-immune).
function readToken(req) {
    if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer")
    ) {
        return req.headers.authorization.split(" ")[1];
    }
    if (req.cookies && req.cookies.freshmart_token) {
        return req.cookies.freshmart_token;
    }
    return null;
}

// AUD-19: pin the JWT to the user's credential version. A token minted before
// the account's password was last changed is treated as invalid, so a leaked
// or stolen old token dies the moment the password changes.
function pinOk(decoded, user) {
    if (!user || !user.pwdChangedAt || !decoded || typeof decoded.iat !== "number") {
        return true;
    }
    const changedAtSec = Math.floor(new Date(user.pwdChangedAt).getTime() / 1000);
    return decoded.iat >= changedAtSec;
}

exports.protect = async (req, res, next) => {
    const token = readToken(req);

    if (!token) {
        return res.status(401).json({
            success: false,
            message: "Not authorized, no token"
        });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = await User.findById(decoded.id).select("-password -otpHash -otpExpiry -otpAttempts -otpResendAt -resetOtpHash -resetOtpExpiry -resetOtpAttempts -resetOtpResendAt -resetTokenHash -resetTokenExpiry");
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: "User not found"
            });
        }
        if (!pinOk(decoded, req.user)) {
            return res.status(401).json({
                success: false,
                message: "Not authorized, session expired. Please sign in again."
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

// Optional auth: attaches req.user when a valid token (header or cookie) is
// present, but never blocks the request (guest checkout stays public). A token
// whose pin is stale is treated the same as no token (AUD-19).
exports.optionalProtect = async (req, res, next) => {
    const token = readToken(req);
    if (!token) {
        return next();
    }
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select("-password -otpHash -otpExpiry -otpAttempts -otpResendAt -resetOtpHash -resetOtpExpiry -resetOtpAttempts -resetOtpResendAt -resetTokenHash -resetTokenExpiry");
        if (user && pinOk(decoded, user)) {
            req.user = user;
        }
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

exports.delivery = (req, res, next) => {
    // Only users with role "delivery" may proceed.
    if (req.user && req.user.role === "delivery") {
        next();
    } else {
        res.status(403).json({
            success: false,
            message: "Delivery partner access only"
        });
    }
};
