// ===============================
// RETURN / REPLACEMENT / REFUND ROUTES
// COD-only support workflow. Customers open/read/cancel their own requests;
// admins drive the status machine and record refunds.
// ===============================

const express = require("express");
const router = express.Router();
const {
    createReturn,
    listMyReturns,
    getReturn,
    cancelReturn,
    adminListReturns,
    adminUpdateReturnStatus,
    uploadReturnProof
} = require("../controllers/returnController");
const { protect, admin, optionalProtect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// A return ticket can be opened WITHOUT authentication (optionalProtect, so a
// guest with an order number can raise one), which made POST / the cheapest
// unauthenticated write endpoint in the app: flood the admin queue with fake
// tickets, or push attacker text into the admin dashboard. Five tickets per
// ten minutes is plenty for a real customer.
//
// `keyBy: "user"` means a signed-in customer is limited per account, and only
// genuinely anonymous callers fall back to the IP - a customer on carrier NAT
// (or a whole housing society behind one address) can no longer lock each other
// out of the return flow, which was a live risk at five per IP.
const publicReturnLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 5, keyBy: "user" });
const returnWriteLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 30, keyBy: "user" });

// Customer (owner enforced inside the controller).
router.post("/", optionalProtect, publicReturnLimiter, createReturn);
router.get("/my", protect, listMyReturns);
router.post("/upload-proof", protect, returnWriteLimiter, uploadReturnProof);
router.get("/:id", protect, getReturn);
router.post("/:id/cancel", protect, returnWriteLimiter, cancelReturn);

// Admin.
router.get("/", protect, admin, adminListReturns);
router.patch("/:id/status", protect, admin, adminUpdateReturnStatus);

module.exports = router;