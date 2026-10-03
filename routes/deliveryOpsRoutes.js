// ===============================
// DELIVERY OPERATIONS ROUTES
// Partner-facing live-delivery surface (offers / claim / status / history) and
// the admin surface (applicants / review / force-assign / sweep / settings /
// day-end COD reconciliation).
//
// Every route is authenticated. Partner routes additionally require the
// "delivery" role (enforced again inside the controller against
// partnerStatus === "approved"); admin routes require the "admin" role.
// No route here trusts the client for identity, money or distance.
// ===============================

const express = require("express");
const router = express.Router();
const { rateLimit } = require("../utils/rateLimit");
// SEC-03c: partner application + ops writes were only covered by the app-wide
// /api bucket. Applying as a partner is a public-facing form, so it gets its own
// tight budget; the rest of the partner board is a normal write budget.
// Keyed on the authenticated account (see utils/rateLimit.js userKeyFrom):
// partners and staff share carrier NAT / office egress, so an IP-keyed bucket
// here blocks a whole fleet or a whole office. `protect` runs before the
// limiter on every route below, so the account is always available.
const partnerApplyLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, keyBy: "user" });
const opsWriteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 600, keyBy: "user" });
const { protect, admin, delivery } = require("../middleware/auth");
const deliveryOps = require("../controllers/deliveryOpsController");

// ===============================
// PARTNER (customer can also look at their own partner status)
// ===============================

// POST /api/delivery-ops/apply - apply to become a delivery partner
router.post("/apply", protect, partnerApplyLimiter, deliveryOps.applyAsPartner);

// GET /api/delivery-ops/me - my partner status, live counters and ops switches
router.get("/me", protect, deliveryOps.myPartnerStatus);

// PUT /api/delivery-ops/availability - go online/offline (with an optional break reason)
router.put("/availability", protect, delivery, opsWriteLimiter, deliveryOps.setAvailability);

// GET /api/delivery-ops/offers - open offers addressed to me, nearest first
router.get("/offers", protect, delivery, deliveryOps.listOpenOffers);

// GET /api/delivery-ops/active - lean view of the runs in progress
router.get("/active", protect, delivery, deliveryOps.activeBoard);

// POST /api/delivery-ops/offers/:id/claim - atomic first-accept-wins claim.
// POST /api/delivery/offers/:id/accept - the same operation under its canonical
// name. Both are registered here (and mirrored in routes/deliveryRoutes.js) so
// the partner panel and any future client use one implementation and can never
// observe different behaviour from the two URLs.
router.post("/offers/:id/claim", protect, delivery, opsWriteLimiter, deliveryOps.acceptOffer);
router.post("/offers/:id/accept", protect, delivery, opsWriteLimiter, deliveryOps.acceptOffer);

// POST /api/delivery-ops/offers/:id/decline - not taking this one
router.post("/offers/:id/decline", protect, delivery, opsWriteLimiter, deliveryOps.declineOffer);

// POST /api/delivery-ops/assignments/:id/otp/reissue - the customer lost the OTP
router.post("/assignments/:id/otp/reissue", protect, delivery, opsWriteLimiter, deliveryOps.reissueOtp);

// POST /api/delivery-ops/assignments/:id/cash - record COD cash collected
router.post("/assignments/:id/cash", protect, delivery, opsWriteLimiter, deliveryOps.confirmCash);

// POST /api/delivery-ops/assignments/:id/signature - recipient sign-off
router.post("/assignments/:id/signature", protect, delivery, opsWriteLimiter, deliveryOps.saveSignature);

// GET /api/delivery-ops/history - my completed drops + earnings/COD summary
router.get("/history", protect, delivery, deliveryOps.myHistory);

// ===============================
// ADMIN
// ===============================

// GET /api/delivery-ops/admin/partners - partners + applicants + today's offers
router.get("/admin/partners", protect, admin, deliveryOps.adminListPartners);

// POST /api/delivery-ops/admin/partners/:id/review - approve / reject / revoke
router.post("/admin/partners/:id/review", protect, admin, deliveryOps.adminReviewPartner);

// POST /api/delivery-ops/admin/partners/:id/force-assign - assign an order now
router.post("/admin/partners/:id/force-assign", protect, admin, deliveryOps.adminForceAssign);

// POST /api/delivery-ops/admin/offers/sweep - run the expiry sweep immediately
router.post("/admin/offers/sweep", protect, admin, deliveryOps.adminSweepOffers);

// POST /api/delivery-ops/admin/broadcast/:orderId - re-alert partners for an order
router.post("/admin/broadcast/:orderId", protect, admin, deliveryOps.adminRebroadcast);

// GET /api/delivery-ops/admin/reconciliation?date=YYYY-MM-DD - day-end COD sheet
router.get("/admin/reconciliation", protect, admin, deliveryOps.adminReconciliation);

// GET /api/delivery-ops/admin/settings - delivery-operations switches
router.get("/admin/settings", protect, admin, deliveryOps.adminGetOpsSettings);

// PUT /api/delivery-ops/admin/settings - update the switches
router.put("/admin/settings", protect, admin, deliveryOps.adminUpdateOpsSettings);

// POST /api/delivery-ops/admin/push/prune - deactivate chronically failing endpoints
router.post("/admin/push/prune", protect, admin, deliveryOps.adminPrunePush);

module.exports = router;
