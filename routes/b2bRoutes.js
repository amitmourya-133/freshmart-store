// ===============================
// B2B SUPPLY ROUTES (Phase 3.7)
// Customer (approved b2b_customer only): /api/b2b/...
// Admin:                            /api/admin/b2b/...
// ===============================

const express = require("express");
const router = express.Router();
const adminRouter = express.Router();
const { protect, admin, b2b } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const b2bController = require("../controllers/b2bController");

const b2bLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30 });

// B2B buyer (approved profile required)
router.get("/products", protect, b2b, b2bController.b2bProducts);
router.get("/orders", protect, b2b, b2bController.myB2BOrders);
router.get("/credit", protect, b2b, b2bController.myCredit);
router.post("/orders", protect, b2b, b2bLimiter, b2bController.createB2BOrder);
router.post("/orders/:id/recurring", protect, b2b, b2bController.scheduleRecurring);
router.post("/orders/:id/recurring/cancel", protect, b2b, b2bController.cancelRecurring);

// Admin management
adminRouter.get("/b2b/accounts", protect, admin, b2bController.adminAccounts);
adminRouter.put("/b2b/accounts/:id", protect, admin, b2bController.adminUpdateAccount);
adminRouter.post("/b2b/process-recurring", protect, admin, b2bController.processRecurring);

module.exports = { router, adminRouter };