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

// Customer (owner enforced inside the controller).
router.post("/", optionalProtect, createReturn);
router.get("/my", protect, listMyReturns);
router.post("/upload-proof", protect, uploadReturnProof);
router.get("/:id", protect, getReturn);
router.post("/:id/cancel", protect, cancelReturn);

// Admin.
router.get("/", protect, admin, adminListReturns);
router.patch("/:id/status", protect, admin, adminUpdateReturnStatus);

module.exports = router;