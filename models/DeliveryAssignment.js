const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const DeliveryAssignmentSchema = new mongoose.Schema(
    {
        order: {
            type: ObjectId,
            ref: "Order",
            required: [true, "Order reference is required"],
        },
        deliveryUser: {
            type: ObjectId,
            ref: "User",
            required: [true, "Delivery user reference is required"],
        },
        assignedBy: {
            type: ObjectId,
            ref: "User",
            required: [true, "Assigner reference is required"],
        },

        // Assignment status lifecycle
        status: {
            type: String,
            enum: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE", "DELIVERED", "REJECTED", "CANCELLED"],
            default: "ASSIGNED",
        },

        // Timestamps for each status
        assignedAt: {
            type: Date,
            default: Date.now,
        },
        acceptedAt: {
            type: Date,
        },
        pickedUpAt: {
            type: Date,
        },
        enRouteAt: {
            type: Date,
        },
        deliveredAt: {
            type: Date,
        },

        // Proof and verification
        proofImage: {
            type: String, // URL to proof image
        },
        otpCode: {
            type: String, // legacy plain OTP — no longer written (kept for compat)
        },
        // Delivery-completion OTP (only the SHA-256 hash is stored)
        otpHash: {
            type: String, // SHA-256 digest of the 4-digit OTP
        },
        otpExpiry: {
            type: Date, // OTP valid until this timestamp
        },
        otpAttempts: {
            type: Number,
            default: 0, // incorrect attempts (max 5)
        },
        otpVerified: {
            type: Boolean,
            default: false,
        },

        // Earnings
        earnings: {
            type: Number,
            default: 0,
        },
        tipAmount: {
            type: Number,
            default: 0,
        },

        // Route/location info
        pickupLocation: {
            type: String,
        },
        deliveryLocation: {
            type: String,
        },

        // Notes
        notes: {
            type: String,
            trim: true,
        },
    },
    { timestamps: true }
);

// Index for quick lookup by order and delivery user
DeliveryAssignmentSchema.index({ order: 1 });
DeliveryAssignmentSchema.index({ deliveryUser: 1, status: 1 });

module.exports = mongoose.model("DeliveryAssignment", DeliveryAssignmentSchema);