// ===============================
// ETA UTILITIES
// Real delivery-time estimate derived from the latest data we actually have:
//   1. rider GPS  -> straight-line travel time from the partner's last known
//                    location to the order's delivery point (most accurate).
//   2. pipeline   -> typical remaining time per delivery-assignment stage
//                    (ACCEPTED / PICKED_UP / EN_ROUTE).
//   3. slot       -> last-resort label from the chosen delivery slot.
// Never fabricates a timestamp or a "live" ETA when there is no data.
// ===============================

const Settings = require("../models/Settings");
const { haversineKm } = require("./geo");

// Typical remaining minutes per delivery stage when no live rider GPS exists.
const STAGE_MINUTES = {
    ASSIGNED: 40,
    ACCEPTED: 30,
    PICKED_UP: 20,
    EN_ROUTE: 15
};

const SLOT_WINDOWS = {
    "Morning (8-11 AM)": "Today, 8-11 AM",
    "Evening (5-8 PM)": "Today, 5-8 PM"
};

function slotEta(label) {
    return {
        text: SLOT_WINDOWS[label] || ("Today (" + (label || "Morning (8-11 AM)") + ")"),
        minutes: null,
        at: null,
        source: "slot"
    };
}

// Minutes for the rider to travel from their last GPS fix to the delivery point
// (~25 km/h typical scooter pace inside a city + a small buffer). Returns null
// when we lack either the rider fix or the destination coordinates.
function riderEtaMinutes(track, order) {
    const p = track && track.partner;
    if (!p || typeof p.lastLat !== "number" || typeof p.lastLng !== "number") return null;
    const dest = order && order.deliveryLocation;
    if (!dest || typeof dest.latitude !== "number" || typeof dest.longitude !== "number") return null;
    const km = haversineKm(p.lastLat, p.lastLng, dest.latitude, dest.longitude);
    return Math.max(Math.ceil((km / 25) * 60) + 5, 3);
}

// order: an Order document (or the public tracking payload), track: the result
// of deliveryTrackFor(). Returns { text, minutes, at, source } or null.
async function deliveryEta(order, track) {
    if (!order) return null;
    const status = String(order.status || "");
    if (status === "Delivered") return { text: "Delivered", minutes: 0, at: null, source: "status" };
    if (status === "Cancelled") return null;

    const settings = await Settings.getSettings();
    const baseMin = Number(settings.etaBaseMinutes) >= 0 ? Number(settings.etaBaseMinutes) : 45;

    // 1) Live rider GPS (best real-time signal).
    const riderMin = riderEtaMinutes(track, order);
    if (Number.isFinite(riderMin)) {
        return {
            text: "~" + riderMin + " min",
            minutes: riderMin,
            at: new Date(Date.now() + riderMin * 60000).toISOString(),
            source: "rider"
        };
    }

    // 2) Delivery-pipeline stage.
    const stage = track && track.status ? String(track.status) : "";
    if (Object.prototype.hasOwnProperty.call(STAGE_MINUTES, stage)) {
        let minutes = STAGE_MINUTES[stage];
        if (status === "Out for Delivery") minutes = Math.max(minutes, baseMin);
        return {
            text: "~" + minutes + " min",
            minutes: minutes,
            at: new Date(Date.now() + minutes * 60000).toISOString(),
            source: "stage"
        };
    }

    // 3) Slot fallback.
    return slotEta(order.deliverySlot || "Morning (8-11 AM)");
}

module.exports = {
    deliveryEta: deliveryEta,
    riderEtaMinutes: riderEtaMinutes
};