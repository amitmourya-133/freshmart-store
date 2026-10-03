// ===============================
// DELIVERY OPERATIONS CONTROLLER
// The coordination layer between a placed order and the delivery boy who
// actually carries it (Phases 1-6):
//
//   Phase 1  partner application + admin approval (partnerStatus/role)
//   Phase 2  broadcast offer to every online partner + first-come claim
//   Phase 3  Mongo-backed push (see pushController) used by every notify
//   Phase 4  auto-assign the nearest partner when an offer goes unclaimed
//   Phase 5  OTP re-issue, cash confirmation, signature, history
//   Phase 6  day-end COD reconciliation + partner metrics
//
// Design rules:
//  * An offer only ever advertises an order that really exists.
//  * Exactly ONE assignment can win a claim (atomic offer update).
//  * Nothing here trusts the client: money, distance and identity are derived
//    server-side from the order, the partner record and real GPS pings.
//  * Every fan-out (in-app + Web Push) is best-effort and never blocks or
//    fails the order that triggered it.
// ===============================

const mongoose = require("mongoose");
const { safeErrorMessage } = require("../utils/safeError");
const User = require("../models/User");
const Order = require("../models/Order");
const DeliveryAssignment = require("../models/DeliveryAssignment");
const DeliveryOffer = require("../models/DeliveryOffer");
const Settings = require("../models/Settings");
const notificationController = require("./notificationController");
const pushController = require("./pushController");
const emailService = require("../utils/emailService");
const { haversineKm } = require("../utils/geo");
const { generateOtp, hashOtp } = require("../utils/otp");

const DELIVERY_OTP_TTL_MS = 15 * 60 * 1000; // 15 minutes
const OTP_REISSUE_COOLDOWN_MS = 3 * 60 * 1000; // 3 minutes between re-issues
const MAX_SIGNATURE_BYTES = 300 * 1024;

// The one and only definition of "this delivery run is still live". Used by
// every query, by the auto-dispatch guards and mirrored by the partial unique
// index in models/DeliveryAssignment.js, so the code and the database can never
// disagree about which statuses block a second partner.
const ACTIVE_STATUSES = ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"];

// Structured delivery events. One grep-able line per meaningful transition, so
// an operator can answer "who got this order and when" from the function logs
// alone. Deliberately carries NO secrets and NO customer PII: ids and order
// numbers only, never names, phones, addresses, tokens or push endpoints.
const DELIVERY_EVENTS = [
    "ORDER_CREATED",
    "AUTO_DISPATCH_STARTED",
    "OFFER_CREATED",
    "OFFER_PUSH_SENT",
    "OFFER_PUSH_FAILED",
    "OFFER_ACCEPT_ATTEMPT",
    "ORDER_ASSIGNED",
    "OFFER_WON",
    "OFFER_LOST",
    "OFFER_EXPIRED",
    "AUTO_DISPATCH_RETRY",
    "AUTO_DISPATCH_SKIPPED",
];

function logDeliveryEvent(name, fields) {
    if (DELIVERY_EVENTS.indexOf(name) === -1) name = "AUTO_DISPATCH_SKIPPED";
    let line = "[delivery-event] " + name;
    try {
        const keys = Object.keys(fields || {}).sort();
        for (const k of keys) {
            const v = fields[k];
            if (v === undefined || v === null || v === "") continue;
            line += " " + k + "=" + String(v).slice(0, 80).replace(/\s+/g, " ");
        }
    } catch (e) { /* never let logging break a delivery */ }
    console.log(line);
}

function isValidObjectId(id) {
    return mongoose.Types.ObjectId.isValid(String(id || ""));
}

function idOf(v) {
    return v ? String(v._id || v) : "";
}

// Distance in km from a partner's last real GPS ping to a delivery point.
// Returns null when either side has no usable coordinate - never fabricates 0.
function distanceKm(partner, order) {
    const pLat = Number(partner && partner.lastLat);
    const pLng = Number(partner && partner.lastLng);
    const loc = order && order.deliveryLocation;
    const dLat = Number(loc && loc.latitude);
    const dLng = Number(loc && loc.longitude);
    if (![pLat, pLng, dLat, dLng].every(function (n) { return Number.isFinite(n); })) return null;
    if (pLat === 0 && pLng === 0) return null;
    return Math.round(haversineKm(pLat, pLng, dLat, dLng) * 100) / 100;
}

