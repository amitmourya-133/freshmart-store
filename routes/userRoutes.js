// ===============================
// USER ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    signup,
    login,
    getMe,
    googleConfigStatus,
    googleAuthStart,
    googleLogin,
    listUsers,
    getUserOrders
} = require("../controllers/userController");
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Soft brute-force guard.
const authLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// Public
router.post("/signup", authLimiter, signup);
router.post("/login", authLimiter, login);

// Real Google OAuth: config probe + authorization redirect (public pages).
router.get("/google-config", googleConfigStatus);
router.get("/google-auth", authLimiter, googleAuthStart);
router.post("/google-login", authLimiter, googleLogin);

// NOTE: No public admin-creation/setup endpoint exists.
// Admins are created ONLY via the secure CLI: `npm run seed:admin`
// (see seedAdmin.js - env-based credentials, never printed).

// Protected
router.get("/me", protect, getMe);

// Admin only
router.get("/admin/list", protect, admin, listUsers);
router.get("/admin/:id/orders", protect, admin, getUserOrders);

module.exports = router;