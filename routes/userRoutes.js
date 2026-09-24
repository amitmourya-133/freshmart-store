// ===============================
// USER ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    signup,
    signupVerifyOtp,
    signupResendOtp,
    login,
    forgotPasswordRequest,
    forgotPasswordVerify,
    forgotPasswordResendOtp,
    forgotPasswordReset,
    getMe,
    updateMe,
    googleConfigStatus,
    googleAuthStart,
    googleLogin,
    listUsers,
    getUserOrders,
    logout
} = require("../controllers/userController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Soft brute-force guard.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// Public
// Signup is OTP-gated: /signup creates an unverified account + emails an OTP,
// /signup/verify-otp issues the JWT (as an httpOnly cookie) only after the OTP
// is confirmed.
router.post("/signup", authLimiter, signup);
router.post("/signup/verify-otp", authLimiter, signupVerifyOtp);
router.post("/signup/resend-otp", authLimiter, signupResendOtp);
router.post("/login", authLimiter, login);
router.post("/logout", logout);

// Password reset (OTP -> short-lived hashed reset token -> new password)
router.post("/forgot-password", authLimiter, forgotPasswordRequest);
router.post("/forgot-password/verify", authLimiter, forgotPasswordVerify);
router.post("/forgot-password/resend", authLimiter, forgotPasswordResendOtp);
router.post("/forgot-password/reset", authLimiter, forgotPasswordReset);

// Real Google OAuth: config probe + authorization redirect (public pages).
router.get("/google-config", googleConfigStatus);
router.get("/google-auth", authLimiter, googleAuthStart);
router.post("/google-login", authLimiter, googleLogin);

// NOTE: No public admin-creation/setup endpoint exists.
// Admins are created ONLY via the secure CLI: `npm run seed:admin`
// (see seedAdmin.js - env-based credentials, never printed).

// Protected
router.get("/me", protect, getMe);
router.put("/me", protect, updateMe);

// Admin only
router.get("/admin/list", protect, admin, listUsers);
router.get("/admin/:id/orders", protect, admin, getUserOrders);

module.exports = router;