// A partner may be auto-dispatched to only when their last GPS ping is still
// inside the configured freshness window (settings.deliveryStaleMinutes, the
// same window the admin "online" view uses). Manual claiming never requires it.
function hasFreshLocation(partner, staleMinutes) {
    const lat = Number(partner && partner.lastLat);
    const lng = Number(partner && partner.lastLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
    if (lat === 0 && lng === 0) return false;
    const at = partner.lastLocationAt ? new Date(partner.lastLocationAt).getTime() : 0;
    if (!at) return false;
    const minutes = Number(staleMinutes) > 0 ? Number(staleMinutes) : 15;
    return Date.now() - at <= minutes * 60 * 1000;
}

async function logWarn(tag, e) {
    console.warn("[" + tag + "] " + ((e && e.message) || "unknown"));
}

// ===============================
// ELIGIBLE PARTNERS (one source of truth)
// ===============================

// The single definition of "who may be offered this order right now", reused by
// the broadcast, the auto-assigner and the accept path so those three can never
// disagree about eligibility. A partner qualifies only when ALL of these hold:
//   * role === "delivery"                          - delivery role, read from the DB
//   * partnerStatus === "approved"                 - not pending / rejected / revoked
//   * isAvailable === true                         - not on a break
//   * holds no OTHER active assignment             - not overloaded
//   * holds no active assignment for THIS order    - never offered twice
// `requireFreshLocation` additionally demands a GPS ping inside the stale
// window and is used by the auto-assigner, which must not dispatch a partner it
// cannot locate. Manual claiming never requires it: a partner who never shares
// location may still accept by hand.
//
// A valid push subscription is deliberately NOT a filter: a partner without one
// is still a real, reachable partner (they see the offer in their panel), and
// dropping them would strand the order whenever a browser permission lapses.
async function getAvailableDeliveryPartners(opts) {
    const options = opts || {};
    const orderId = options.orderId || null;
    const requireFreshLocation = Boolean(options.requireFreshLocation);

    const partners = await User.find({
        role: "delivery",
        partnerStatus: "approved",
        isAvailable: true,
    })
        .select("_id name email zone lastLat lastLng lastLocationAt isAvailable partnerStatus role")
        .lean();
    if (!partners.length) return [];

    const or = [{ deliveryUser: { $in: partners.map(function (p) { return p._id; }) } }];
    if (orderId) or.push({ order: orderId });
    const busy = await DeliveryAssignment.find({
        status: { $in: ACTIVE_STATUSES },
        $or: or,
    })
        .select("deliveryUser order")
        .lean();

    const busyIds = new Set(busy.map(function (a) { return String(a.deliveryUser); }));
    let pool = partners.filter(function (p) { return !busyIds.has(String(p._id)); });
    if (!pool.length) return [];

    if (requireFreshLocation) {
        let staleMinutes = 15;
        try {
            const s = await Settings.getSettings();
            staleMinutes = Number(s.deliveryStaleMinutes) || 15;
        } catch (e) { /* keep the default window */ }
        pool = pool.filter(function (p) { return hasFreshLocation(p, staleMinutes); });
    }
    return pool;
}

// ===============================
// ASSIGNMENT CREATION (shared)
// ===============================

// Create the assignment for an order, mint the delivery OTP and tell BOTH
// sides. `mode` records how it happened (admin click / claim / auto).
// Returns the saved assignment, or null when one already exists.
// Create the assignment for an order, mint the delivery OTP and tell BOTH
// sides. `mode` records how it happened (admin click / claim / auto).
// Returns a RESULT object ({ok, reason, assignment}) so callers can tell
// "somebody else already won this order" apart from a real failure.
async function createAssignmentResult(opts) {
    const { order, partner, byUserId, mode, distanceKmValue } = opts;

    // A closed order can never accept a new delivery run: an admin force-assign
    // or auto-assign retry must fail instead of resurrecting a completed order.
    if (!order || order.status === "Delivered" || order.status === "Cancelled") {
        return { ok: false, reason: "ORDER_CLOSED", assignment: null };
    }

    // Advisory fast path only. The AUTHORITATIVE guard is the partial unique
    // index one_active_assignment_per_order, which MongoDB evaluates inside the
    // insert below: two partners pressing Accept in the same millisecond both
    // pass this read, and only the index can stop the second one.
    const existing = await DeliveryAssignment.findOne({
        order: order._id,
        status: { $in: ACTIVE_STATUSES },
    });
    if (existing) {
        return { ok: false, reason: "ORDER_ALREADY_ASSIGNED", assignment: null, winner: existing };
    }

    const otp = generateOtp(4);
    const assignment = new DeliveryAssignment({
        order: order._id,
        deliveryUser: partner._id,
        assignedBy: byUserId || partner._id,
        status: "ASSIGNED",
        assignMode: mode || "admin",
        otpHash: hashOtp(otp),
        otpExpiry: new Date(Date.now() + DELIVERY_OTP_TTL_MS),
        otpIssuedAt: new Date(),
        otpAttempts: 0,
    });
    if (Number.isFinite(Number(distanceKmValue))) assignment.distanceKm = Number(distanceKmValue);

    try {
        await assignment.save();
    } catch (e) {
        // 11000 == the unique index refused a SECOND active assignment for this
        // order: a partner claim and an auto-assign (or two partners) raced and
        // somebody else won. That is a normal first-accept-wins outcome, never a
        // failure to retry, so it is reported as a lost race, not a 500.
        if (e && e.code === 11000) {
            const winner = await DeliveryAssignment.findOne({
                order: order._id,
                status: { $in: ACTIVE_STATUSES },
            });
            logDeliveryEvent("OFFER_LOST", {
                orderId: String(order._id),
                partnerId: String(partner && partner._id),
                mode: mode || "admin",
                reason: "ORDER_ALREADY_ASSIGNED",
            });
            return { ok: false, reason: "ORDER_ALREADY_ASSIGNED", assignment: null, winner: winner };
        }
        throw e;
    }

    // The customer proves the drop with this OTP. Email only; the plain value
    // is never stored.
    try {
        if (order.customerEmail) {
            await emailService.sendOtpEmail({ to: order.customerEmail, otp: otp, purpose: "delivery OTP" });
        }
    } catch (e) {
        await logWarn("delivery-otp-email", e);
    }

    // Partner heads-up (email is best-effort; the in-app alert is the real one).
    try {
        if (partner.email) {
            await emailService.sendDeliveryAssignment({
                to: partner.email,
                order: order,
                partnerName: partner.name,
            });
        }
    } catch (e) {
        await logWarn("delivery-assign-email", e);
    }

    const orderLabel = order.orderNumber || String(order._id);
    try {
        await notificationController.notifyBase(assignment.deliveryUser, {
            type: "delivery_assignment",
            title: "New delivery assigned",
            message: "Order " + orderLabel + " is assigned to you. OTP required at delivery.",
            dedupeKey: "delivery_assignment:" + String(order._id),
            data: { link: "delivery.html", orderId: String(order._id), assignmentId: String(assignment._id) },
        });
    } catch (e) {
        await logWarn("delivery-assign-notify", e);
    }
    try {
        if (order.user) {
            await notificationController.notifyBase(order.user, {
                type: "order_status",
                title: "Delivery partner assigned",
                message: "A delivery partner is picking up order " + orderLabel + ".",
                dedupeKey: "order_inbox:" + String(order._id) + ":status:Assignment",
                data: { link: "orders.html", orderId: String(order._id), orderNumber: orderLabel },
            });
        }
    } catch (e) {
        await logWarn("delivery-assign-notify-customer", e);
    }

    logDeliveryEvent("ORDER_ASSIGNED", {
        orderId: String(order._id),
        orderNumber: order.orderNumber || "",
        partnerId: String(partner._id),
        mode: mode || "admin",
        distanceKm: Number.isFinite(Number(distanceKmValue)) ? Number(distanceKmValue) : "",
    });

    return { ok: true, assignment: assignment, reason: null };
}

// Back-compat wrapper for the existing admin force-assign / auto-assign callers:
// the saved assignment, or null when the order is closed or already taken.
async function createAssignment(opts) {
    const result = await createAssignmentResult(opts);
    return result.ok ? result.assignment : null;
}

// ===============================
// PHASE 2: BROADCAST A NEW ORDER
// ===============================

// Alert every approved + online partner about a freshly placed order and open
// a claim window. Called from the order controller right after the order is
// persisted; never awaited by the checkout response.
//
// IDEMPOTENT: dispatch may fire more than once for the same order (duplicate
// checkout retry, the order controller plus a manual re-alert, the auto-retry
// sweep). It returns early when a live OPEN offer already exists, and if two
// callers still race past that check, the loser cancels its own offer - so one
// order can never accumulate two competing open offers.
async function broadcastNewOrder(order, opts) {
    const options = opts || {};
    try {
        if (!order || !order._id) return { broadcast: false, reason: "no order" };

        // A closed order must never be offered for delivery again: neither a
        // fresh broadcast nor an admin rebroadcast may resurrect it.
        if (order.status === "Delivered" || order.status === "Cancelled") {
            return { broadcast: false, reason: "order closed" };
        }

        const settings = await Settings.getSettings();
        if (!settings.deliveryBroadcastEnabled) {
            return { broadcast: false, reason: "broadcast disabled" };
        }

        // An order that is already assigned needs no broadcast.
        const assigned = await DeliveryAssignment.findOne({
            order: order._id,
            status: { $in: ACTIVE_STATUSES },
        }).select("_id");
        if (assigned) {
            logDeliveryEvent("AUTO_DISPATCH_SKIPPED", { orderId: String(order._id), reason: "ALREADY_ASSIGNED" });
            return { broadcast: false, reason: "already assigned" };
        }

        // Idempotency guard: a claim window for this order is already live.
        const liveOffer = await DeliveryOffer.findOne({
            order: order._id,
            status: "OPEN",
            expiresAt: { $gt: new Date() },
        })
            .select("_id round expiresAt")
            .lean();
        if (liveOffer) {
            logDeliveryEvent("AUTO_DISPATCH_SKIPPED", {
                orderId: String(order._id),
                offerId: String(liveOffer._id),
                round: liveOffer.round,
                reason: "DUPLICATE_DISPATCH",
            });
            return { broadcast: false, reason: "already dispatched", offerId: String(liveOffer._id), round: liveOffer.round };
        }

        const candidates = await getAvailableDeliveryPartners({ orderId: order._id });

        if (!candidates.length) {
            // Distinguish "the fleet is empty" from "somebody just won this
            // order while we were looking": the second case must never page an
            // admin to assign a delivery that already has a partner.
            const won = await DeliveryAssignment.findOne({
                order: order._id,
                status: { $in: ACTIVE_STATUSES },
            })
                .select("_id")
                .lean();
            if (won) {
                logDeliveryEvent("AUTO_DISPATCH_SKIPPED", { orderId: String(order._id), reason: "ALREADY_ASSIGNED" });
                return { broadcast: false, reason: "already assigned" };
            }
            // Nobody online: the admin must assign by hand. Tell them loudly.
            try {
                await notificationController.notifyRole("admin", {
                    type: "delivery_unattended",
                    title: "No delivery partner online",
                    message: "Order " + (order.orderNumber || "") + " has no online partner. Assign it manually.",
                    data: { link: "admin.html", orderId: String(order._id) },
                });
                await pushController.sendPushToAdmins(
                    "No partner online",
                    "Assign order " + (order.orderNumber || "") + " manually.",
                    "/admin.html"
                );
            } catch (e) {
                await logWarn("broadcast-admin-alert", e);
            }
            logDeliveryEvent("AUTO_DISPATCH_SKIPPED", { orderId: String(order._id), reason: "NO_AVAILABLE_PARTNER" });
            return { broadcast: false, reason: "no online partner", candidates: 0 };
        }

        const ttl = Number(settings.deliveryOfferTtlSeconds) || 90;
        const lastRound = await DeliveryOffer.findOne({ order: order._id }).sort({ round: -1 }).select("round").lean();
        // Auto-assign gets its own deadline inside the claim window so partners
        // always get a grace period to claim on their own first.
        const autoDelay = Math.min(Number(settings.deliveryAutoAssignDelaySeconds) || 0, ttl);
        const round = (lastRound && Number(lastRound.round) ? Number(lastRound.round) : 0) + 1;

        logDeliveryEvent("AUTO_DISPATCH_STARTED", {
            orderId: String(order._id),
            orderNumber: order.orderNumber || "",
            partners: candidates.length,
            round: round,
            ttlSeconds: ttl,
            trigger: options.trigger || "order_created",
        });

        const offer = await DeliveryOffer.create({
            order: order._id,
            round: round,
            status: "OPEN",
            mode: "broadcast",
            ttlSeconds: ttl,
            expiresAt: new Date(Date.now() + ttl * 1000),
            autoAssignAt: settings.deliveryAutoAssign ? new Date(Date.now() + autoDelay * 1000) : null,
            zone: order.deliveryLocation && order.deliveryLocation.city ? String(order.deliveryLocation.city) : "",
        });

        // Two dispatch calls that raced past the idempotency guard would both
        // have created an offer for this order. The one with the LOWER _id keeps
        // the claim window and the other cancels itself at once, so a partner can
        // never see two competing live offers for the same order.
        const rival = await DeliveryOffer.findOne({
            order: order._id,
            status: "OPEN",
            _id: { $lt: offer._id },
            expiresAt: { $gt: new Date() },
        })
            .select("_id")
            .lean();
        if (rival) {
            await DeliveryOffer.updateOne(
                { _id: offer._id, status: "OPEN" },
                { $set: { status: "CANCELLED", claimSource: "raced" } }
            );
            logDeliveryEvent("AUTO_DISPATCH_SKIPPED", {
                orderId: String(order._id),
                offerId: String(offer._id),
                reason: "DUPLICATE_DISPATCH",
            });
            return { broadcast: false, reason: "duplicate dispatch", offerId: String(rival._id), round: round };
        }

        logDeliveryEvent("OFFER_CREATED", {
            orderId: String(order._id),
            orderNumber: order.orderNumber || "",
            offerId: String(offer._id),
            round: round,
            partners: candidates.length,
            expiresAt: new Date(offer.expiresAt).toISOString(),
        });

        const orderLabel = order.orderNumber || String(order._id);
        const amount = Number(order.total) || 0;
        let inApp = 0;
        let push = 0;

        for (const partner of candidates) {
            const km = distanceKm(partner, order);
            const near = Number.isFinite(km) ? " · " + km + " km away" : "";
            const entry = { user: partner._id, at: new Date(), inApp: false, push: false };
            try {
                // push:false - the single Web Push fan-out below alerts the whole
                // fleet at once. Mirroring here too would double-ring every phone.
                await notificationController.notifyBase(partner._id, {
                    type: "delivery_offer",
                    title: "New FreshMart Delivery",
                    message: "Order #" + orderLabel + " is ready for pickup · ₹" + amount + near + " · accept in " + ttl + "s",
                    dedupeKey: "delivery_offer:" + String(offer._id) + ":" + String(partner._id),
                    push: false,
                    data: {
                        link: "delivery.html",
                        offerId: String(offer._id),
                        orderId: String(order._id),
                        orderNumber: orderLabel,
                        action: "ACCEPT_ORDER",
                    },
                });
                entry.inApp = true;
                inApp += 1;
            } catch (e) {
                await logWarn("offer-inapp", e);
            }
            offer.notified.push(entry);
        }

        // One Web Push fan-out for the whole fleet (each partner's own
        // subscriptions), so every partner's Chrome alerts at the same moment.
        try {
            const res = await pushController.sendPushToUsers(
                candidates.map(function (c) { return c._id; }),
                "New FreshMart Delivery",
                "Order #" + orderLabel + " is ready for pickup.",
                "/delivery.html",
                {
                    tag: "delivery-offer-" + String(offer._id),
                    requireInteraction: true,
                    vibrate: [220, 110, 220, 110, 420],
                    // Actionable from the lock screen: the payload tells the
                    // service worker which offer this is, so tapping the
                    // notification lands the partner on that exact ACCEPT button
                    // instead of a generic dashboard.
                    data: {
                        action: "ACCEPT_ORDER",
                        offerId: String(offer._id),
                        orderId: String(order._id),
                        orderNumber: orderLabel,
                        link: "delivery.html",
                    },
                }
            );
            push = res.sent;
            if (Array.isArray(res.pushed) && res.pushed.length) {
                const pushedIds = new Set(res.pushed);
                for (const entry of offer.notified) {
                    // Mark as pushed only for the partners whose own browser
                    // actually received it, so the admin audit stays honest.
                    if (pushedIds.has(String(entry.user))) entry.push = true;
                }
            }
            if (res.sent > 0) {
                logDeliveryEvent("OFFER_PUSH_SENT", {
                    offerId: String(offer._id),
                    orderId: String(order._id),
                    recipients: res.recipients || 0,
                    subscriptions: res.sent,
                    failed: res.failed,
                    deactivated: res.deactivated,
                });
            } else {
                // No live browser subscription is NOT a dispatch failure: the
                // in-app notification already reached every partner and the offer
                // stays claimable from their panel. Dead endpoints were already
                // deactivated by pushController (404/410).
                logDeliveryEvent("OFFER_PUSH_FAILED", {
                    offerId: String(offer._id),
                    orderId: String(order._id),
                    recipients: 0,
                    subscriptions: 0,
                    deactivated: res.deactivated,
                    reason: res.deactivated > 0 ? "SUBSCRIPTION_GONE" : "NO_ACTIVE_SUBSCRIPTION",
                });
            }
        } catch (e) {
            await logWarn("offer-push", e);
            logDeliveryEvent("OFFER_PUSH_FAILED", {
                offerId: String(offer._id),
                orderId: String(order._id),
                reason: "PUSH_ERROR",
            });
        }

        await offer.save();
        return {
            broadcast: true,
            offerId: String(offer._id),
            round: round,
            partners: candidates.length,
            inApp: inApp,
            push: push,
            ttlSeconds: ttl,
        };
    } catch (e) {
        await logWarn("broadcast-new-order", e);
        return { broadcast: false, reason: "error" };
    }
}

// ===============================
// PHASE 4: EXPIRY SWEEP / AUTO-ASSIGN
// ===============================

// On serverless there is no reliable in-process timer, so the sweep runs from
// three places: the scheduled cron route, the partner/admin dashboards, and
// right after a new order is broadcast. It is safe to run concurrently because
// each offer is locked with an atomic `expiresHandledAt` write.
async function sweepExpiredOffers(limit) {
    const out = { swept: 0, autoAssigned: 0, escalated: 0, retried: 0 };
    try {
        const settings = await Settings.getSettings();
        const now = new Date();
        const max = Number(limit) > 0 ? Number(limit) : 20;
        const candidates = await DeliveryOffer.find({
            status: "OPEN",
            expiresHandledAt: null,
            $or: [
                { expiresAt: { $lte: now } },
                ...(settings.deliveryAutoAssign ? [{ autoAssignAt: { $lte: now } }] : []),
            ],
        })
            .sort({ expiresAt: 1 })
            .limit(max)
            .populate("order", "orderNumber total user deliveryLocation");

        for (const offer of candidates) {
            // Lock first so a concurrent sweep cannot double-handle the offer.
            const locked = await DeliveryOffer.findOneAndUpdate(
                { _id: offer._id, status: "OPEN", expiresHandledAt: null },
                { $set: { expiresHandledAt: new Date() } },
                { new: true }
            );
            if (!locked) continue;
            out.swept += 1;

            const order = offer.order;
            if (!order) {
                await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { status: "CANCELLED" } });
                continue;
            }

            const windowClosed = new Date(offer.expiresAt).getTime() <= now.getTime();
            const autoDue = Boolean(settings.deliveryAutoAssign && offer.autoAssignAt && new Date(offer.autoAssignAt).getTime() <= now.getTime());

            if (autoDue || (settings.deliveryAutoAssign && windowClosed)) {
                // Auto-dispatch only to a partner whose GPS ping is still fresh.
                const partner = await pickNearestOnlinePartner(order, true);
                if (partner) {
                    const km = distanceKm(partner, order);
                    const created = await createAssignmentResult({
                        order: order,
                        partner: partner,
                        byUserId: null,
                        mode: "auto",
                        distanceKmValue: km,
                    });
                    if (created.ok) {
                        const assignment = created.assignment;
                        await DeliveryOffer.updateOne(
                            { _id: offer._id },
                            {
                                $set: {
                                    status: "ASSIGNED",
                                    claimedBy: partner._id,
                                    claimedAt: new Date(),
                                    claimSource: "auto",
                                    assignment: assignment._id,
                                    distanceKm: Number.isFinite(km) ? km : null,
                                },
                            }
                        );
                        notifyOfferClosed(offer, partner, order).catch(function () { /* non-fatal */ });
                        logDeliveryEvent("OFFER_WON", {
                            offerId: String(offer._id),
                            orderId: String(order._id),
                            partnerId: String(partner._id),
                            claimSource: "auto",
                        });
                        out.autoAssigned += 1;
                        continue;
                    }
                    // The dispatch lost the race (E11000 from the unique index, or
                    // the order was already assigned): close the offer instead of
                    // re-opening it, so the order never keeps being offered to
                    // partners it is already assigned to, and closed orders never
                    // re-enter the pipeline.
                    if (created.reason === "ORDER_ALREADY_ASSIGNED" || created.reason === "ORDER_CLOSED") {
                        await DeliveryOffer.updateOne(
                            { _id: offer._id },
                            { $set: { status: "CANCELLED", claimSource: "raced" } }
                        );
                        continue;
                    }
                }
                if (!windowClosed) {
                    // Grace period elapsed but nobody is free yet: keep the offer
                    // open and try again on the next sweep.
                    await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { expiresHandledAt: null } });
                    out.retried += 1;
                    continue;
                }
            }

            // The claim window closed with nobody claiming it. Before bothering a
            // human, re-check the fleet and broadcast a fresh round - but only
            // while the order is still inside its bounded round budget, so a
            // single unservable address can never re-ring every partner's phone
            // forever. Past the budget the order escalates to the admin.
            const maxRounds = Math.min(Number(settings.deliveryMaxDispatchRounds) || 3, 5);
            const usedRounds = Number(offer.round) || 1;
            if (usedRounds < maxRounds) {
                const stillOpen = await DeliveryAssignment.findOne({
                    order: order._id,
                    status: { $in: ACTIVE_STATUSES },
                })
                    .select("_id")
                    .lean();
                if (stillOpen) {
                    // A partner won it in the meantime: nothing left to retry.
                    await DeliveryOffer.updateOne(
                        { _id: offer._id },
                        { $set: { status: "CANCELLED", claimSource: "raced" } }
                    );
                    continue;
                }
                const retry = await broadcastNewOrder(order, { trigger: "auto_retry" });
                out.retried += 1;
                logDeliveryEvent("AUTO_DISPATCH_RETRY", {
                    orderId: String(order._id),
                    orderNumber: order.orderNumber || "",
                    offerId: String(offer._id),
                    round: usedRounds,
                    nextRound: usedRounds + 1,
                    maxRounds: maxRounds,
                    result: retry && retry.broadcast ? "re-broadcast" : String((retry && retry.reason) || "skipped"),
                });
                // The retry either opened a new claim window or decided it could
                // not; either way this offer is finished.
                await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { status: "EXPIRED" } });
                continue;
            }

            // Round budget spent: escalate to the admin so no order is ever
            // silently stranded.
            await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { status: "EXPIRED" } });
            out.escalated += 1;
            logDeliveryEvent("OFFER_EXPIRED", {
                offerId: String(offer._id),
                orderId: String(order._id),
                orderNumber: order.orderNumber || "",
                round: usedRounds,
                maxRounds: maxRounds,
                outcome: "ESCALATED",
            });
            try {
                await notificationController.notifyRole("admin", {
                    type: "delivery_unclaimed",
                    title: "Delivery not claimed",
                    message: "Order " + (order.orderNumber || "") + " was not accepted by any partner. Assign it manually.",
                    data: { link: "admin.html", orderId: String(order._id), offerId: String(offer._id) },
                });
                await pushController.sendPushToAdmins(
                    "Delivery not claimed",
                    "Order " + (order.orderNumber || "") + " needs a partner.",
                    "/admin.html",
                    { tag: "unclaimed-" + String(order._id), requireInteraction: true }
                );
            } catch (e) {
                await logWarn("sweep-escalate", e);
            }
        }
        return out;
    } catch (e) {
        await logWarn("sweep-offers", e);
        return out;
    }
}

