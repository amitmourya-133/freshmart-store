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
}, { timestamps: true });

module.exports = mongoose.model("SubscriptionPlan", SubscriptionPlanSchema);