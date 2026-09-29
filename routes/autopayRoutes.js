// ===============================
// AUTOPAY ROUTES (Phase 3.9)
// Customer: /api/autopay/...            (protect)
// Provider webhook: POST /api/autopay/webhook (HMAC verified, no cookie auth)
// Admin: /api/admin/autopay
// ===============================

const express = require("express");
const router = express.Router();
const adminRouter = express.Router();
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const autopayController = require("../controllers/autopayController");

const mandateLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 10 });

router.post("/mandate", protect, mandateLimiter, autopayController.createMandate);
router.get("/mandate", protect, autopayController.myMandate);
router.post("/mandate/:id/cancel", protect, mandateLimiter, autopayController.cancelMandate);
router.post("/webhook", autopayController.webhook); // HMAC-guarded, never cookie auth

adminRouter.get("/autopay", protect, admin, autopayController.adminList);

module.exports = { router, adminRouter };