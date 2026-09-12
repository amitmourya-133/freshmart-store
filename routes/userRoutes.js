// ===============================
// USER ROUTES
// ===============================

const express = require("express");
const router = express.Router();
const {
    signup,
    login,
    getMe,
    sendOTP,
    verifyOTP,
    googleLogin,
    createAdmin
} = require("../controllers/userController");
const { protect } = require("../middleware/auth");

// Public
router.post("/signup", signup);
router.post("/login", login);
router.post("/send-otp", sendOTP);
router.post("/verify-otp", verifyOTP);
router.post("/google-login", googleLogin);
router.post("/admin/setup", createAdmin);

// Protected
router.get("/me", protect, getMe);

module.exports = router;
