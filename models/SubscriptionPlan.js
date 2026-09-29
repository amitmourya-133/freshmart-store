const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const SubscriptionPlanSchema = new mongoose.Schema({
    name: {
        type: String,
        required: [true, "Plan name is required"],
        trim: true,
        unique: true,
    },
    description: {
        type: String,
        required: [true, "Plan description is required"],
    },
    pricing: {
        amount: {
            type: Number,
            required: [true, "Plan price is required"],
            min: [0, "Price must be positive"],
        },
        frequency: {
            type: String,
            enum: ["weekly", "monthly", "quarterly", "half-yearly", "yearly"],
            required: [true, "Billing frequency is required"],
        },
        trialDays: {
            type: Number,
            default: 0,
            min: 0,
        },
    },
    features: [{
        type: String,
        enum: [
            "free_delivery",
            "priority_slots",
            "customizable_box",
            "extra_kg",
            "extra_fruits",
            "all_products",
            "skip_any_week",
            "pause_subscription",
        ],
    }],
    isActive: {
        type: Boolean,
        default: true,
    },
    sortOrder: {
        type: Number,
        default: 0,
    },
    // ============ Veggie Box (Subscription 2.0) ============
    // The exact product list a subscriber receives each cycle. Nothing is
    // guessed at fulfillment time: quantities + product references are locked
    // here and snapshotted onto the user's subscription at subscribe time.
    boxItems: [{
        productId: {
            type: ObjectId,
            ref: "Product",
        },
        name: { type: String, trim: true },
        unit: { type: String, trim: true, default: "kg" },
        quantity: {
            type: Number,
            min: 0.01,
            default: 1,
        },
    }],
    // Days between deliveries (min 3 so we never double-fulfil by accident).
    deliveryEveryDays: {
        type: Number,
        default: 7,
        min: 3,
        max: 120,
    },
    // Preferred weekday for the weekly cadence (0 = Sunday .. 6 = Saturday).
    deliveryDayOfWeek: {
        type: Number,
        default: -1,
        min: -1,
        max: 6,
    },
    // How the box is paid for each cycle: cash on delivery or a manual
    // UPI/QR reference. Gateway-autopay is bound via the AutopayMandate model.
    paymentMode: {
        type: String,
        enum: ["cod", "manual"],
        default: "cod",
    },
}, { timestamps: true });

module.exports = mongoose.model("SubscriptionPlan", SubscriptionPlanSchema);