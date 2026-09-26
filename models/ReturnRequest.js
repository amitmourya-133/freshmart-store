// ===============================
// RETURN / REPLACEMENT / REFUND REQUEST MODEL
// COD-only workflow (no Razorpay refunds): a customer returns part/all of a
// delivered order; support records the outcome as a refund (cash / UPI / bank /
// store credit) or a replacement, with a strict status state machine.
// ===============================

const mongoose = require("mongoose");

const returnItemSchema = new mongoose.Schema(
    {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true },
        name: { type: String, required: true },
        price: { type: Number, required: true, min: 0 },
        quantity: { type: Number, required: true, min: 1 },
        variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
        variantUnit: { type: String, default: null }
    },
    { _id: false }
);

const returnRequestSchema = new mongoose.Schema(
    {
        returnNumber: { type: String, required: true, unique: true },
        order: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
        // null for guest orders (the order's customer snapshot is used then).
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        customer: {
            name: { type: String, required: true },
            phone: { type: String, required: true },
            address: { type: String, default: null },
            city: { type: String, default: null },
            state: { type: String, default: null },
            pincode: { type: String, default: null }
        },
        items: { type: [returnItemSchema], default: [] },
        // refund = money back (COD collected / manual UPI), replacement = goods.
        returnType: { type: String, enum: ["refund", "replacement"], required: true },
        reason: { type: String, required: true, trim: true, maxlength: 500 },
        comments: { type: String, default: null, maxlength: 1000 },
        // Optional customer-uploaded proof (Cloudinary URL, server-uploaded).
        proofImage: { type: String, default: null },
        status: {
            type: String,
            // SUBMITTED -> PROCESSING -> APPROVED | REJECTED
            // APPROVED + refund        -> REFUND_PENDING -> REFUND_PROCESSED -> CLOSED
            // APPROVED + replacement   -> REPLACEMENT_INITIATED -> REPLACEMENT_DELIVERED -> CLOSED
            // SUBMITTED -> CANCELLED (customer only)
            enum: [
                "SUBMITTED", "PROCESSING", "APPROVED", "REJECTED", "CANCELLED",
                "REFUND_PENDING", "REFUND_PROCESSED",
                "REPLACEMENT_INITIATED", "REPLACEMENT_DELIVERED", "CLOSED"
            ],
            default: "SUBMITTED"
        },
        timeline: [
            {
                status: { type: String },
                by: { type: String, default: null },
                at: { type: Date, default: Date.now },
                note: { type: String, default: null }
            }
        ],
        refund: {
            // Server-computed on APPROVAL: sum of returned line subtotals,
            // capped at the order total. The admin's recorded amount may be
            // less (e.g. proportional discount share) but never more.
            computedAmount: { type: Number, default: 0 },
            amount: { type: Number, default: 0 },
            method: {
                type: String,
                enum: ["cash", "upi_transfer", "bank_transfer", "store_credit"],
                default: null
            },
            reference: { type: String, default: null },
            processedAt: { type: Date, default: null },
            processedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
            note: { type: String, default: null }
        },
        // Whether processing this refund flipped the order paymentStatus to
        // REFUNDED (only happened for orders already marked PAID).
        orderPaymentStatusChanged: { type: Boolean, default: false },
        // Guard against double-restocking returned goods back onto the shelf.
        stockRestocked: { type: Boolean, default: false }
    },
    { timestamps: true }
);

// Query patterns: customer history, admin status filters.
returnRequestSchema.index({ user: 1, createdAt: -1 });
returnRequestSchema.index({ status: 1 });

module.exports = mongoose.model("ReturnRequest", returnRequestSchema);