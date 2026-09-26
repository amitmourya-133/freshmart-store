const express = require("express");
const router = express.Router();
const { protect } = require("../middleware/auth");
const notificationController = require("../controllers/notificationController");

// All inbox routes are owner-scoped and require an authenticated user
// (customer, delivery partner or admin).

// GET /api/notifications — my inbox (?limit&skip&type&read)
router.get("/", protect, notificationController.getMyNotifications);

// GET /api/notifications/unread-count — badge for the header bell
router.get("/unread-count", protect, notificationController.getUnreadCount);

// PUT /api/notifications/read-all — mark entire inbox read
router.put("/read-all", protect, notificationController.markAllRead);

// PUT /api/notifications/:id/read — mark one notification read (owner)
router.put("/:id/read", protect, notificationController.markRead);

module.exports = router;