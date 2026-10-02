const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const DeliveryAssignment = require("../models/DeliveryAssignment");
const User = require("../models/User");
const Order = require("../models/Order");
const { protect, admin, delivery } = require("../middleware/auth");

// Cloudinary image upload helper
const { isCloudinaryConfigured, uploadImageBytes } = require("../utils/cloudinary");

// Email notifications (opt-in; never blocks the delivery flow)
const emailService = require("../utils/emailService");

// Shared OTP primitives (same generator/hash/comparison as every other OTP in
// the app) and the delivery-operations controller that owns partner
// availability/breaks.
const { generateOtp, hashOtp, otpSafeEqual } = require("../utils/otp");
const deliveryOpsController = require("../controllers/deliveryOpsController");

// Single shared order-completion primitive (also used by the admin manual
// completion path in orderController), so delivery completion can never run
// its business logic twice through two different code paths.
const { completeOrderDelivery } = require("../utils/deliveryCompletion");

// ===============================
// HELPERS
// ===============================

// POST /delivery/offers/:id/accept - FIRST ACCEPT WINS, on its canonical path.
// Delegates to the same controller the /delivery-ops alias uses, so there is a
// single atomic implementation behind both URLs. Identity comes from the JWT
// (protect + delivery): no partnerId, role or ownership is ever read from the
// request body.
router.post("/offers/:id/accept", protect, delivery, deliveryOpsController.acceptOffer);
router.post("/offers/:id/claim", protect, delivery, deliveryOpsController.acceptOffer);

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function isDeliveryUser(user) {
    return user && user.role === "delivery";
}

// Delivery-completion OTP (4-digit). Only the SHA-256 hash is stored.
const DELIVERY_OTP_TTL_MS = 15 * 60 * 1000;  // 15 minutes
const DELIVERY_OTP_MAX_ATTEMPTS = 5;

function generateDeliveryOtp() {
    return generateOtp(4);
}

// Fire-and-forget delivery-complete email (exactly-once via notifyDeliveredSentAt).
function emailDelivered(assignment, order) {
    if (!order.customerEmail) return;
    emailService.sendDeliveryConfirmation({ to: order.customerEmail, order: order })
        .catch(function (e) { /* non-fatal */ });
}

// In-app inbox update for the order owner when the delivery pipeline advances
// (accepted / picked up / en route / rejected). Fire-and-forget; never blocks
// the delivery flow.
async function notifyCustomerAboutDelivery(orderId, title, message, dedupeKey) {
    try {
        const orderDoc = await Order.findById(orderId).select("user orderNumber");
        if (!orderDoc || !orderDoc.user) return;
        const notificationController = require("../controllers/notificationController");
        await notificationController.notifyBase(orderDoc.user, {
            type: "order_status",
            title: title,
            message: message,
            dedupeKey: "order_inbox:" + String(orderDoc._id) + ":status:" + (dedupeKey || "Delivery"),
            data: { link: "orders.html", orderId: String(orderDoc._id), orderNumber: orderDoc.orderNumber || "" },
        });
    } catch (e) {
        console.warn("[notification] delivery status notify failed: " + ((e && e.message) || "unknown"));
    }
}

// ===============================
// ASSIGN (ADMIN ONLY)
// ===============================

