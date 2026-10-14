// ===============================
// SUBSCRIPTION 2.0 — VEGGIE BOX FULFILLMENT ENGINE
// A subscription is a recurring, box-based order. Every due cycle:
//   1. The snapshot agreed at subscribe time is re-priced at today's product
//      price (never a client-sent price).
//   2. Stock is reserved atomically per line; a shortfall marks the cycle
//      failed-stock, notifies the customer, and advances to the next cycle
//      (so a single stock outage cannot wedge the schedule).
//   3. A real Order is created (paymentMode from the plan: cod or manual UPI),
//      stock decremented, subscription_renewal event + inbox notification fired.
// Runs under an admin/cron-triggered endpoint with a bounded batch.
// ===============================

const mongoose = require("mongoose");
const Order = require("../models/Order");
const Product = require("../models/Product");
const User = require("../models/User");
const UserSubscription = require("../models/UserSubscription");
const SubscriptionPlan = require("../models/SubscriptionPlan");
const notificationController = require("../controllers/notificationController");
const analytics = require("./analytics");

const FREQ_DAYS = {
    weekly: 7,
    monthly: 30,
    quarterly: 91,
    "half-yearly": 182,
    yearly: 365,
};

function round2(n) {
    return Math.round(n * 100) / 100;
}

function advanceDays(base, days) {
    return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

function orderNumberFor(d) {
    // Collision-safe enough for a bound batch (orderNumber is unique).
    return "FMBOX" + Date.now().toString().slice(-6) + String(d).slice(-3);
}

// Plan → snapshot (used at subscribe time and as a fallback for old subs).
async function snapshotForPlan(plan) {
    const items = Array.isArray(plan.boxItems) && plan.boxItems.length
        ? plan.boxItems
        : [];
    const out = [];
    const products = (await Product.find({ _id: { $in: items.map((i) => i.productId).filter(Boolean) } }).lean());
    const byId = new Map(products.map((p) => [String(p._id), p]));
    for (const it of items) {
        if (!it || !it.productId) continue;
        const prod = byId.get(String(it.productId));
        if (!prod || prod.active === false) continue;
        out.push({
            productId: prod._id,
            name: prod.name,
            unit: it.unit || prod.unit || "kg",
            quantity: Number(it.quantity) || 1,
            price: Number(prod.price) || 0,
        });
    }
    return out;
}

// Try to reserve exactly one box line; returns true/false (atomic, guarded).
async function reserveBoxLine(item) {
    const qty = Number(item.quantity) || 1;
    const res = await Product.updateOne(
        { _id: item.productId, active: true, stock: { $gte: qty } },
        { $inc: { stock: -qty } }
    );
    return !!(res && res.modifiedCount === 1);
}

// ---------------- CRN-02: due-cycle claim + shared stock release -------------
// Two overlapping runs (Vercel cron overlap, cron + manual admin trigger, two
// admin tabs) would otherwise both see the same due subscription, both
// decrement stock and BOTH place an order for the same cycle. The claim is one
// atomic conditional update keyed on the exact nextDeliveryDate we read plus a
// stale-or-empty fulfillingAt: exactly one runner wins, every other runner's
// filter misses. A crashed runner's claim goes stale after CLAIM_TTL_MS and is
// reclaimable, so a crash can neither wedge the schedule nor leave a permanent
// lock. (A crash in the milliseconds between stock reservation and Order.create
// still leaks that reservation - closing it would need a transaction; the
// window is documented rather than papered over.)
const CLAIM_TTL_MS = 10 * 60 * 1000;

async function claimCycle(sub) {
    const token = new Date();
    const res = await UserSubscription.updateOne(
        {
            _id: sub._id,
            status: "active",
            nextDeliveryDate: sub.nextDeliveryDate,
            $or: [
                { fulfillingAt: null },
                { fulfillingAt: { $lt: new Date(token.getTime() - CLAIM_TTL_MS) } },
            ],
        },
        { $set: { fulfillingAt: token } }
    );
    return res && res.matchedCount === 1 ? token : null;
}

// Clear only OUR claim (token-filtered), so we can never release a claim a
// newer run has since taken. Failure self-heals through the stale TTL.
async function releaseCycleClaim(subId, token) {
    try {
        await UserSubscription.updateOne(
            { _id: subId, fulfillingAt: token },
            { $set: { fulfillingAt: null } }
        );
    } catch (e) { /* stale claim self-heals via CLAIM_TTL_MS */ }
}

// Give reserved lines back (shortfall, no-address, or any failure before the
// box exists). Every exit path uses this helper so release behaviour is
// identical everywhere.
async function restoreReserved(lines) {
    for (const line of lines) {
        await Product.updateOne({ _id: line.productId }, { $inc: { stock: Number(line.quantity) || 1 } }).catch(() => {});
    }
}

function intervalDays(plan) {
    return (plan && Number(plan.deliveryEveryDays))
        || (plan && plan.pricing && FREQ_DAYS[plan.pricing.frequency])
        || 7;
}

// Fulfill every due active subscription up to `limit` orders per run.
// Returns a summary; never throws past the batch (each sub is isolated).
async function fulfillDueSubscriptions(limit) {
    const max = Number(limit) > 0 ? Math.min(Number(limit), 50) : 20;
    const due = await UserSubscription.find({
        status: "active",
        nextDeliveryDate: { $lte: new Date() },
    })
        .sort({ nextDeliveryDate: 1 })
        .limit(max)
        .lean();

    const summary = { scanned: due.length, fulfilled: 0, skipped: 0, stockShortfalls: 0, failed: 0, orders: [] };

    for (const sub of due) {
        const claim = await claimCycle(sub);
        if (!claim) continue; // another run owns this cycle (or it changed)

        let plan = null;
        let reserved = []; // stock lines held by THIS run
        let order = null;  // set once the box is placed
        try {
            plan = await SubscriptionPlan.findById(sub.plan).lean();
            if (!plan) throw new Error("subscription plan missing");
            const user = await User.findById(sub.user).lean();
            if (!user) throw new Error("subscriber missing");

            // Snapshot agreed at subscribe time; fall back to the live plan.
            let snapshot = Array.isArray(sub.boxSnapshot) && sub.boxSnapshot.length
                ? sub.boxSnapshot.map((b) => Object.assign({}, b))
                : (await snapshotForPlan(plan));

            if (!snapshot.length) {
                await UserSubscription.updateOne({ _id: sub._id }, {
                    lastAttemptStatus: "failed",
                    lastAttemptAt: new Date(),
                    lastAttemptMessage: "Box has no items",
                });
                summary.skipped++;
                continue;
            }

            // Re-price at today's real product price.
            const pids = snapshot.map((s) => s.productId).filter(Boolean);
            const products = await Product.find({ _id: { $in: pids } }).lean();
            const priceMap = new Map(products.map((p) => [String(p._id), Number(p.price) || 0]));

            const lines = snapshot.map((s) => ({
                name: s.name,
                unit: s.unit || "kg",
                quantity: Number(s.quantity) || 1,
                price: priceMap.get(String(s.productId)) != null ? priceMap.get(String(s.productId)) : Number(s.price) || 0,
                productId: s.productId,
            }));

            // Atomic stock availability + reservation for the whole box.
            let stockOk = true;
            for (const line of lines) {
                if (!line.productId) continue;
                if (!(await reserveBoxLine(line))) { stockOk = false; break; }
                reserved.push(line);
            }
            if (!stockOk) {
                // Release anything reserved so the next cycle can retry fresh.
                await restoreReserved(reserved);
                reserved = [];
                const adv = advanceDays(new Date(sub.nextDeliveryDate), intervalDays(plan));
                await UserSubscription.updateOne({ _id: sub._id }, {
                    nextDeliveryDate: adv,
                    lastAttemptStatus: "stock_shortfall",
                    lastAttemptAt: new Date(),
                    lastAttemptMessage: "One or more box items are out of stock",
                });
                notificationController.notifyBase(sub.user, {
                    type: "subscription",
                    title: "Box on hold — out of stock",
                    message: "We could not pack your " + (plan.name || "box") + " this cycle. You have not been charged. Next attempt " + adv.toISOString().slice(0, 10) + ".",
                    dedupeKey: "subbox:" + String(sub._id) + ":" + adv.toISOString().slice(0, 10),
                    data: { link: "subscription.html" },
                });
                summary.stockShortfalls++;
                continue;
            }

            // Customer block from the account's default address (never invented).
            const address = (user.addresses || []).find((a) => a.isDefault) || (user.addresses || [])[0] || null;
            if (!address) {
                await restoreReserved(reserved);
                reserved = [];
                await UserSubscription.updateOne({ _id: sub._id }, {
                    lastAttemptStatus: "failed",
                    lastAttemptAt: new Date(),
                    lastAttemptMessage: "No delivery address on file",
                });
                summary.failed++;
                continue;
            }

            const subtotal = round2(lines.reduce((s, l) => s + l.price * l.quantity, 0));
            const total = round2(subtotal + 0); // boxes ship free; policy charges only surcharges

            const paymentMode = plan.paymentMode || "cod";
            order = await Order.create({
                orderNumber: orderNumberFor(String(sub._id)),
                customer: {
                    name: user.name || address.name || "Subscriber",
                    phone: user.phone || address.phone || "",
                    address: address.house + (address.street ? ", " + address.street : "") + (address.landmark ? ", " + address.landmark : ""),
                    city: address.city || "",
                    state: address.state || null,
                    pincode: address.pincode || "",
                },
                items: lines.map((l) => ({ name: l.name, price: l.price, quantity: l.quantity, productId: l.productId })),
                payment: paymentMode === "cod" ? "Cash On Delivery" : "UPI - Online",
                paymentMethod: paymentMode === "cod" ? "cod" : "online",
                paymentMode: paymentMode,
                subtotal: subtotal,
                delivery: 0,
                discount: 0,
                total: total,
                status: "Placed",
                user: sub.user,
                customerEmail: user.email || null,
                subscription: true,
                subscriptionPlan: (plan && plan.name) || null,
                statusHistory: [{ status: "Placed", by: "system:subscription-box", at: new Date() }],
            });

            // Schedule-critical advance: the box exists, so the cycle MUST move
            // forward or the next run would duplicate it. Keyed on the
            // nextDeliveryDate we read, so it can ever apply only once.
            const adv = advanceDays(new Date(sub.nextDeliveryDate), intervalDays(plan));
            const advanceDoc = {
                nextDeliveryDate: adv,
                fulfilledCount: (Number(sub.fulfilledCount) || 0) + 1,
                lastFulfilledAt: new Date(),
                lastAttemptStatus: "ok",
                lastAttemptAt: new Date(),
                lastAttemptMessage: null,
                $push: { paymentHistory: { amount: round2(total), date: new Date(), status: "pending", transactionId: String(order._id) } },
            };
            let advanced = false;
            try {
                const r1 = await UserSubscription.updateOne(
                    { _id: sub._id, nextDeliveryDate: sub.nextDeliveryDate },
                    advanceDoc
                );
                advanced = !!(r1 && r1.matchedCount === 1);
            } catch (e) {
                advanced = false;
            }
            if (!advanced) {
                // Transient failure: one retry from the same base. The date
                // filter keeps the retry from ever applying twice.
                await UserSubscription.updateOne(
                    { _id: sub._id, nextDeliveryDate: sub.nextDeliveryDate },
                    advanceDoc
                );
            }

            // Analytics + notification are observability, not the cycle: they
            // must never bubble into the catch below (which would see an
            // existing order and treat a finished cycle as a failure).
            try {
                analytics.track({
                    eventName: "subscription_renewal",
                    userId: sub.user,
                    orderId: String(order._id),
                    metadata: {
                        plan: (plan && plan.name) || null,
                        amount: total,
                        cycleIndex: (Number(sub.fulfilledCount) || 0) + 1,
                    },
                });
            } catch (e) { /* non-fatal */ }
            try {
                notificationController.notifyBase(sub.user, {
                    type: "subscription",
                    title: "Your box is packed",
                    message: "Cycle " + ((Number(sub.fulfilledCount) || 0) + 1) + " of " + (plan.name || "your box") + " (₹" + total + ") is placed. Next: " + adv.toISOString().slice(0, 10) + ".",
                    dedupeKey: "subbox:" + String(sub._id) + ":" + String(order._id),
                    data: { link: "orders.html", orderId: String(order._id) },
                });
            } catch (e) { /* non-fatal */ }

            summary.fulfilled++;
            summary.orders.push({ orderId: String(order._id), orderNumber: order.orderNumber, total });
        } catch (err) {
            if (order) {
                // The box exists and its stock is correctly consumed. The only
                // thing that matters is advancing the schedule - never mark the
                // cycle failed when a real order is already out the door.
                try {
                    const adv2 = advanceDays(new Date(sub.nextDeliveryDate), intervalDays(plan));
                    await UserSubscription.updateOne(
                        { _id: sub._id, nextDeliveryDate: sub.nextDeliveryDate },
                        {
                            nextDeliveryDate: adv2,
                            fulfilledCount: (Number(sub.fulfilledCount) || 0) + 1,
                            lastFulfilledAt: new Date(),
                            lastAttemptStatus: "ok",
                            lastAttemptAt: new Date(),
                            lastAttemptMessage: null,
                            $push: { paymentHistory: { amount: round2(order.total), date: new Date(), status: "pending", transactionId: String(order._id) } },
                        }
                    );
                } catch (e2) {
                    console.warn("[subscription] schedule advance failed for sub " + sub._id + ": " + (e2 && e2.message ? e2.message : "unknown"));
                }
                summary.fulfilled++;
                summary.orders.push({ orderId: String(order._id), orderNumber: order.orderNumber, total: order.total });
                console.warn("[subscription] post-create error (order kept, schedule retried): " + (err && err.message ? err.message : "unknown") + " (sub " + sub._id + ")");
            } else {
                // Nothing was placed: give every held line back. The old code
                // released only on its two explicit exits, so an Order.create
                // failure (duplicate orderNumber, validation) silently leaked
                // every reservation in `reserved`.
                await restoreReserved(reserved);
                reserved = [];
                if (plan) {
                    try {
                        await UserSubscription.updateOne({ _id: sub._id }, {
                            lastAttemptStatus: "failed",
                            lastAttemptAt: new Date(),
                            lastAttemptMessage: (err && err.message) || "fulfillment error",
                        });
                    } catch (e2) { /* non-fatal */ }
                }
                console.warn("[subscription] cycle failed: " + (err && err.message ? err.message : "unknown") + " (sub " + sub._id + ")");
                summary.failed++;
            }
        } finally {
            await releaseCycleClaim(sub._id, claim);
        }
    }
    return summary;
}

module.exports = { fulfillDueSubscriptions, snapshotForPlan, FREQ_DAYS };