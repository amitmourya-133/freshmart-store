# Local SEO — FreshMart

Goal: make FreshMart discoverable for "near me" and produce-delivery searches in
its city, without ever inventing facts (address, phone, ratings, hours, photos).

## Already in place (verified)

- `robots.txt` — public crawl allowed, sitemap declared.
- `sitemap.xml` — lists the six public, indexable pages (home, product-detail,
  subscription, signup, login, help). Auth pages (orders, profile, checkout,
  notifications, delivery) are intentionally not listed.
- `google74724763e7a514fa.html` — Google **site verification** token file. Keep
  it deployed at the root so the property stays verified.
- `index.html` head — canonical, robots index,follow, Open Graph tags and a
  `GroceryStore` JSON-LD block (name/url only — no fabricated contact info).
- Per-product SEO — `injectDetailSeo()` in `script.js` writes a distinct
  `<title>`, meta description, canonical `?id=` URL, OG + Twitter tags, and a
  `Product` JSON-LD with real price, INR currency and live
  InStock/OutOfStock availability. AggregateRating is only emitted from the
  server-computed rating/ratingCount (never invented).
- `local-seo.js` + `local-seo.json` — optional, config-driven
  `GroceryStore`/LocalBusiness enrichment. **Default `local-seo.json` is empty**,
  so no schema is injected until real fields are supplied. This honors the rule:
  Local SEO must never fabricate address, phone, ratings or hours.

## Owner follow-ups (manual, no automation)

These cannot be "built" by code — they are Google Business Profile / listing
tasks, listed so a human can complete them without guessing:

1. **Google Business Profile** — create/claim the profile. Use the organisation's
   real trading address/service area + verified phone. Add operating hours,
   real photos, and a booking/order link to `https://freshmart-store-jet.vercel.app/`.
   Fill `sameAs` / `address` / `phone` in `local-seo.json` ONLY afterwards, then
   redeploy — the LocalBusiness schema then becomes truthful and indexed.
2. **Search Console** — finish ownership (token file above) and submit
   `https://freshmart-store-jet.vercel.app/sitemap.xml`. Verify indexation of
   the six public pages.
3. **NAP consistency** — use the identical Name / Address / Phone string across
   GBP, the site and any directories (the schema block reads the same values).
4. **Ratings** — real customer ratings already feed AggregateRating on product
   pages from server data; no review count is ever invented.

## Why no server-side SSR for SEO

FreshMart is a client-rendered SPA. Rich structured data and per-page metadata
are injected in `<head>` at runtime via `local-seo.js` and `injectDetailSeo()`
(Google executes JS and reads injected JSON-LD). If the catalog later demands
true SSR crawling, add a server-rendered `robots`-friendly product page layer —
out of scope for this phase.