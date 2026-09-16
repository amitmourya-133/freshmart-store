// ===============================
// ADMIN DASHBOARD ROUTES
// GET /api/admin/dashboard -> admin-only sales analytics
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const dashboardController = require("../controllers/dashboardController");

router.get("/", protect, admin, dashboardController.getDashboard);

module.exports = router;