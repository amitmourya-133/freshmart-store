const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const paymentSchema = new Schema(
    {
        order: {
            type: Schema.Types.ObjectId,
            ref: "Order",
            required: [true, "Order reference is required"],
            unique: true,
        },

        // Razorpay specific fields
        razorpayOrderId: {
            type: String,
        },
        razorpayPaymentId: {
            type: String,
        },
        razorpaySignature: {
            type: String,
        },

        // Payment details
        amount: {
            type: Number,
            required: [true, "Amount is required"],
            min: [0, "Amount must be positive"],
        },
        currency: {
            type: String,
            default: "INR",
        },

        // Payment status
        status: {
            type: String,
            enum: [
                "created",
                "authorized",
                "captured",
                "failed",
                "refunded",
            ],
            default: "created",
        },

        // Payment method
        paymentMethod: {
            type: String,
            enum: ["cod", "razorpay", "upi_manual"],
            default: "cod",
        },

        // UPI/manual reference
        paymentReference: {
            type: String,
            trim: true,
        },

        // Timestamps
        createdAt: {
            type: Date,
            default: Date.now,
        },
        updatedAt: {
            type: Date,
        },
    },
    { timestamps: true }
);

// Index for order lookup
paymentSchema.index({ order: 1 });

module.exports = mongoose.model("Payment", paymentSchema);