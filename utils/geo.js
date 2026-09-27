// ===============================
// GEO UTILITIES
// Server-authoritative delivery-radius enforcement.
// The client never supplies or trusts a distance: every destination is
// re-checked here against the admin-configured store origin and radius.
// Radius is OFF by default (0), so address-only / older flows never break.
// ===============================

const Settings = require("../models/Settings");

function toRad(d) {
    return d * (Math.PI / 180);
}

// Great-circle distance (km) between two lat/lng pairs (Haversine).
function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(a));
}

// Authoritative gate used by order creation. Throws { status, message } when
// the order's destination is outside the radius or cannot be verified.
// Returns a summary when the destination is accepted.
async function assertDeliveryWithinRadius(deliveryLocation) {
    const doc = await Settings.getSettings();
    const radiusKm = Number(doc.deliveryRadiusKm) || 0;
    if (!(radiusKm > 0)) {
        // Radius service check is disabled: never block address-only customers.
        return { inside: true, radiusKm: 0, distanceKm: null };
    }
    if (!deliveryLocation ||
        typeof deliveryLocation.latitude !== "number" ||
        typeof deliveryLocation.longitude !== "number") {
        throw { status: 400, message: "We need your delivery location to check service coverage. Please allow location access and try again." };
    }
    const storeLat = Number(doc.storeLat);
    const storeLng = Number(doc.storeLng);
    if (!(Math.abs(storeLat) > 0 || Math.abs(storeLng) > 0)) {
        throw { status: 500, message: "Store location is not configured. Please ask the admin to set it before enabling the delivery radius." };
    }
    const distanceKm = haversineKm(deliveryLocation.latitude, deliveryLocation.longitude, storeLat, storeLng);
    if (distanceKm > radiusKm) {
        throw {
            status: 400,
            message: "Sorry, we currently deliver only within " + radiusKm + " km of our store. Your location is about " +
                distanceKm.toFixed(1) + " km away, which is outside our delivery area."
        };
    }
    return {
        inside: true,
        radiusKm: radiusKm,
        distanceKm: Math.round(distanceKm * 10) / 10
    };
}

// Public coverage summary for a coordinate pair (used by the checkout UI to
// warn early). Never leaks the store's exact coordinates or any partner data.
async function deliveryCoverageFor(lat, lng) {
    const doc = await Settings.getSettings();
    const radiusKm = Number(doc.deliveryRadiusKm) || 0;
    const storeLat = Number(doc.storeLat);
    const storeLng = Number(doc.storeLng);
    const storeConfigured = Math.abs(storeLat) > 0 || Math.abs(storeLng) > 0;
    let distanceKm = null;
    if (storeConfigured && Number.isFinite(lat) && Number.isFinite(lng)) {
        distanceKm = Math.round(haversineKm(lat, lng, storeLat, storeLng) * 10) / 10;
    }
    const inside = !(radiusKm > 0) || !storeConfigured || (Number.isFinite(distanceKm) && distanceKm <= radiusKm);
    return {
        radiusEnabled: radiusKm > 0,
        serviceable: inside,
        inside: inside,
        radiusKm: radiusKm,
        distanceKm: distanceKm,
        storeLocality: doc.storeLocality || "Store"
    };
}

module.exports = {
    haversineKm: haversineKm,
    assertDeliveryWithinRadius: assertDeliveryWithinRadius,
    deliveryCoverageFor: deliveryCoverageFor
};