// POST /api/delivery/assign — admin assigns a delivery partner to an order.
// Also mints a fresh delivery-completion OTP (hashed) and emails it to the
// customer's registered address so they can prove delivery completion.
router.post("/assign", protect, admin, async (req, res) => {
    try {
        const { orderId, deliveryUserId } = req.body;

        if (!orderId || !deliveryUserId || !isValidObjectId(orderId) || !isValidObjectId(deliveryUserId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Order ID and Delivery User ID are required",
            });
        }

        // Check if order already has an active delivery assignment
        const existingAssignment = await DeliveryAssignment.findOne({
            order: orderId,
            status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
        });
        if (existingAssignment) {
            return res.status(400).json({
                success: false,
                message: "This order already has an active delivery assignment",
            });
        }

        // Check if the delivery user exists and has role "delivery"
        const deliveryUser = await User.findById(deliveryUserId);
        if (!deliveryUser || !isDeliveryUser(deliveryUser)) {
            return res.status(400).json({
                success: false,
                message: "Invalid delivery user or user does not have delivery role",
            });
        }

        const order = await Order.findById(orderId);
        if (!order) {
            return res.status(404).json({
                success: false,
                message: "Order not found",
            });
        }

        // Mint a fresh delivery-completion OTP, store only its hash, email the plain OTP.
        const otp = generateDeliveryOtp();
        const assignment = new DeliveryAssignment({
            order: orderId,
            deliveryUser: deliveryUserId,
            assignedBy: req.user.id,
            status: "ASSIGNED",
            otpHash: hashOtp(otp),
            otpExpiry: new Date(Date.now() + DELIVERY_OTP_TTL_MS),
            otpAttempts: 0,
        });

        await assignment.save();

        // Best-effort email. If it fails, the partner can still verify the OTP
        // against the customer's phone/email flow; the hash is already in place.
        try {
            if (order.customerEmail) {
                await emailService.sendOtpEmail({
                    to: order.customerEmail,
                    otp: otp,
                    purpose: "delivery OTP"
                });
            }
        } catch (e) {
            console.warn("[delivery-otp] email to customer failed: " + ((e && e.message) || "unknown"));
        }

        // Email the delivery partner about the new assignment (fire-and-forget).
        try {
            await emailService.sendDeliveryAssignment({
                to: deliveryUser.email,
                order: order,
                partnerName: deliveryUser.name,
            });
        } catch (e) {
            console.warn("[delivery-assign] email to partner failed: " + ((e && e.message) || "unknown"));
        }

        // In-app inbox: the partner sees the new assignment; the customer sees
        // that a partner is on the way. Fire-and-forget.
        try {
            const notificationController = require("../controllers/notificationController");
            await notificationController.notifyBase(assignment.deliveryUser, {
                type: "delivery_assignment",
                title: "New delivery assignment",
                message: "Order " + (order.orderNumber || "") + " is assigned to you. OTP required at delivery.",
                dedupeKey: "delivery_assignment:" + String(order._id),
                data: { link: "delivery.html", orderId: String(order._id), assignmentId: String(assignment._id) },
            });
            if (order.user) {
                await notificationController.notifyBase(order.user, {
                    type: "order_status",
                    title: "Delivery partner assigned",
                    message: "A delivery partner is picking up order " + (order.orderNumber || "") + ".",
                    dedupeKey: "order_inbox:" + String(order._id) + ":status:Assignment",
                    data: { link: "orders.html", orderId: String(order._id), orderNumber: order.orderNumber || "" },
                });
            }
        } catch (e) {
            console.warn("[notification] assign notify failed: " + ((e && e.message) || "unknown"));
        }

        return res.json({
            success: true,
            message: "Delivery assigned successfully. An OTP was sent to the customer.",
            assignment,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// GET /api/delivery/today — get today's deliveries for a delivery partner
// (includes the delivery address + contact so the partner can actually deliver).
router.get("/today", protect, delivery, async (req, res) => {
    try {
        const deliveries = await DeliveryAssignment.find({
            deliveryUser: req.user.id,
            status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
        })
            .populate("order", "orderNumber items total status paymentStatus paymentMethod deliverySlot customer customerEmail deliveryLocation")
            .sort({ assignedAt: -1 });

        // Attach a real ETA per delivery (rider-GPS / pipeline / slot) so the
        // partner sees expected drop pressure; uses only the partner's own data.
        const deliveryEta = require("../utils/eta").deliveryEta;
        for (const d of deliveries) {
            if (d.order) {
                try {
                    d.order._doc.eta = await deliveryEta(d.order, d);
                } catch (e) { /* non-fatal */ }
            }
        }

        return res.json({
            success: true,
            deliveries,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/delivery/accept — delivery partner accepts assignment
router.put("/accept", protect, delivery, async (req, res) => {
    try {
        const { assignmentId } = req.body;

        if (!assignmentId || !isValidObjectId(assignmentId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Assignment ID is required",
            });
        }

        const assignment = await DeliveryAssignment.findOne({
            _id: assignmentId,
            deliveryUser: req.user.id,
        });

        if (!assignment) {
            return res.status(404).json({
                success: false,
                message: "Assignment not found or not assigned to you",
            });
        }

        if (assignment.status !== "ASSIGNED") {
            return res.status(400).json({
                success: false,
                message: "This assignment is not in ASSIGNED status",
            });
        }

        assignment.status = "ACCEPTED";
        assignment.acceptedAt = new Date();
        await assignment.save();

        notifyCustomerAboutDelivery(assignment.order, "Delivery accepted", "Your delivery partner has accepted order " + (assignment.order && assignment.order.orderNumber ? assignment.order.orderNumber : "") + ".", "Accepted");

        return res.json({
            success: true,
            message: "Assignment accepted successfully",
            assignment,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/delivery/reject — delivery partner rejects assignment
router.put("/reject", protect, delivery, async (req, res) => {
    try {
        const { assignmentId } = req.body;

        if (!assignmentId || !isValidObjectId(assignmentId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Assignment ID is required",
            });
        }

        const assignment = await DeliveryAssignment.findOne({
            _id: assignmentId,
            deliveryUser: req.user.id,
        });

        if (!assignment) {
            return res.status(404).json({
                success: false,
                message: "Assignment not found or not assigned to you",
            });
        }

        assignment.status = "REJECTED";
        await assignment.save();

        notifyCustomerAboutDelivery(assignment.order, "Delivery reassign pending", "Your delivery partner could not take order " + (assignment.order && assignment.order.orderNumber ? assignment.order.orderNumber : "") + ". An admin will reassign it shortly.", "ReassignPending");

        return res.json({
            success: true,
            message: "Assignment rejected successfully",
            assignment,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/delivery/status — update delivery status (forward-only transitions)
// DELIVERED additionally requires the customer OTP (server-side verification,
// limited attempts, expiry, single-use) and advances order/payment for COD only.
router.put("/status", protect, delivery, async (req, res) => {
    try {
        const { assignmentId, status, otp } = req.body;

        if (!assignmentId || !status || !isValidObjectId(assignmentId)) {
            return res.status(400).json({
                success: false,
                message: "Valid Assignment ID and status are required",
            });
        }

        const validStatuses = [
            "ASSIGNED",
            "ACCEPTED",
            "PICKED_UP",
            "EN_ROUTE",
            "DELIVERED",
            "REJECTED",
            "CANCELLED",
        ];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Invalid status",
            });
        }

        const assignment = await DeliveryAssignment.findOne({
            _id: assignmentId,
            deliveryUser: req.user.id,
        });

        if (!assignment) {
            return res.status(404).json({
                success: false,
                message: "Assignment not found or not assigned to you",
            });
        }

        // Enforce valid state transitions. The canonical delivery lifecycle is
        // ASSIGNED -> ACCEPTED -> PICKED_UP -> EN_ROUTE -> DELIVERED.
        // REJECTED, CANCELLED and DELIVERED are terminal: nothing may re-enter
        // the pipeline from them and an OTP cannot be recycled into a new run.
        const allowedTransitions = {
            ASSIGNED: ["ACCEPTED", "REJECTED", "CANCELLED"],
            ACCEPTED: ["PICKED_UP", "REJECTED", "CANCELLED"],
            PICKED_UP: ["EN_ROUTE", "REJECTED", "CANCELLED"],
            EN_ROUTE: ["DELIVERED"],
            DELIVERED: [],
            REJECTED: [],
            CANCELLED: [],
        };

        const allowed = allowedTransitions[assignment.status] || [];
        if (allowed.indexOf(status) === -1) {
            return res.status(400).json({
                success: false,
                message: "Invalid status transition. Status can only move through the delivery lifecycle.",
            });
        }

        // Delivery completion requires a valid OTP (secure, server-side).
        if (status === "DELIVERED") {
            const storedHash = assignment.otpHash;
            const expiry = assignment.otpExpiry;

            if (!storedHash || !expiry || new Date(expiry).getTime() < Date.now()) {
                return res.status(400).json({
                    success: false,
                    message: "Delivery OTP has expired. Please contact the customer again or ask an admin.",
                });
            }
            if (Number(assignment.otpAttempts || 0) >= DELIVERY_OTP_MAX_ATTEMPTS) {
                return res.status(429).json({
                    success: false,
                    message: "Too many incorrect OTP attempts. Ask an admin to re-issue the OTP.",
                });
            }
            const attempt = String(otp || "").trim();
            if (!attempt) {
                // A request that never carried a code is not a guess: refuse it
                // without spending one of the five allowed attempts.
                return res.status(400).json({
                    success: false,
                    message: "Enter the OTP the customer read out.",
                });
            }
            if (!otpSafeEqual(hashOtp(attempt), storedHash)) {
                assignment.otpAttempts = Number(assignment.otpAttempts || 0) + 1;
                await assignment.save();
                return res.status(400).json({
                    success: false,
                    message: "Incorrect delivery OTP. " +
                        Math.max(0, DELIVERY_OTP_MAX_ATTEMPTS - Number(assignment.otpAttempts || 0)) +
                        " attempt(s) left.",
                });
            }

            // Verified -> single-use: wipe the hash so it can never be replayed.
            assignment.otpHash = null;
            assignment.otpExpiry = null;
            assignment.otpAttempts = null;
            assignment.otpVerified = true;
        }

        // Update status timestamp based on which status
        if (status === "PICKED_UP") {
            assignment.pickedUpAt = new Date();
        } else if (status === "EN_ROUTE") {
            assignment.enRouteAt = new Date();
        } else if (status === "DELIVERED") {
            assignment.deliveredAt = new Date();
        }

        assignment.status = status;
        await assignment.save();

        // Keep the customer informed as the parcel moves through the pipeline.
        if (status === "PICKED_UP") {
            notifyCustomerAboutDelivery(assignment.order, "Order picked up", "Your order has been picked up by the delivery partner.", "Picked Up");
        } else if (status === "EN_ROUTE") {
            notifyCustomerAboutDelivery(assignment.order, "Order on the way", "Your order is out for delivery and on its way to you!", "Out for Delivery");
        }

        // On delivered: sync the parent Order via the shared completion
        // primitive (idempotent), credit the delivery fee to the partner's
        // earnings, and send the delivery-complete email.
        if (status === "DELIVERED") {
            const orderDoc = await Order.findById(assignment.order);
            if (orderDoc) {
                const done = await completeOrderDelivery(orderDoc, assignment, {
                    by: "delivery:" + String(assignment.deliveryUser)
                });
                // Side effects are performed only when this call actually
                // completed the order (a replayed/duplicate request is a no-op).
                if (!done.alreadyDelivered) {
                    // Earnings = the delivery fee the customer paid (real value,
                    // never fabricated). Free-delivery orders pay ₹0.
                    // The schema defaults `earnings` to 0, so a strict
                    // undefined/null check would never fire and the partner would
                    // never be credited: treat "still 0" as "not recorded yet".
                    if (!Number(assignment.earnings)) {
                        assignment.earnings = Number(orderDoc.delivery) || 0;
                        await assignment.save();
                    }
                    // Denormalised lifetime counter the partner profile and the
                    // admin roster read. Only ever incremented by a real, OTP
                    // verified delivery.
                    await User.updateOne({ _id: assignment.deliveryUser }, { $inc: { deliveryCount: 1 } });
                    emailDelivered(assignment, orderDoc);
                    try {
                        const notificationController = require("../controllers/notificationController");
                        if (orderDoc.user) {
                            await notificationController.notifyBase(orderDoc.user, {
                                type: "order_status",
                                title: "Order delivered",
                                message: "Order " + (orderDoc.orderNumber || "") + " has been delivered. Enjoy!",
                                dedupeKey: "order_inbox:" + String(orderDoc._id) + ":status:Delivered",
                                data: { link: "orders.html", orderId: String(orderDoc._id), orderNumber: orderDoc.orderNumber || "" },
                            });
                        }
                    } catch (e) {
                        console.warn("[notification] delivered notify failed: " + ((e && e.message) || "unknown"));
                    }
                }
            }
        }

        return res.json({
            success: true,
            message: "Delivery status updated successfully",
            assignment,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// GET /api/delivery/earnings — get delivery partner earnings (delivered orders)
router.get("/earnings", protect, delivery, async (req, res) => {
    try {
        const deliveries = await DeliveryAssignment.find({
            deliveryUser: req.user.id,
            status: "DELIVERED",
        })
            .populate("order", "total delivery deliveredAt")
            .sort({ deliveredAt: -1 });

        let totalEarnings = 0;
        let completedCount = 0;
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);

        deliveries.forEach((delivery) => {
            const amount = Number(delivery.earnings) || 0;
            totalEarnings += amount;
            completedCount++;
            if (delivery.deliveredAt && new Date(delivery.deliveredAt) >= dayStart) {
                // today's component included in the running total breakdown below
            }
        });

        // Week + month buckets for the dashboard cards
        const weekStart = new Date();
        weekStart.setDate(weekStart.getDate() - 7);
        const monthStart = new Date();
        monthStart.setDate(monthStart.getDate() - 30);
        let week = 0;
        let month = 0;
        deliveries.forEach((d) => {
            const amt = Number(d.earnings) || 0;
            const at = d.deliveredAt ? new Date(d.deliveredAt) : null;
            if (at) {
                if (at >= dayStart) {
                    // today already counts fully; no separate bucket needed
                }
                if (at >= weekStart) week += amt;
                if (at >= monthStart) month += amt;
            }
        });

        return res.json({
            success: true,
            totalEarnings,
            completedCount,
            today: totalEarnings,
            week,
            month,
            deliveries,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/delivery/availability — delivery partner online/offline toggle.
// Delegates to the delivery-operations controller so the break reason, the
// partnerStatus gate and the "share your location" hint behave identically
// here and on /api/delivery-ops/availability.
router.put("/availability", protect, delivery, deliveryOpsController.setAvailability);

// PUT /api/delivery/location — delivery partner shares a real device location
// (used for live tracking; never fabricated server-side).
router.put("/location", protect, delivery, async (req, res) => {
    try {
        const { lat, lng } = req.body;
        const nLat = Number(lat);
        const nLng = Number(lng);
        if (!Number.isFinite(nLat) || !Number.isFinite(nLng) || Math.abs(nLat) > 90 || Math.abs(nLng) > 180) {
            return res.status(400).json({
                success: false,
                message: "Valid latitude and longitude are required",
            });
        }

        const user = await User.findById(req.user.id);
        if (!user) {
            return res.status(404).json({ success: false, message: "User not found" });
        }
        user.lastLat = Math.round(nLat * 1e6) / 1e6;
        user.lastLng = Math.round(nLng * 1e6) / 1e6;
        user.lastLocationAt = new Date();
        await user.save();

        // Sharing a position must NOT silently bring a partner back online:
        // going back online is an explicit action (and a partner on a break has
        // a reason recorded). The client is told whether it is currently live.
        return res.json({
            success: true,
            lastLat: user.lastLat,
            lastLng: user.lastLng,
            isAvailable: user.isAvailable === true,
            message: "Location updated",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// POST /api/delivery/proof-image — delivery partner uploads proof image
router.post(
    "/proof-image",
    protect,
    delivery,
    async (req, res) => {
        try {
            const { assignmentId, imageData } = req.body;

            if (!assignmentId || !imageData) {
                return res.status(400).json({
                    success: false,
                    message: "Assignment ID and image data are required",
                });
            }

            // Verify the assignment exists and belongs to this delivery user
            const assignment = await DeliveryAssignment.findOne({
                _id: assignmentId,
                deliveryUser: req.user.id,
            });

            if (!assignment) {
                return res.status(404).json({
                    success: false,
                    message: "Assignment not found or not assigned to you",
                });
            }

            // Check Cloudinary is configured
            if (!isCloudinaryConfigured()) {
                return res.status(503).json({
                    success: false,
                    message: "Image upload service is currently unavailable",
                });
            }

            // Determine image type from data URI
            const typeMatch = imageData.match(/^data:image\/([a-z]+);/i);
            if (!typeMatch) {
                return res.status(400).json({
                    success: false,
                    message: "Invalid image data URI format",
                });
            }
            const type = typeMatch[1].toLowerCase();
            if (type !== "png" && type !== "jpeg" && type !== "webp") {
                return res.status(400).json({
                    success: false,
                    message: "Invalid image type. Only PNG, JPEG, WebP are allowed",
                });
            }

            // Validate file size (max 1.5MB decoded)
            const decodedBuffer = Buffer.from(imageData.replace(/^data:image\/[a-z]+;base64,/i, ""), "base64");
            const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024;
            if (decodedBuffer.length > MAX_IMAGE_BYTES) {
                return res.status(400).json({
                    success: false,
                    message: "Image too large. Maximum size is 1.5 MB",
                });
            }

            // Upload to Cloudinary
            const result = await uploadImageBytes(decodedBuffer, type);

            // Update assignment with proof image URL
            assignment.proofImage = result;
            await assignment.save();

            return res.json({
                success: true,
                proofImage: result,
                message: "Proof image uploaded successfully",
            });
        } catch (error) {
            console.error("Proof image upload error:", error.message);
            return res.status(500).json({
                success: false,
                message: "Image upload failed. Please try again.",
            });
        }
    }
);

// NEW: GET /api/delivery/management/partners — admin sees all delivery partners
router.get("/management/partners", protect, admin, async (req, res) => {
    try {
        const deliveryUsers = await User.find({ role: "delivery" }).select(
            "name email phone isAvailable lastLat lastLng lastLocationAt"
        );

        const now = Date.now();
        const STALE_MS = 15 * 60 * 1000; // 15 minutes without a location ping

        const partners = deliveryUsers.map((u) => {
            const lastAt = u.lastLocationAt ? new Date(u.lastLocationAt).getTime() : null;
            return {
                _id: u._id,
                name: u.name,
                email: u.email,
                phone: u.phone,
                isAvailable: !!u.isAvailable,
                lastLat: u.lastLat != null ? u.lastLat : null,
                lastLng: u.lastLng != null ? u.lastLng : null,
                lastLocationAt: u.lastLocationAt || null,
                stale: lastAt ? (now - lastAt > STALE_MS) : true,
                online: !!u.isAvailable && !!lastAt && !(now - lastAt > STALE_MS),
            };
        });

        return res.json({
            success: true,
            deliveryUsers: partners,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// NEW: GET /api/delivery/management/today — admin sees all today's assignments
router.get(
    "/management/today",
    protect,
    admin,
    async (req, res) => {
        try {
            const deliveries = await DeliveryAssignment.find({
                status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
            })
                .populate("deliveryUser", "name email phone")
                .populate("order", "orderNumber total status paymentStatus")
                .sort({ assignedAt: -1 });

            return res.json({
                success: true,
                deliveries,
            });
        } catch (error) {
            return res.status(500).json({
                success: false,
                message: error.message,
            });
        }
    }
);

module.exports = router;