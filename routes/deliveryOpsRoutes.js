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
const { protect, admin, delivery } = require("../middleware/auth");
const deliveryOps = require("../controllers/deliveryOpsController");

// ===============================
// PARTNER (customer can also look at their own partner status)
// ===============================

// POST /api/delivery-ops/apply - apply to become a delivery partner
router.post("/apply", protect, deliveryOps.applyAsPartner);

// GET /api/delivery-ops/me - my partner status, live counters and ops switches
router.get("/me", protect, deliveryOps.myPartnerStatus);

// PUT /api/delivery-ops/availability - go online/offline (with an optional break reason)
router.put("/availability", protect, delivery, deliveryOps.setAvailability);

// GET /api/delivery-ops/offers - open offers addressed to me, nearest first
router.get("/offers", protect, delivery, deliveryOps.listOpenOffers);

// GET /api/delivery-ops/active - lean view of the runs in progress
router.get("/active", protect, delivery, deliveryOps.activeBoard);

// POST /api/delivery-ops/offers/:id/claim - atomic first-come claim
router.post("/offers/:id/claim", protect, delivery, deliveryOps.claimOffer);

// POST /api/delivery-ops/offers/:id/decline - not taking this one
router.post("/offers/:id/decline", protect, delivery, deliveryOps.declineOffer);

// POST /api/delivery-ops/assignments/:id/otp/reissue - the customer lost the OTP
router.post("/assignments/:id/otp/reissue", protect, delivery, deliveryOps.reissueOtp);

// POST /api/delivery-ops/assignments/:id/cash - record COD cash collected
router.post("/assignments/:id/cash", protect, delivery, deliveryOps.confirmCash);

// POST /api/delivery-ops/assignments/:id/signature - recipient sign-off
router.post("/assignments/:id/signature", protect, delivery, deliveryOps.saveSignature);

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
