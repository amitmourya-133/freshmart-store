// ===============================
// DEFAULT SUBSCRIPTION PLANS (additive, guarded)
// Inserts the three standard weekly veggie-box plans ONLY when the
// SubscriptionPlan collection is completely empty. It never edits, renames,
// recovers or reprices an existing plan, and it never runs a second time once
// any plan exists — so it is safe to run on every boot (local + Vercel).
// ===============================

const SubscriptionPlan = require("../models/SubscriptionPlan");

const DEFAULT_PLANS = [
    {
        name: "Basic Box",
        description: "Daily essentials for 2 people.",
        pricing: { amount: 499, frequency: "weekly", trialDays: 0 },
        features: ["free_delivery", "all_products", "skip_any_week", "pause_subscription"],
        sortOrder: 1,
    },
    {
        name: "Standard Box",
        description: "Everything for a family of 4.",
        pricing: { amount: 899, frequency: "weekly", trialDays: 0 },
        features: ["free_delivery", "all_products", "extra_fruits", "priority_slots", "skip_any_week", "pause_subscription"],
        sortOrder: 2,
    },
    {
        name: "Family Box",
        description: "For large families & kitchens.",
        pricing: { amount: 1499, frequency: "weekly", trialDays: 0 },
        features: ["free_delivery", "all_products", "extra_fruits", "extra_kg", "customizable_box", "priority_slots", "pause_subscription"],
        sortOrder: 3,
    },
];

// Inserts the defaults only if the collection is empty. Returns { seeded }.
async function seedDefaultSubscriptionPlans() {
    try {
        const count = await SubscriptionPlan.countDocuments();
        if (count > 0) return { seeded: false, reason: "plans_exist" };

        const docs = DEFAULT_PLANS.map(function (p) {
            return {
                name: p.name,
                description: p.description,
                pricing: p.pricing,
                features: p.features,
                isActive: true,
                sortOrder: p.sortOrder,
            };
        });

        // ordered:true + unique name index guarantees no duplicates even if two
        // server instances boot at the same time.
        await SubscriptionPlan.insertMany(docs, { ordered: true });
        return { seeded: true, count: docs.length };
    } catch (error) {
        // Never crash the server because seeding failed; existing admin-created
        // plans remain authoritative.
        return { seeded: false, error: error && error.message };
    }
}

module.exports = { seedDefaultSubscriptionPlans };