// Nearest approved + online partner that has sent a GPS ping inside the
// configured freshness window. Eligibility comes from the shared
// getAvailableDeliveryPartners() so this auto-picker can never hand an order to
// somebody the broadcast would have considered ineligible.
async function pickNearestOnlinePartner(order, requireFreshLocation) {
    const candidates = await getAvailableDeliveryPartners({
        orderId: order ? order._id : null,
        requireFreshLocation: requireFreshLocation,
    });
    if (!candidates.length) return null;

    const ranked = candidates
        .map(function (c) { return { partner: c, km: distanceKm(c, order) }; })
        .sort(function (a, b) {
            const ak = Number.isFinite(a.km) ? a.km : Number.MAX_SAFE_INTEGER;
            const bk = Number.isFinite(b.km) ? b.km : Number.MAX_SAFE_INTEGER;
            return ak - bk;
        });
    return ranked.length ? ranked[0].partner : null;
}

// ===============================
// PHASE 1: PARTNER APPLICATION
// ===============================

// POST /api/delivery-ops/apply - a customer applies to become a partner.
exports.applyAsPartner = async (req, res) => {
    try {
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        if (user.role === "delivery" && user.partnerStatus === "approved") {
            return res.status(400).json({ success: false, message: "You are already an approved delivery partner." });
        }
        if (user.partnerStatus === "pending") {
            return res.status(400).json({ success: false, message: "Your application is already under review." });
        }
        if (!user.phone) {
            return res.status(400).json({ success: false, message: "Add your phone number before applying - customers need it on delivery." });
        }

        user.partnerStatus = "pending";
        user.partnerAppliedAt = new Date();
        user.partnerReviewedAt = null;
        user.partnerReviewedBy = null;
        user.partnerRejectReason = null;
        if (req.body.vehicleType) user.vehicleType = String(req.body.vehicleType).slice(0, 40);
        if (req.body.zone) user.zone = String(req.body.zone).slice(0, 60);
        await user.save();

        try {
            await notificationController.notifyRole("admin", {
                type: "partner_application",
                title: "New delivery partner application",
                message: (user.name || user.email) + " applied to join as a delivery partner.",
                data: { link: "admin.html", userId: String(user._id) },
            });
            await pushController.sendPushToAdmins(
                "New partner application",
                (user.name || "A user") + " wants to deliver.",
                "/admin.html"
            );
        } catch (e) {
            await logWarn("partner-apply-admin-notify", e);
        }

        return res.json({ success: true, message: "Application submitted. An admin will review it.", partnerStatus: user.partnerStatus });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/delivery-ops/me - my partner status + today's performance.
exports.myPartnerStatus = async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select(
            "name email phone role partnerStatus partnerAppliedAt partnerReviewedAt partnerRejectReason vehicleType zone breakReason isAvailable lastLat lastLng lastLocationAt rating ratingCount deliveryCount"
        ).lean();
        if (!user) return res.status(404).json({ success: false, message: "User not found" });

        const settings = await Settings.getSettings();
        const staleMs = (Number(settings.deliveryStaleMinutes) || 15) * 60 * 1000;
        const lastAt = user.lastLocationAt ? new Date(user.lastLocationAt).getTime() : 0;
        const online = Boolean(user.isAvailable) && lastAt > 0 && Date.now() - lastAt < staleMs;

        const [active, delivered, openOffers] = await Promise.all([
            DeliveryAssignment.countDocuments({ deliveryUser: user._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } }),
            DeliveryAssignment.countDocuments({ deliveryUser: user._id, status: "DELIVERED" }),
            DeliveryOffer.countDocuments({ status: "OPEN", expiresAt: { $gt: new Date() }, notified: { $elemMatch: { user: user._id } } }),
        ]);

        return res.json({
            success: true,
            partner: {
                role: user.role,
                partnerStatus: user.partnerStatus,
                appliedAt: user.partnerAppliedAt,
                reviewedAt: user.partnerReviewedAt,
                rejectReason: user.partnerRejectReason,
                vehicleType: user.vehicleType,
                zone: user.zone,
                isAvailable: !!user.isAvailable,
                breakReason: user.breakReason,
                online: online,
                lastLocationAt: user.lastLocationAt,
                rating: user.rating,
                ratingCount: user.ratingCount,
                deliveryCount: user.deliveryCount,
            },
            activeAssignments: active,
            deliveredAssignments: delivered,
            openOffers: openOffers,
            ops: {
                broadcastEnabled: !!settings.deliveryBroadcastEnabled,
                offerTtlSeconds: Number(settings.deliveryOfferTtlSeconds) || 90,
                autoAssign: !!settings.deliveryAutoAssign,
                staleMinutes: Number(settings.deliveryStaleMinutes) || 15,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// PUT /api/delivery-ops/availability - go online/offline (with a break reason).
exports.setAvailability = async (req, res) => {
    try {
        if (typeof req.body.isAvailable !== "boolean") {
            return res.status(400).json({ success: false, message: "isAvailable must be a boolean" });
        }
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        if (user.partnerStatus !== "approved") {
            return res.status(403).json({ success: false, message: "Your partner application is not approved yet." });
        }

        user.isAvailable = req.body.isAvailable;
        user.breakReason = req.body.isAvailable ? null : (String(req.body.breakReason || "").trim().slice(0, 80) || null);
        await user.save();

        // Going online without a GPS ping means the admin cannot see the partner
        // on the map, so nudge the device to share a position.
        const hasFreshPing = user.lastLocationAt && (Date.now() - new Date(user.lastLocationAt).getTime() < 5 * 60 * 1000);
        return res.json({
            success: true,
            isAvailable: user.isAvailable,
            breakReason: user.breakReason,
            needsLocation: !hasFreshPing,
            message: user.isAvailable ? "You are online. New orders will alert you." : "You are offline.",
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// ===============================
// PHASE 2: OFFERS + CLAIM
// ===============================

// GET /api/delivery-ops/offers - open offers addressed to me, nearest first.
exports.listOpenOffers = async (req, res) => {
    try {
        // Opportunistic sweep keeps unclaimed offers from lingering.
        sweepExpiredOffers(10).catch(function () { /* non-fatal */ });

        const user = await User.findById(req.user._id).select("lastLat lastLng").lean();
        const now = new Date();
        const offers = await DeliveryOffer.find({
            status: "OPEN",
            expiresAt: { $gt: now },
            notified: { $elemMatch: { user: req.user._id } },
            declinedBy: { $ne: req.user._id },
        })
            .populate("order", "orderNumber total deliverySlot deliveryLocation customer customerName items eta")
            .sort({ expiresAt: 1 })
            .limit(25);

        const shaped = offers.map(function (o) {
            const km = distanceKm(user || {}, o.order);
            return {
                _id: String(o._id),
                orderId: String(o.order ? o.order._id : ""),
                orderNumber: (o.order && o.order.orderNumber) || "",
                total: Number((o.order && o.order.total) || 0),
                deliverySlot: (o.order && o.order.deliverySlot) || "",
                area: (o.order && o.order.deliveryLocation && o.order.deliveryLocation.city) || o.zone || "",
                itemCount: o.order && Array.isArray(o.order.items) ? o.order.items.length : 0,
                distanceKm: Number.isFinite(km) ? km : null,
                expiresAt: o.expiresAt,
                expiresInSeconds: Math.max(0, Math.round((new Date(o.expiresAt).getTime() - now.getTime()) / 1000)),
                createdAt: o.createdAt,
            };
        });

        // Nearest first (partners with no ping yet sort last but still show).
        shaped.sort(function (a, b) {
            const ak = Number.isFinite(a.distanceKm) ? a.distanceKm : Number.MAX_SAFE_INTEGER;
            const bk = Number.isFinite(b.distanceKm) ? b.distanceKm : Number.MAX_SAFE_INTEGER;
            return ak - bk;
        });

        return res.json({ success: true, offers: shaped, serverTime: now });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery/offers/:id/accept  (and its alias
// POST /api/delivery-ops/offers/:id/claim) - FIRST ACCEPT WINS.
//
// Three independent locks stand between a partner's tap and a second partner on
// the same order, in this order:
//   1. the offer itself: an atomic findOneAndUpdate that only matches a still
//      OPEN, unexpired offer that this partner was actually notified about and
//      has not declined - so partner A can never accept partner B's offer, and
//      only one partner can flip a given offer;
//   2. the order: the partial unique index one_active_assignment_per_order makes
//      MongoDB reject a second ACTIVE assignment, which is what decides a race
//      between two partners on DIFFERENT offers of the same order (possible
//      after an auto-retry round);
//   3. the loser is told exactly why, and every other open offer is closed so
//      the rest of the fleet stops ringing for an order that is already taken.
//
// Identity comes from the verified JWT only. partnerId, role and order
// ownership in the request body are never read.
exports.acceptOffer = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, assigned: false, reason: "INVALID_OFFER_ID", message: "Invalid offer id" });
        }
        const user = await User.findById(req.user._id);
        if (!user) return res.status(404).json({ success: false, assigned: false, reason: "USER_NOT_FOUND", message: "User not found" });
        if (user.partnerStatus !== "approved" || user.role !== "delivery") {
            return res.status(403).json({ success: false, assigned: false, reason: "NOT_A_DELIVERY_PARTNER", message: "Only approved delivery partners can claim orders." });
        }

        logDeliveryEvent("OFFER_ACCEPT_ATTEMPT", { offerId: String(req.params.id), partnerId: String(user._id) });

        // Fast, non-destructive pre-check. Purely an optimisation for the common
        // case: it spares the loser a pointless claim and decides nothing on its
        // own, because the two locks below are what actually arbitrate.
        const peek = await DeliveryOffer.findById(req.params.id).select("order status expiresAt").lean();
        if (peek) {
            const alreadyTaken = await DeliveryAssignment.findOne({
                order: peek.order,
                status: { $in: ACTIVE_STATUSES },
            })
                .select("_id deliveryUser")
                .lean();
            if (alreadyTaken) {
                logDeliveryEvent("OFFER_LOST", {
                    offerId: String(req.params.id),
                    orderId: String(peek.order),
                    partnerId: String(user._id),
                    reason: "ORDER_ALREADY_ASSIGNED",
                });
                return res.status(409).json({
                    success: false,
                    assigned: false,
                    reason: "ORDER_ALREADY_ASSIGNED",
                    message: "Order already picked by another delivery partner.",
                });
            }
        }

        // LOCK 1 - atomic single-winner claim of the offer. A partner who already
        // declined this order is out of the running (same rule the feed uses), so
        // a stale page cannot claim what they passed on.
        const offer = await DeliveryOffer.findOneAndUpdate(
            {
                _id: req.params.id,
                status: "OPEN",
                expiresAt: { $gt: new Date() },
                notified: { $elemMatch: { user: user._id } },
                declinedBy: { $ne: user._id },
            },
            { $set: { status: "CLAIMED", claimedBy: user._id, claimedAt: new Date(), claimSource: "partner" } },
            { new: true }
        );
        if (!offer) {
            // Expired, already claimed, or never offered to this partner. Work
            // out which, so the partner gets an honest message instead of a
            // generic refusal.
            const peek = await DeliveryOffer.findById(req.params.id).lean();
            let reason = "OFFER_UNAVAILABLE";
            let message = "This order was already taken or the window closed.";
            if (!peek) {
                reason = "OFFER_NOT_FOUND";
                message = "Offer not found.";
            } else if (String(peek.claimedBy || "") === String(user._id)) {
                // Same partner tapping twice: they already own it.
                return res.json({
                    success: true,
                    assigned: true,
                    alreadyAccepted: true,
                    orderId: String(peek.order),
                    status: "ASSIGNED",
                    offerId: String(peek._id),
                    message: "You already accepted this order.",
                });
            } else if (peek.status === "OPEN" && !(peek.notified || []).some(function (n) { return String(n.user) === String(user._id); })) {
                reason = "OFFER_NOT_ASSIGNED_TO_YOU";
                message = "This offer was not sent to you.";
            } else if (peek.status === "OPEN" && new Date(peek.expiresAt).getTime() <= Date.now()) {
                reason = "OFFER_EXPIRED";
                message = "This offer expired before you accepted it.";
            }
            logDeliveryEvent("OFFER_LOST", {
                offerId: String(req.params.id),
                partnerId: String(user._id),
                reason: reason,
            });
            return res.status(409).json({ success: false, assigned: false, reason: reason, message: message });
        }

        const order = await Order.findById(offer.order);
        if (!order) {
            await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { status: "CANCELLED" } });
            return res.status(404).json({ success: false, assigned: false, reason: "ORDER_NOT_FOUND", message: "Order no longer exists." });
        }

        const km = distanceKm(user, order);
        let created;
        try {
            created = await createAssignmentResult({ order: order, partner: user, byUserId: user._id, mode: "claim", distanceKmValue: km });
        } catch (e) {
            // Something unexpected went wrong: hand the offer back so the order
            // is not stranded, then surface the error.
            await DeliveryOffer.updateOne(
                { _id: offer._id, status: "CLAIMED" },
                { $set: { status: "OPEN", claimedBy: null, claimedAt: null, claimSource: "partner" }, $unset: { expiresHandledAt: 1 } }
            );
            throw e;
        }

        if (!created.ok) {
            // LOCK 2 decided against us: somebody else owns this order now
            // (pre-check miss, or the unique index rejected a concurrent insert).
            await DeliveryOffer.updateOne({ _id: offer._id }, { $set: { status: "CANCELLED", claimSource: "raced" } });
            logDeliveryEvent("OFFER_LOST", {
                offerId: String(offer._id),
                orderId: String(order._id),
                partnerId: String(user._id),
                reason: created.reason,
            });
            return res.status(409).json({
                success: false,
                assigned: false,
                reason: created.reason === "ORDER_CLOSED" ? "ORDER_CLOSED" : "ORDER_ALREADY_ASSIGNED",
                message: "Order already picked by another delivery partner.",
            });
        }

        const assignment = created.assignment;
        await DeliveryOffer.updateOne(
            { _id: offer._id },
            { $set: { assignment: assignment._id, distanceKm: Number.isFinite(km) ? km : null } }
        );
        // LOCK 3 - close every other live offer for this order so the rest of the
        // fleet stops ringing their phones for something that is already taken.
        const closed = await DeliveryOffer.updateMany(
            { order: order._id, status: "OPEN", _id: { $ne: offer._id } },
            { $set: { status: "CANCELLED", claimSource: "raced" } }
        );
        // The rest of the fleet should stop ringing their phones for this order.
        notifyOfferClosed(offer, user, order).catch(function () { /* non-fatal */ });

        logDeliveryEvent("OFFER_WON", {
            offerId: String(offer._id),
            orderId: String(order._id),
            orderNumber: order.orderNumber || "",
            partnerId: String(user._id),
            claimSource: "partner",
            rivalsClosed: closed.modifiedCount || 0,
        });

        return res.json({
            success: true,
            assigned: true,
            orderId: String(order._id),
            status: "ASSIGNED",
            offerId: String(offer._id),
            assignmentId: String(assignment._id),
            message: "Order accepted. Collect the OTP from the customer at delivery.",
            assignment: assignment,
        });
    } catch (e) {
        return res.status(500).json({ success: false, assigned: false, reason: "SERVER_ERROR", message: safeErrorMessage(e) });
    }
};

// Back-compat alias: the original partner-panel endpoint now runs the exact same
// atomic accept path, so the two routes can never behave differently.
exports.claimOffer = exports.acceptOffer;

// Tell everyone else who was notified that the order is gone.
async function notifyOfferClosed(offer, winner, order) {
    try {
        const others = (offer.notified || [])
            .map(function (n) { return idOf(n.user); })
            .filter(function (id) { return id && id !== idOf(winner); });
        if (!others.length) return;
        await notificationController.notifyBase(winner._id, {
            type: "delivery_offer_closed",
            title: "Order assigned to you.",
            message: "You won order " + (order.orderNumber || "") + ". Start the pickup from your Delivery Panel.",
            dedupeKey: "offer_closed:" + String(offer._id),
            data: { link: "delivery.html" },
            push: false,
        }).catch(function () { });
        for (const id of others) {
            await notificationController.notifyBase(id, {
                type: "delivery_offer_closed",
                title: "Order taken",
                message: "Order already picked by another delivery partner.",
                dedupeKey: "offer_closed_others:" + String(offer._id) + ":" + id,
                data: { link: "delivery.html" },
            }).catch(function () { });
        }
    } catch (e) {
        await logWarn("offer-closed-notify", e);
    }
}

// POST /api/delivery-ops/offers/:id/decline - not taking this one.
exports.declineOffer = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid offer id" });
        }
        const offer = await DeliveryOffer.findOneAndUpdate(
            { _id: req.params.id, status: "OPEN", notified: { $elemMatch: { user: req.user._id } } },
            { $addToSet: { declinedBy: req.user._id } },
            { new: true }
        );
        if (!offer) return res.status(404).json({ success: false, message: "Offer not found or already closed." });
        return res.json({ success: true, message: "Offer declined." });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// ===============================
// PHASE 5: OTP RE-ISSUE / CASH / SIGNATURE
// ===============================

// POST /api/delivery-ops/assignments/:id/otp/reissue - the customer's OTP
// never arrived / was lost. Mints a fresh one and re-sends it; capped so a
// partner cannot spam the customer's inbox.
exports.reissueOtp = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid assignment id" });
        }
        const settings = await Settings.getSettings();
        const max = Number(settings.deliveryMaxOtpReissue);
        const assignment = await DeliveryAssignment.findOne({ _id: req.params.id, deliveryUser: req.user._id });
        if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found." });
        if (assignment.status === "DELIVERED" || assignment.status === "CANCELLED" || assignment.status === "REJECTED") {
            return res.status(400).json({ success: false, message: "This delivery is already closed." });
        }
        if (Number(assignment.otpReissueCount || 0) >= max) {
            return res.status(429).json({
                success: false,
                message: "OTP re-issue limit reached. Ask an admin to re-issue it.",
                remaining: 0,
            });
        }
        if (assignment.otpIssuedAt && Date.now() - new Date(assignment.otpIssuedAt).getTime() < OTP_REISSUE_COOLDOWN_MS) {
            const wait = Math.ceil((OTP_REISSUE_COOLDOWN_MS - (Date.now() - new Date(assignment.otpIssuedAt).getTime())) / 1000);
            return res.status(429).json({ success: false, message: "Please wait " + wait + "s before re-issuing the OTP.", remaining: max - Number(assignment.otpReissueCount || 0) });
        }

        const order = await Order.findById(assignment.order);
        if (!order) return res.status(404).json({ success: false, message: "Order not found." });

        const otp = generateOtp(4);
        assignment.otpHash = hashOtp(otp);
        assignment.otpExpiry = new Date(Date.now() + DELIVERY_OTP_TTL_MS);
        assignment.otpIssuedAt = new Date();
        assignment.otpAttempts = 0;
        assignment.otpReissueCount = Number(assignment.otpReissueCount || 0) + 1;
        assignment.otpReissueLog.push({
            at: new Date(),
            by: req.user._id,
            reason: String(req.body.reason || "").trim().slice(0, 160) || "OTP not received",
        });
        await assignment.save();

        let emailed = false;
        try {
            if (order.customerEmail) {
                await emailService.sendOtpEmail({ to: order.customerEmail, otp: otp, purpose: "delivery OTP (re-issued)" });
                emailed = true;
            }
        } catch (e) {
            await logWarn("otp-reissue-email", e);
        }
        try {
            if (order.user) {
                await notificationController.notifyBase(order.user, {
                    type: "delivery_otp",
                    title: "Your delivery OTP was re-sent",
                    message: "A fresh 4-digit OTP was sent to your email for order " + (order.orderNumber || "") + ". It is valid for 15 minutes.",
                    data: { link: "orders.html", orderId: String(order._id) },
                });
            }
        } catch (e) {
            await logWarn("otp-reissue-notify", e);
        }

        return res.json({
            success: true,
            message: emailed
                ? "A fresh OTP was emailed to the customer."
                : "OTP re-issued. The customer has no email on file - share the code verbally after verifying their identity.",
            emailed: emailed,
            remaining: max - assignment.otpReissueCount,
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/assignments/:id/cash - confirm the COD cash taken.
exports.confirmCash = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid assignment id" });
        }
        const amount = Number(req.body.amount);
        if (!Number.isFinite(amount) || amount < 0) {
            return res.status(400).json({ success: false, message: "Enter the cash amount collected." });
        }
        const assignment = await DeliveryAssignment.findOne({ _id: req.params.id, deliveryUser: req.user._id });
        if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found." });

        // Cash is handed over at the door, never before the drop starts.
        if (["CANCELLED", "REJECTED"].indexOf(assignment.status) !== -1) {
            return res.status(400).json({ success: false, message: "This delivery is closed - there is no cash to record." });
        }

        const order = await Order.findById(assignment.order).select("total paymentMethod");
        if (!order) return res.status(404).json({ success: false, message: "Order not found." });

        // Cash is only ever collected against a COD order. A prepaid drop has
        // nothing to reconcile, so recording cash for it would corrupt the sheet.
        if (order.paymentMethod !== "cod") {
            return res.status(400).json({ success: false, message: "This order is prepaid - there is no cash to collect." });
        }

        // A sane ceiling: the order amount plus a generous cash-change margin.
        const ceiling = (Number(order.total) || 0) + 5000;
        if (amount > ceiling) {
            return res.status(400).json({ success: false, message: "That is more than the order value plus ₹5,000 change. Check the amount." });
        }

        // Idempotent: an already-recorded cash confirmation is returned as-is, so
        // a double-tap or network retry can never silently rewrite the report.
        if (assignment.cashConfirmedAt && Number.isFinite(Number(assignment.cashCollected))) {
            const expectedNow = Number(order.total) || 0;
            return res.json({
                success: true,
                cashCollected: assignment.cashCollected,
                expected: expectedNow,
                variance: Math.round((Number(assignment.cashCollected) - expectedNow) * 100) / 100,
                message: "Cash already confirmed.",
            });
        }

        assignment.cashCollected = Math.round(amount * 100) / 100;
        assignment.cashConfirmedAt = new Date();
        await assignment.save();

        const expected = Number(order.total) || 0;
        return res.json({
            success: true,
            cashCollected: assignment.cashCollected,
            expected: expected,
            variance: Math.round((assignment.cashCollected - expected) * 100) / 100,
            message: assignment.cashCollected === expected
                ? "Cash confirmed. Amount matches the order."
                : "Cash recorded. The difference will show in the day-end reconciliation.",
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/assignments/:id/signature - recipient sign-off.
exports.saveSignature = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid assignment id" });
        }
        const signature = String(req.body.signature || "");
        if (!/^data:image\/(png|jpeg);base64,/i.test(signature)) {
            return res.status(400).json({ success: false, message: "Signature must be a PNG or JPEG image." });
        }
        // Measured in bytes, not characters: base64 is ASCII but a future
        // change must not silently weaken this ceiling.
        if (Buffer.byteLength(signature, "utf8") > MAX_SIGNATURE_BYTES) {
            return res.status(400).json({ success: false, message: "Signature image is too large. Draw it smaller." });
        }
        const assignment = await DeliveryAssignment.findOne({ _id: req.params.id, deliveryUser: req.user._id });
        if (!assignment) return res.status(404).json({ success: false, message: "Assignment not found." });
        if (["CANCELLED", "REJECTED"].indexOf(assignment.status) !== -1) {
            return res.status(400).json({ success: false, message: "This delivery is closed - the signature can no longer be recorded." });
        }

        // Idempotent: an already-saved sign-off is returned as-is (a retry or
        // double tap must never overwrite the original sign-off).
        if (assignment.signature) {
            return res.json({ success: true, message: "Signature already saved.", signedAt: assignment.signatureAt });
        }

        assignment.signature = signature;
        assignment.signatureAt = new Date();
        await assignment.save();
        return res.json({ success: true, message: "Signature saved.", signedAt: assignment.signatureAt });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/delivery-ops/active - a lean, partner-facing view of the runs in
// progress. Deliberately shaped (and deliberately excludes the signature image)
// so the partner panel can poll it every few seconds without pulling large
// base64 blobs or fields it never renders.
exports.activeBoard = async (req, res) => {
    try {
        const settings = await Settings.getSettings();
        const maxReissue = Number(settings.deliveryMaxOtpReissue) || 0;
        const assignments = await DeliveryAssignment.find({
            deliveryUser: req.user._id,
            status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE", "DELIVERED"] },
        })
            .populate("order", "orderNumber total paymentMethod deliverySlot deliveryLocation customer customerName items")
            .sort({ assignedAt: -1 })
            .limit(50);

        const now = Date.now();
        const active = assignments.map(function (a) {
            const order = a.order || {};
            const customer = order.customer && typeof order.customer === "object" ? order.customer : {};
            const loc = order.deliveryLocation || {};
            const lat = Number(loc.latitude);
            const lng = Number(loc.longitude);
            const total = Number(order.total) || 0;
            const collected = a.cashCollected == null ? null : Number(a.cashCollected);
            const isCod = order.paymentMethod === "cod";
            const issuedAt = a.otpIssuedAt ? new Date(a.otpIssuedAt).getTime() : 0;
            const cooldownEnds = issuedAt ? issuedAt + OTP_REISSUE_COOLDOWN_MS : 0;
            return {
                assignmentId: String(a._id),
                orderId: order._id ? String(order._id) : String(a.order),
                orderNumber: order.orderNumber || "",
                status: a.status,
                assignMode: a.assignMode || "admin",
                assignedAt: a.assignedAt,
                deliveredAt: a.deliveredAt || null,
                total: total,
                isCod: isCod,
                paymentMethod: order.paymentMethod || "cod",
                deliverySlot: order.deliverySlot || "",
                area: loc.city || loc.state || "",
                itemCount: Array.isArray(order.items) ? order.items.length : 0,
                customerName: customer.name || order.customerName || "Customer",
                customerPhone: customer.phone || order.phone || "",
                distanceKm: a.distanceKm == null ? null : Number(a.distanceKm),
                hasLocation: Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0),
                cashCollected: collected,
                expectedCash: isCod ? total : null,
                cashVariance: isCod && collected != null ? Math.round((collected - total) * 100) / 100 : null,
                hasSignature: Boolean(a.signature),
                signatureAt: a.signatureAt || null,
                hasProof: Boolean(a.proofImage),
                proofImage: a.proofImage || "",
                otpReissueCount: Number(a.otpReissueCount || 0),
                otpReissueMax: maxReissue,
                otpReissueReadyInSeconds: cooldownEnds > now ? Math.ceil((cooldownEnds - now) / 1000) : 0,
                earnings: Number(a.earnings) || 0,
            };
        });

        return res.json({
            success: true,
            active: active.filter(function (r) { return r.status !== "DELIVERED"; }),
            recentlyDelivered: active.filter(function (r) { return r.status === "DELIVERED"; }).slice(0, 5),
            serverTime: new Date(),
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/delivery-ops/history - my completed drops + summary (Phase 5/6).
exports.myHistory = async (req, res) => {
    try {
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const [delivered, rejected, cancelled, pending] = await Promise.all([
            DeliveryAssignment.find({ deliveryUser: req.user._id, status: "DELIVERED" })
                .populate("order", "orderNumber total paymentMethod deliverySlot")
                .sort({ deliveredAt: -1 })
                .limit(limit),
            DeliveryAssignment.countDocuments({ deliveryUser: req.user._id, status: "REJECTED" }),
            DeliveryAssignment.countDocuments({ deliveryUser: req.user._id, status: "CANCELLED" }),
            DeliveryAssignment.countDocuments({ deliveryUser: req.user._id, status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] } }),
        ]);

        const rows = delivered.map(function (a) {
            const expected = a.order ? Number(a.order.total) || 0 : 0;
            const collected = a.cashCollected == null ? null : Number(a.cashCollected);
            return {
                assignmentId: String(a._id),
                orderId: String(a.order ? a.order._id : ""),
                orderNumber: a.order ? a.order.orderNumber : "",
                deliveredAt: a.deliveredAt,
                earnings: Number(a.earnings) || 0,
                tip: Number(a.tipAmount) || 0,
                paymentMethod: a.order ? a.order.paymentMethod : "",
                deliverySlot: a.order ? a.order.deliverySlot : "",
                assignMode: a.assignMode,
                cashCollected: collected,
                expectedCash: a.order && a.order.paymentMethod === "cod" ? expected : null,
                variance: collected == null ? null : Math.round((collected - expected) * 100) / 100,
                hasProof: !!a.proofImage,
                hasSignature: !!a.signature,
            };
        });

        const cashRows = rows.filter(function (r) { return r.expectedCash != null; });
        const collectedTotal = cashRows.reduce(function (s, r) { return s + (r.cashCollected || 0); }, 0);
        const expectedTotal = cashRows.reduce(function (s, r) { return s + r.expectedCash; }, 0);

        return res.json({
            success: true,
            summary: {
                delivered: delivered.length,
                rejected: rejected,
                cancelled: cancelled,
                active: pending,
                earningsTotal: rows.reduce(function (s, r) { return s + r.earnings + r.tip; }, 0),
                codExpected: Math.round(expectedTotal * 100) / 100,
                codCollected: Math.round(collectedTotal * 100) / 100,
                codVariance: Math.round((collectedTotal - expectedTotal) * 100) / 100,
                unconfirmedCash: cashRows.filter(function (r) { return r.cashCollected == null; }).length,
            },
            deliveries: rows,
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// ===============================
// ADMIN: PARTNERS + OFFERS + RECONCILIATION
// ===============================

// GET /api/delivery-ops/admin/partners - approved partners + pending applicants.
exports.adminListPartners = async (req, res) => {
    try {
        sweepExpiredOffers(10).catch(function () { /* non-fatal */ });
        const settings = await Settings.getSettings();
        const staleMs = (Number(settings.deliveryStaleMinutes) || 15) * 60 * 1000;
        const now = Date.now();

        const [partners, applicants, assignments, offers] = await Promise.all([
            User.find({ role: "delivery" }).select(
                "name email phone partnerStatus vehicleType zone isAvailable breakReason lastLat lastLng lastLocationAt rating ratingCount deliveryCount createdAt partnerReviewedAt"
            ).lean(),
            User.find({ role: { $ne: "delivery" }, partnerStatus: { $in: ["pending", "rejected"] } })
                .select("name email phone partnerStatus partnerAppliedAt partnerRejectReason vehicleType zone createdAt")
                .sort({ partnerAppliedAt: -1 })
                .limit(100)
                .lean(),
            DeliveryAssignment.find({ status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE", "DELIVERED"] } })
                .populate("order", "orderNumber total paymentMethod deliveredAt")
                .sort({ assignedAt: -1 })
                .limit(500)
                .lean(),
            DeliveryOffer.find({ createdAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) } }).sort({ createdAt: -1 }).limit(100).lean(),
        ]);

        const byPartner = new Map();
        for (const a of assignments) {
            const key = String(a.deliveryUser);
            if (!byPartner.has(key)) byPartner.set(key, { active: 0, delivered: 0, earnings: 0, codExpected: 0, codCollected: 0, cashMissing: 0 });
            const row = byPartner.get(key);
            if (a.status === "DELIVERED") {
                row.delivered += 1;
                row.earnings += Number(a.earnings) || 0;
                if (a.order && a.order.paymentMethod === "cod") {
                    row.codExpected += Number(a.order.total) || 0;
                    if (a.cashCollected == null) row.cashMissing += 1;
                    else row.codCollected += Number(a.cashCollected) || 0;
                }
            } else {
                row.active += 1;
            }
        }

        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const todayByPartner = new Map();
        for (const a of assignments) {
            if (a.status !== "DELIVERED" || !a.deliveredAt || new Date(a.deliveredAt) < dayStart) continue;
            const key = String(a.deliveryUser);
            todayByPartner.set(key, (todayByPartner.get(key) || 0) + 1);
        }

        const shapedPartners = partners.map(function (p) {
            const stats = byPartner.get(String(p._id)) || { active: 0, delivered: 0, earnings: 0, codExpected: 0, codCollected: 0, cashMissing: 0 };
            const lastAt = p.lastLocationAt ? new Date(p.lastLocationAt).getTime() : 0;
            const fresh = lastAt > 0 && now - lastAt < staleMs;
            return {
                _id: String(p._id),
                name: p.name,
                email: p.email,
                phone: p.phone,
                partnerStatus: p.partnerStatus,
                vehicleType: p.vehicleType,
                zone: p.zone,
                isAvailable: !!p.isAvailable,
                breakReason: p.breakReason,
                online: Boolean(p.isAvailable && fresh),
                stale: !fresh,
                lastLocationAt: p.lastLocationAt,
                lastLat: p.lastLat == null ? null : p.lastLat,
                lastLng: p.lastLng == null ? null : p.lastLng,
                rating: p.rating,
                ratingCount: p.ratingCount,
                deliveryCount: p.deliveryCount,
                active: stats.active,
                delivered: stats.delivered,
                deliveredToday: todayByPartner.get(String(p._id)) || 0,
                earnings: Math.round(stats.earnings * 100) / 100,
                codExpected: Math.round(stats.codExpected * 100) / 100,
                codCollected: Math.round(stats.codCollected * 100) / 100,
                cashMissing: stats.cashMissing,
                joinedAt: p.createdAt,
                reviewedAt: p.partnerReviewedAt,
            };
        }).sort(function (a, b) {
            if (a.online !== b.online) return a.online ? -1 : 1;
            return (b.delivered || 0) - (a.delivered || 0);
        });

        const shapedApplicants = applicants.map(function (a) {
            return {
                _id: String(a._id),
                name: a.name,
                email: a.email,
                phone: a.phone,
                partnerStatus: a.partnerStatus,
                appliedAt: a.partnerAppliedAt,
                rejectReason: a.partnerRejectReason,
                vehicleType: a.vehicleType,
                zone: a.zone,
            };
        });

        // ---- Auto-dispatch monitoring -------------------------------------
        // Everything an operator needs to answer "did this order get dispatched
        // on its own, to whom, when, and did it need a retry or a human?" -
        // without joining tables by hand.
        const assignmentByOrder = new Map();
        for (const a of assignments) {
            const key = a.order && a.order._id ? String(a.order._id) : "";
            if (key && !assignmentByOrder.has(key)) assignmentByOrder.set(key, a);
        }
        const closedOffersByOrder = new Map();
        for (const o of offers) {
            if (o.status !== "EXPIRED" && o.status !== "CANCELLED") continue;
            const key = String(o.order);
            closedOffersByOrder.set(key, (closedOffersByOrder.get(key) || 0) + 1);
        }
        const maxRounds = Math.min(Number(settings.deliveryMaxDispatchRounds) || 3, 5);

        return res.json({
            success: true,
            partners: shapedPartners,
            applicants: shapedApplicants,
            offersToday: offers.map(function (o) {
                const key = String(o.order);
                const assignment = assignmentByOrder.get(key) || null;
                return {
                    _id: String(o._id),
                    orderId: key,
                    status: o.status,
                    mode: o.mode,
                    round: o.round,
                    notified: (o.notified || []).length,
                    declined: (o.declinedBy || []).length,
                    claimedBy: o.claimedBy ? String(o.claimedBy) : null,
                    claimSource: o.claimSource,
                    createdAt: o.createdAt,
                    expiresAt: o.expiresAt,
                    // --- auto-dispatch status ---
                    autoDispatch: o.mode === "broadcast",
                    assignedAt: assignment ? assignment.assignedAt : null,
                    assignMode: assignment ? assignment.assignMode : null,
                    deliveryStatus: assignment ? assignment.status : null,
                    deliveredAt: assignment ? assignment.deliveredAt : null,
                    closedOffers: closedOffersByOrder.get(key) || 0,
                    retries: Math.max(0, (Number(o.round) || 1) - 1),
                    maxRounds: maxRounds,
                    retryExhausted: (Number(o.round) || 1) >= maxRounds && !assignment,
                };
            }),
            ops: {
                broadcastEnabled: !!settings.deliveryBroadcastEnabled,
                offerTtlSeconds: Number(settings.deliveryOfferTtlSeconds) || 90,
                autoAssign: !!settings.deliveryAutoAssign,
                autoAssignDelaySeconds: Number(settings.deliveryAutoAssignDelaySeconds) || 90,
                maxOtpReissue: Number(settings.deliveryMaxOtpReissue),
                staleMinutes: Number(settings.deliveryStaleMinutes) || 15,
                maxDispatchRounds: maxRounds,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/admin/partners/:id/review - approve / reject / revoke.
exports.adminReviewPartner = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid user id" });
        }
        const action = String(req.body.action || "");
        if (["approve", "reject", "revoke"].indexOf(action) === -1) {
            return res.status(400).json({ success: false, message: "action must be approve, reject or revoke" });
        }
        const user = await User.findById(req.params.id);
        if (!user) return res.status(404).json({ success: false, message: "User not found" });
        if (user.role === "admin") {
            return res.status(400).json({ success: false, message: "Admins cannot be turned into delivery partners." });
        }

        if (action === "approve") {
            if (!user.phone) {
                return res.status(400).json({ success: false, message: "This user has no phone number - customers need it on delivery." });
            }
            user.partnerStatus = "approved";
            user.role = "delivery";
            user.partnerReviewedAt = new Date();
            user.partnerReviewedBy = req.user._id;
            user.partnerRejectReason = null;
            user.breakReason = null;
        } else if (action === "reject") {
            user.partnerStatus = "rejected";
            user.role = "customer";
            user.isAvailable = false;
            user.partnerReviewedAt = new Date();
            user.partnerReviewedBy = req.user._id;
            user.partnerRejectReason = String(req.body.reason || "").trim().slice(0, 160) || "Not eligible";
        } else {
            user.partnerStatus = "none";
            user.role = "customer";
            user.isAvailable = false;
            user.partnerReviewedAt = new Date();
            user.partnerReviewedBy = req.user._id;
            user.partnerRejectReason = null;
        }
        await user.save();

        try {
            await notificationController.notifyBase(user._id, {
                type: "partner_status",
                title: action === "approve" ? "You are a FreshMart delivery partner" : action === "reject" ? "Partner application declined" : "Partner access removed",
                message: action === "approve"
                    ? "Turn on your availability and share your location to start receiving orders."
                    : action === "reject"
                        ? "Reason: " + user.partnerRejectReason
                        : "You are no longer a delivery partner.",
                data: { link: "profile.html" },
            });
        } catch (e) {
            await logWarn("partner-review-notify", e);
        }

        return res.json({ success: true, partnerStatus: user.partnerStatus, role: user.role, message: "Partner updated." });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/admin/partners/:id/force-assign - give this partner
// the oldest unassigned order (or a specific one).
exports.adminForceAssign = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.id)) {
            return res.status(400).json({ success: false, message: "Invalid user id" });
        }
        const partner = await User.findById(req.params.id);
        if (!partner || partner.role !== "delivery") {
            return res.status(404).json({ success: false, message: "Delivery partner not found" });
        }

        let order = null;
        if (req.body.orderId) {
            if (!isValidObjectId(req.body.orderId)) {
                return res.status(400).json({ success: false, message: "Invalid order id" });
            }
            order = await Order.findById(req.body.orderId);
        } else {
            // Oldest order that still has nobody on it.
            const taken = await DeliveryAssignment.find({
                status: { $in: ["ASSIGNED", "ACCEPTED", "PICKED_UP", "EN_ROUTE"] },
            }).select("order");
            const takenIds = taken.map(function (t) { return String(t.order); });
            order = await Order.find({ _id: { $nin: takenIds }, status: { $nin: ["Cancelled", "Delivered"] } })
                .sort({ createdAt: 1 })
                .limit(1);
            order = order && order.length ? order[0] : null;
        }
        if (!order) return res.status(404).json({ success: false, message: "No unassigned order found." });

        const assignment = await createAssignment({
            order: order,
            partner: partner,
            byUserId: req.user._id,
            mode: "admin",
            distanceKmValue: distanceKm(partner, order),
        });
        if (!assignment) return res.status(409).json({ success: false, message: "That order is already assigned." });

        // Stop the broadcast offer for this order, if any is still open, and tell
        // everyone who was looking at it that it is already taken.
        const openOffers = await DeliveryOffer.find({ order: order._id, status: "OPEN" }).populate("order", "orderNumber total user deliveryLocation");
        for (const offer of openOffers) {
            offer.status = "ASSIGNED";
            offer.claimSource = "admin";
            offer.claimedBy = partner._id;
            offer.claimedAt = new Date();
            offer.assignment = assignment._id;
            await offer.save();
            notifyOfferClosed(offer, partner, order).catch(function () { /* non-fatal */ });
        }
        return res.json({ success: true, message: "Order assigned to " + (partner.name || "partner") + ".", assignment: assignment, offersClosed: openOffers.length });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/admin/offers/sweep - run the expiry sweep now.
exports.adminSweepOffers = async (req, res) => {
    try {
        const result = await sweepExpiredOffers(Number(req.body.limit) || 50);
        return res.json({ success: true, ...result });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/admin/broadcast/:orderId - re-alert online partners
// for an order that nobody took (new round, fresh TTL).
exports.adminRebroadcast = async (req, res) => {
    try {
        if (!isValidObjectId(req.params.orderId)) {
            return res.status(400).json({ success: false, message: "Invalid order id" });
        }
        const order = await Order.findById(req.params.orderId);
        if (!order) return res.status(404).json({ success: false, message: "Order not found" });
        const result = await broadcastNewOrder(order);
        return res.json({ success: true, broadcast: result });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/delivery-ops/admin/reconciliation?date=YYYY-MM-DD - day-end COD
// cash sheet per partner (Phase 6).
exports.adminReconciliation = async (req, res) => {
    try {
        const day = String(req.query.date || "").match(/^\d{4}-\d{2}-\d{2}$/)
            ? new Date(String(req.query.date) + "T00:00:00.000Z")
            : new Date();
        const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
        const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

        const assignments = await DeliveryAssignment.find({
            status: "DELIVERED",
            deliveredAt: { $gte: start, $lt: end },
        })
            .populate("deliveryUser", "name phone email")
            .populate("order", "orderNumber total paymentMethod")
            .sort({ deliveredAt: 1 })
            .lean();

        const rows = new Map();
        for (const a of assignments) {
            const key = String(a.deliveryUser ? a.deliveryUser._id : "unknown");
            if (!rows.has(key)) {
                rows.set(key, {
                    partnerId: key,
                    partnerName: a.deliveryUser ? a.deliveryUser.name : "Unknown",
                    partnerPhone: a.deliveryUser ? a.deliveryUser.phone : "",
                    delivered: 0,
                    codOrders: 0,
                    codExpected: 0,
                    codCollected: 0,
                    cashMissing: 0,
                    variance: 0,
                    orders: [],
                });
            }
            const row = rows.get(key);
            row.delivered += 1;
            const isCod = a.order && a.order.paymentMethod === "cod";
            if (isCod) {
                const expected = Number(a.order.total) || 0;
                row.codOrders += 1;
                row.codExpected += expected;
                if (a.cashCollected == null) {
                    row.cashMissing += 1;
                } else {
                    row.codCollected += Number(a.cashCollected) || 0;
                }
                row.orders.push({
                    orderNumber: a.order.orderNumber,
                    expected: expected,
                    collected: a.cashCollected == null ? null : Number(a.cashCollected),
                    variance: a.cashCollected == null ? null : Math.round((Number(a.cashCollected) - expected) * 100) / 100,
                    deliveredAt: a.deliveredAt,
                });
            }
        }

        const list = Array.from(rows.values()).map(function (r) {
            r.codExpected = Math.round(r.codExpected * 100) / 100;
            r.codCollected = Math.round(r.codCollected * 100) / 100;
            r.variance = Math.round((r.codCollected - r.codExpected) * 100) / 100;
            return r;
        }).sort(function (a, b) { return b.codExpected - a.codExpected; });

        return res.json({
            success: true,
            date: start.toISOString().slice(0, 10),
            partners: list,
            totals: {
                deliveries: assignments.length,
                codOrders: list.reduce(function (s, r) { return s + r.codOrders; }, 0),
                codExpected: Math.round(list.reduce(function (s, r) { return s + r.codExpected; }, 0) * 100) / 100,
                codCollected: Math.round(list.reduce(function (s, r) { return s + r.codCollected; }, 0) * 100) / 100,
                cashMissing: list.reduce(function (s, r) { return s + r.cashMissing; }, 0),
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// GET /api/delivery-ops/admin/settings - delivery-operations switches.
exports.adminGetOpsSettings = async (req, res) => {
    try {
        const s = await Settings.getSettings();
        return res.json({
            success: true,
            ops: {
                broadcastEnabled: !!s.deliveryBroadcastEnabled,
                offerTtlSeconds: Number(s.deliveryOfferTtlSeconds),
                autoAssign: !!s.deliveryAutoAssign,
                autoAssignDelaySeconds: Number(s.deliveryAutoAssignDelaySeconds),
                maxOtpReissue: Number(s.deliveryMaxOtpReissue),
                staleMinutes: Number(s.deliveryStaleMinutes),
                maxDispatchRounds: Number(s.deliveryMaxDispatchRounds) || 3,
            },
        });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// PUT /api/delivery-ops/admin/settings - update the switches (whitelisted).
exports.adminUpdateOpsSettings = async (req, res) => {
    try {
        const s = await Settings.getSettings();
        const body = req.body || {};
        if (typeof body.broadcastEnabled === "boolean") s.deliveryBroadcastEnabled = body.broadcastEnabled;
        if (typeof body.autoAssign === "boolean") s.deliveryAutoAssign = body.autoAssign;
        if (body.offerTtlSeconds != null) {
            const n = Number(body.offerTtlSeconds);
            if (!Number.isFinite(n) || n < 15 || n > 900) {
                return res.status(400).json({ success: false, message: "offerTtlSeconds must be between 15 and 900." });
            }
            s.deliveryOfferTtlSeconds = Math.round(n);
        }
        if (body.autoAssignDelaySeconds != null) {
            const n = Number(body.autoAssignDelaySeconds);
            if (!Number.isFinite(n) || n < 10 || n > 1800) {
                return res.status(400).json({ success: false, message: "autoAssignDelaySeconds must be between 10 and 1800." });
            }
            s.deliveryAutoAssignDelaySeconds = Math.round(n);
        }
        if (body.maxOtpReissue != null) {
            const n = Number(body.maxOtpReissue);
            if (!Number.isFinite(n) || n < 0 || n > 5) {
                return res.status(400).json({ success: false, message: "maxOtpReissue must be between 0 and 5." });
            }
            s.deliveryMaxOtpReissue = Math.round(n);
        }
        if (body.staleMinutes != null) {
            const n = Number(body.staleMinutes);
            if (!Number.isFinite(n) || n < 1 || n > 240) {
                return res.status(400).json({ success: false, message: "staleMinutes must be between 1 and 240." });
            }
            s.deliveryStaleMinutes = Math.round(n);
        }
        if (body.maxDispatchRounds != null) {
            const n = Number(body.maxDispatchRounds);
            if (!Number.isFinite(n) || n < 1 || n > 5) {
                return res.status(400).json({ success: false, message: "maxDispatchRounds must be between 1 and 5." });
            }
            s.deliveryMaxDispatchRounds = Math.round(n);
        }
        await s.save();
        return res.json({ success: true, message: "Delivery settings saved.", ops: {
            broadcastEnabled: s.deliveryBroadcastEnabled,
            offerTtlSeconds: s.deliveryOfferTtlSeconds,
            autoAssign: s.deliveryAutoAssign,
            autoAssignDelaySeconds: s.deliveryAutoAssignDelaySeconds,
            maxOtpReissue: s.deliveryMaxOtpReissue,
            staleMinutes: s.deliveryStaleMinutes,
            maxDispatchRounds: s.deliveryMaxDispatchRounds,
        } });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// POST /api/delivery-ops/admin/push/prune - drop chronically failing endpoints.
exports.adminPrunePush = async (req, res) => {
    try {
        const pruned = await pushController.pruneFlakySubscriptions(Number(req.body.maxFailures) || 25);
        return res.json({ success: true, pruned: pruned, message: pruned + " stale push subscription(s) deactivated." });
    } catch (e) {
        return res.status(500).json({ success: false, message: safeErrorMessage(e) });
    }
};

// Exported for the order controller and tests.
exports.broadcastNewOrder = broadcastNewOrder;
exports.sweepExpiredOffers = sweepExpiredOffers;
exports.createAssignment = createAssignment;
exports.createAssignmentResult = createAssignmentResult;
exports.getAvailableDeliveryPartners = getAvailableDeliveryPartners;
exports.distanceKm = distanceKm;
exports.pickNearestOnlinePartner = pickNearestOnlinePartner;
exports.logDeliveryEvent = logDeliveryEvent;
exports.ACTIVE_STATUSES = ACTIVE_STATUSES;
exports.DELIVERY_OTP_TTL_MS = DELIVERY_OTP_TTL_MS;
