/* ===============================
 * LOCAL SEO ENRICHMENT (config-driven, never fabricated)
 *
 * Reads local-seo.json and, ONLY if the owner has actually filled in the real
 * business fields, injects a LocalBusiness JSON-LD block. When the file is
 * empty (the default), nothing is injected - an empty local-seo.json must NEVER
 * manufacture an address, phone or rating for Google. This matches the
 * project's hard rule: "Local SEO must not fabricate address, phone, ratings or
 * hours".
 *
 * local-seo.json is served as static JSON (see app.js SERVED_ONLY_EXT). It is
 * deliberately lightweight so crawlers and the page share one source of truth.
 * =============================== */
(function () {
    if (typeof fetch !== "function") return;
    function isEmpty(v) { return v === undefined || v === null || v === ""; }
    fetch("local-seo.json", { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("no local-seo.json"); return r.json(); })
        .then(function (cfg) {
            if (!cfg || typeof cfg !== "object") return;
            var address = cfg.address || {};
            var hasAddress = address.streetAddress || address.city || address.postalCode;
            var hasContact = cfg.phone || (cfg.sameAs && cfg.sameAs.length);
            var hasGeo = cfg.geo && cfg.geo.latitude && cfg.geo.longitude;
            if (!hasAddress && !hasContact && !hasGeo && !(cfg.hours && cfg.hours.length)) {
                return; // nothing real to declare - keep schema honest
            }
            var schema = {
                "@context": "https://schema.org",
                "@type": "GroceryStore",
                "name": cfg.name || "FreshMart",
                "url": cfg.url || "https://freshmart-store-jet.vercel.app/",
                "priceRange": "₹"
            };
            if (cfg.description) schema.description = cfg.description;
            if (hasAddress) {
                schema.address = { "@type": "PostalAddress" };
                if (address.streetAddress) schema.address.streetAddress = address.streetAddress;
                if (address.city) schema.address.addressLocality = address.city;
                if (address.state) schema.address.addressRegion = address.state;
                if (address.postalCode) schema.address.postalCode = address.postalCode;
                schema.address.addressCountry = "IN";
            }
            if (cfg.phone) schema.telephone = cfg.phone;
            if (hasGeo && Number(cfg.geo.latitude) && Number(cfg.geo.longitude)) {
                schema.geo = {
                    "@type": "GeoCoordinates",
                    "latitude": Number(cfg.geo.latitude),
                    "longitude": Number(cfg.geo.longitude)
                };
            }
            if (cfg.hours && cfg.hours.length) schema.openingHoursSpecification = cfg.hours;
            if (cfg.sameAs && cfg.sameAs.length) schema.sameAs = cfg.sameAs;

            var existing = document.getElementById("local-business-jsonld");
            if (existing) existing.remove();
            var script = document.createElement("script");
            script.id = "local-business-jsonld";
            script.type = "application/ld+json";
            script.textContent = JSON.stringify(schema);
            document.head.appendChild(script);
        })
        .catch(function () { /* no local-seo.json / offline - skip silently */ });
})();