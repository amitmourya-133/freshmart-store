// ===============================
// GROUP / COLONY ORDER ROUTES (Phase 2.6)
// ===============================

const express = require("express");
const router = express.Router();
const { protect, admin } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");
const groupController = require("../controllers/groupOrderController");

const groupLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 20 });

router.get("/", groupController.listGroups);
router.post("/", protect, groupLimiter, groupController.createGroup);
router.get("/:id", groupController.getGroup);
router.post("/:id/join", protect, groupLimiter, groupController.joinGroup);
router.post("/:id/leave", protect, groupLimiter, groupController.leaveGroup);
router.post("/:id/order", protect, groupLimiter, groupController.orderForGroup);
router.post("/:id/close", protect, groupLimiter, groupController.closeGroup);
router.post("/ops/sweep", protect, admin, groupController.sweep);

module.exports = router;