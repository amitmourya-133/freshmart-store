// ===============================
// WALLET ROUTES
// Mounted at /api/wallet (customer) and /api/admin/wallet (admin ops).
// ===============================

const express = require("express");
const router = express.Router();
const {
    getMyWallet,
    getMyTransactions,
    adminCredit,
    adminOverview,
} = require("../controllers/walletController");
const { protect, admin } = require("../middleware/auth");

// Customer (mounted under /api/wallet)
router.get("/", protect, getMyWallet);
router.get("/transactions", protect, getMyTransactions);

// Admin (mounted under /api/admin/wallet)
router.post("/credit", protect, admin, adminCredit);
router.get("/overview", protect, admin, adminOverview);

module.exports = router;