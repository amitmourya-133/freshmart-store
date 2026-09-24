const express = require("express");
const router = express.Router();
const DeliveryAssignment = require("../models/DeliveryAssignment");
const { protect, admin } = require("../middleware/auth");

// Helper functions inline
function isDeliveryUser(user) {
    return user && user.role === "delivery";
}

function isAdminUser(user) {
    return user && user.role === "admin";
}

// POST /api/delivery/assign — admin assigns delivery to a partner
router.post("/assign", protect, async (req, res) => {
    try {
        const { orderId, deliveryUserId } = req.body;

        if (!orderId || !deliveryUserId) {
            return res.status(400).json({
                success: false,
                message: "Order ID and Delivery User ID are required",
            });
        }

        // Check if order already has a delivery assignment
        const existingAssignment = await DeliveryAssignment.findOne({ order: orderId });
        if (existingAssignment) {
            return res.status(400).json({
                success: false,
                message: "This order already has a delivery assignment",
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

        const assignment = new DeliveryAssignment({
            order: orderId,
            deliveryUser: deliveryUserId,
            assignedBy: req.user.id,
            status: "ASSIGNED",
        });

        await assignment.save();

        return res.json({
            success: true,
            message: "Delivery assigned successfully",
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
router.get("/today", protect, async (req, res) => {
    try {
        const deliveries = await DeliveryAssignment.find({
            deliveryUser: req.user.id,
            status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
        })
            .populate("order", "orderNumber items total status paymentStatus")
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
});

// PUT /api/delivery/accept — delivery partner accepts assignment
router.put("/accept", protect, async (req, res) => {
    try {
        const { assignmentId } = req.body;

        if (!assignmentId) {
            return res.status(400).json({
                success: false,
                message: "Assignment ID is required",
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
router.put("/reject", protect, async (req, res) => {
    try {
        const { assignmentId } = req.body;

        if (!assignmentId) {
            return res.status(400).json({
                success: false,
                message: "Assignment ID is required",
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

// PUT /api/delivery/status — update delivery status
router.put("/status", protect, async (req, res) => {
    try {
        const { assignmentId, status } = req.body;

        if (!assignmentId || !status) {
            return res.status(400).json({
                success: false,
                message: "Assignment ID and status are required",
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

        // Enforce valid state transitions
        const statusRanks = {
            ASSIGNED: 0,
            ACCEPTED: 1,
            PICKED_UP: 2,
            EN_ROUTE: 3,
            DELIVERED: 4,
        };

        const currentRank = statusRanks[assignment.status];
        const newRank = statusRanks[status];

        if (currentRank !== undefined && newRank !== undefined && newRank <= currentRank) {
            return res.status(400).json({
                success: false,
                message: "Invalid status transition. Status can only move forward.",
            });
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

        // If delivered, also update the order status
        if (status === "DELIVERED") {
            await require("../models/Order").findByIdAndUpdate(
                assignment.order,
                {
                    status: "Delivered",
                    paymentStatus: "PAID",
                },
                { new: true }
            );
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

// GET /api/delivery/earnings — get delivery partner earnings
router.get("/earnings", protect, async (req, res) => {
    try {
        const deliveries = await DeliveryAssignment.find({
            deliveryUser: req.user.id,
            status: "DELIVERED",
        })
            .populate("order", "total")
            .sort({ deliveredAt: -1 });

        let totalEarnings = 0;
        let completedCount = 0;

        deliveries.forEach((delivery) => {
            if (delivery.earnings && delivery.earnings > 0) {
                totalEarnings += delivery.earnings;
                completedCount++;
            }
        });

        return res.json({
            success: true,
            totalEarnings,
            completedCount,
            deliveries,
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

// PUT /api/delivery/availability — toggle availability
router.put("/availability", protect, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);

        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }

        user.isAvailable = req.body.isAvailable;
        await user.save();

        return res.json({
            success: true,
            isAvailable: user.isAvailable,
            message: user.isAvailable ? "You are now online" : "You are now offline",
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message,
        });
    }
});

module.exports = router;