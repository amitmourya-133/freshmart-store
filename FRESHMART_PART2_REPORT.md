# FRESHMART PART 2 — IMPLEMENTATION REPORT

**Scope:** Part 2 of the delivery-platform build-out for FreshMart (local Express + MongoDB, Vercel serverless frontend). All work is additive/backward-compatible. No user data was modified, no product prices/stock were touched, no collections were deleted or reset.

---

## 1. FIXED (working but broken → repaired in place)

| # | Item | What was wrong | Fix |
|---|------|----------------|-----|
| P0-1 | `paymentController.getPaymentStatus` | IDOR — any logged-in user could read `?orderId=` of any order | Now requires a valid ObjectId **and** owner (`order.user === req.user._id`) or admin; route already `protect`. 403 otherwise. |
| P0-4 | `subscriptionRoutes.js` | Param routes (`/:planId`) shadowed literal admin routes (`/plans`, `/admin/all`, ...); subscribe/cancel had no ObjectId validation | Route file fully reordered (literals before params) + `isValidObjectId` guard on every `:planId`/`:subscriptionId`. |
| P0-5 | `userController.updateMe` | Update payload treated as raw body (whitelist only for *token* flows); double bcrypt hash risk; no address operations | Rewritten: `allowedUpdates` whitelist (`name, phone, addresses, password, deleteAddressIndex, setDefaultIndex`), password hashed once by the model pre-save, `addresses` replaces the array, `deleteAddressIndex`/`setDefaultIndex` splice/reset atomically. `bcrypt` import added. |
| P0 (COD) | `orderController.createOrder` | COD orders created `paid:true`/`paymentStatus:"PAID"` at creation | COD now created `paid:false` / `paymentStatus:"PENDING"` / `paymentMode:"cod"`. Payment completes at **DELIVERED** via the delivery `completeOrderDelivery` sync (COD only). Non-COD paths unchanged. |
| P1 (ratings) | `productController.addRating` | `rating + parseFloat(...)` string concat → `NaN` | `Number(rating)` + `Number.isFinite` + 1–5 bounds. |
| P1 (reviews) | `reviewController.addProductReview` | Client-supplied `user` in body could fake identity; per-user dedupe missing | Review tied to `req.user._id` (client `user` ignored), logged-in users 409 on duplicate product review, numeric coercion + `Number.isFinite`. |
| P1 (frontend) | `subscription.html` inline script | SyntaxError (`cancelSubscription` broken) + called `POST /api/subscriptions/<price>` (planId = price) | Inline script replaced with `subscription.js`; buttons renamed to `btnConfirmSubscription` / `btnCancelSubscription`; static cards → loading placeholder; `subscription.js` now the single source of truth. |
| P1 (frontend) | `delivery.html` | Relied on `window.freshmartToken` (never set — cookie-only auth); action buttons enabled at wrong statuses; OTP sent as `otpCode`; invalid `#6c75` style; earnings fields wrong | Cookie-auth `checkDeliveryAuth` (GET `/api/users/me`, role `delivery`); `createAssignmentCard` disabled-logic correct per status (Accept/Reject → ASSIGNED, Pickup → ACCEPTED, Start → PICKED_UP, Proof+Deliver → EN_ROUTE); sends `otp`; earns from `today/week/month`; `isAvailable` from profile; color fixed. |
| P1 (frontend) | `admin.js` delivery tab | Backend returns `online`, frontend read `isOnline` (partner cards empty) | `((p.online !== undefined) ? p.online : p.isOnline)` (3 sites) + enriched card with phone / last location / last seen. |
| P1 (frontend) | `profile.html` | No data binding at all (empty shell; never called `initProfile`) | Full wiring — see IMPLEMENTED. Added `data-page="profile"`, gated page, `initProfile`. |
| (Build) | `models/Payment.js` | Duplicate index: `unique:true` on `order` **and** `paymentSchema.index({order:1})` → mongoose startup warning | Removed the redundant explicit index (same index, zero behavior change). Startup log clean. |
| P1 (latent) | `orderController.getOrder` | `populate("user", ...)` turns `order.user` into a Document, then the owner check `String(order.user) === String(req.user._id)` compared `"[object Object]"` — **owners got 403 on their own order detail**. Caught by the new E2E harness (step 29) | Owner id resolved as `order.user._id ?? order.user` before the comparison. Owner works; admin unchanged. |

---

## 2. IMPLEMENTED (new functionality / replacement)

### 2.1 Delivery lifecycle — P0/P1
- `routes/deliveryRoutes.js` (rebuilt earlier, verified + dependencies confirmed in Part 2):
  - `/assign` (admin) — creates a `DeliveryAssignment`, generates a private 4-digit OTP, stores **only its SHA-256 hash** (`otpHash`, `otpExpiry` 15 min, `otpAttempts:0`), emails the plain OTP via `emailService.sendOtpEmail({to: order.customerEmail, otp, purpose})`. Order → status `Out for Delivery` + history entry.
  - `/today` (delivery) — today/later assignments populated with `orderNumber, items, total, status, paymentStatus, paymentMethod, deliverySlot, customer{name,phone,address}, customerEmail`.
  - `/accept`, `/reject`, `/status` (delivery) — forward-only movement by rank (ASSIGNED→ACCEPTED→PICKED_UP→EN_ROUTE→DELIVERED). **DELIVERED requires a valid OTP**: 15-min TTL, max 5 attempts, single-use, 400 on ALL attempts exhausted / expired / wrong OTP. On success syncs the Order via the inline `completeOrderDelivery` helper (status `Delivered` + `statusHistory`; marks payment PAID **only when COD**; Razorpay/manual stay PENDING).
  - `/earnings` (delivery) — `{totalEarnings, completedCount, today, week, month, deliveries}`.
  - `/availability`, `/location` (delivery) — toggles `User.isAvailable` / streams `lastLat,lastLng,lastLocationAt`.
  - `/proof-image` (delivery) — Cloudinary upload (guarded by `isCloudinaryConfigured`).
  - `/management/partners`, `/management/today` (admin).
- `models/DeliveryAssignment.js` — OTP-management fields (`otpHash/otpExpiry/otpAttempts/otpVerified`) added; the two indexes (`order`; `deliveryUser,status`) previously knocked out by an edit restored.
- `models/User.js` — `isAvailable` (default false), `lastLat`, `lastLng`, `lastLocationAt`.

### 2.2 Subscription platform — P0/P1
- Backend routes (`subscriptionRoutes.js`) — plans public list; `/my`; subscribe `POST /:planId` (rejects duplicate active subscription); `/pause`, `/resume`, `/cancel` (owner-scoped); admin CRUD (`/admin/all`,`/admin`,`/admin/:planId`).
- `utils/seedSubscriptionPlans.js` — **additive, guarded** bootstrapper: only inserts when `SubscriptionPlan` collection is empty. Plans: Basic Box ₹499, Standard Box ₹899, Family Box ₹1499 (weekly), `isActive:true`, enum-valid features. Wired into `server.js` and `api/index.js` (post-connect, non-fatal, dedupe flag). ✅ Verified seeded **3 plans** on restart.
- Frontend `subscription.js` (rewritten) + `subscription.html` — live plan cards from `GET /subscriptions/plans`, subscribe, "my subscription" state, pause/resume/cancel.

### 2.3 Customer profile — P1 (was an empty page)
- `profile.html` — `initProfile()` loads `/users/me`; edit name/phone/optional password (`PUT /users/me`); saved-address list with add / edit / delete / make-default using the backend address operations; address form pre-filled on edit; toast feedback; re-syncs header profile via `refreshAuthProfile()`.
- `script.js` — `"profile"` added to `AUTH_PROTECTED_PAGES`; `runPage()` gets a `profile` branch that invokes `initProfile()` (loaded after script.js on the page).
- All ids referenced by the inline script verified present in the HTML; inline script verified with `node --check` (11465 chars) and no global-name collisions.

### 2.4 Delivery-partner visibility in customer tracking — P1-5
- `orderController.js` — new `deliveryPartnerFor(orderId)` helper (latest assignment, populated partner):
  - `GET /api/orders/:id` (owner/admin) → `deliveryPartner: {name, phone}`.
  - `GET /api/orders/track/:number` (public) → `deliveryPartner: {name}` only — **never** phone/address in the public view.
- `script.js` — track result card shows "Assigned Delivery Partner" when present.

### 2.5 PWA — P2
- `manifest.json` — name, short_name, theme (#159447), standalone, icon.
- `sw.js` — **network-first** cache (same-origin GET statics only; `/api/*` never cached so order/payment data is always fresh), offline fallback to cached page/`index.html`.
- `script.js` `initPwaHooks()` — injects the manifest `<link>` and registers the SW on every page (skipped on insecure non-localhost origins).
- `app.js` — `.json` added to the served-extension whitelist (so `/manifest.json` is reachable in dev); package-lock/.env etc. remain blocked.
- `vercel.json` — additive builds for `sw.js` + `manifest.json` so the PWA doesn't 404 in production. ✅ `GET /manifest.json` and `/sw.js` → 200 locally.

---

## 3. VERIFIED (working as-is, checked in Part 2)

- `emailService` exports `sendOtpEmail` + `sendDeliveryConfirmation` (used by delivery routes).
- `cloudinary` exports `isCloudinaryConfigured` + `uploadImageBytes`.
- `deliveryRoutes` needs no `orderController.completeOrderDelivery` (private helper exists locally) — no import bug.
- Login POST is already rate-limited (`authLimiter`) — no change needed.
- `middleware/auth` `protect` attaches a full mongoose User doc → `req.user.id` and `req.user._id` both valid (mixed styles across controllers are correct).
- Order routes: `GET /my` and `GET /track/:number` pre-date this audit and are correct/secure.
- Server restart: MongoDB connects, `Seeded 3 default subscription plan(s)` (one-time), duplicate-index warning gone.

---

## 4. CHANGED (deliberate, additive behavior)

- COD orders now start `paymentStatus:"PENDING"` (was "PAID"); payment flips at delivery.
- Public tracking leaks strictly less (partner name only, no partner phone).
- `SERVED_ONLY_EXT` previously excluded all `.json` client files — now whitelisted.

---

## 5. ADDED (new files)

| File | Purpose |
|------|---------|
| `utils/seedSubscriptionPlans.js` | Guarded default subscription plan seed |
| `manifest.json` | PWA web app manifest |
| `sw.js` | Network-first service worker |

---

## 6. MODIFIED (files touched this part)

`models/User.js`, `models/DeliveryAssignment.js`, `models/Payment.js`, `controllers/orderController.js`, `controllers/userController.js`, `controllers/paymentController.js`, `controllers/reviewController.js`, `controllers/productController.js`, `routes/subscriptionRoutes.js`, `routes/productRoutes.js`, `server.js`, `app.js`, `api/index.js`, `subscription.js`, `subscription.html`, `profile.html`, `delivery.html`, `admin.js`, `script.js`, `vercel.json`.

---

## 7. DATABASE CHANGES (all additive, no data destroyed)

- **New fields** — `User.isAvailable, lastLat, lastLng, lastLocationAt`; `DeliveryAssignment.otpHash, otpExpiry, otpAttempts, otpVerified` (these indexes: `{order:1}`, `{deliveryUser,status}` restored).
- **New indexes removed noise** — duplicate `{order:1}` in `Payment` (was declared twice; index count unchanged).
- **Seeded data (guarded, idempotent)** — 3 `SubscriptionPlan` docs inserted once when the collection was empty. Existing static product catalog, users, orders, payments untouched.
- **No** `deleteMany` / resets / price or stock changes anywhere.

---

## 8. SECURITY

- OTP never stored in plaintext — only SHA-256 hash + expiry + attempt counter (15 min TTL, 5-attempt lockout, single-use). Plain OTP travels only to the customer email.
- `getPaymentStatus` — owner-or-admin enforcement (IDOR closed).
- `addProductReview` — server-authoritative identity, per-user dedupe.
- Profile `updateMe` — strict field whitelist; address ops bounded by index; password hashed exactly once.
- Tracking view strips PII (partner phone/address never exposed publicly).
- Service worker never caches `/api/*`.

---

## 9. TESTS

| Test | Result |
|------|--------|
| `node --check` — all 23 Part 2 JS files (server/app/api-index/models/routes/controllers/utils/frontend/sw/admin/api/features/help/script/subscription) | ✅ ALL OK |
| Inline scripts extracted to temp + `node --check` — `profile.html` (11465 chars), `delivery.html` (19072 chars) | ✅ OK |
| **Authenticated E2E harness** (`part2_e2e.js`, controlled test users, live server) — 49 steps | ✅ 49/49 **ALL PASS** |
| — subscription: subscribe / duplicate-rejected / my / pause / resume / cancel(+cancelDate) | ✅ PASS (6) |
| — profile: updateMe name+phone, password change (old creds rejected, new creds log in), address add / add 2nd / set-default / delete | ✅ PASS (5) |
| — orders: quote, COD create (`paid:false`, `paymentStatus:PENDING`, `paymentMode:cod`), owner detail view | ✅ PASS (3) |
| — payments IDOR: other user's payment status → denied; own → allowed | ✅ PASS (2) |
| — role enforcement: customer→delivery-admin 403, delivery→subscription-admin 403 | ✅ PASS (2) |
| — delivery: management partners, admin assign (OTP minted hash-only), partner attached to owner view, `/today` w/ customer, accept, backward-transition rejected, pickup, en-route | ✅ PASS (8) |
| — OTP: wrong rejected + attempts incremented, correct OTP recovered from hash in harness → DELIVERED, single-use (no re-transition), order → Delivered, **COD → PAID**, earnings updated, public track shows partner name only (no phone) | ✅ PASS (8) |
| — availability toggle → `isAvailable:true` reflected in admin partners | ✅ PASS (2) |
| — reviews: created w/ session identity, duplicate → 409, guest allowed but client `user` ignored | ✅ PASS (3) |
| — subscription admin CRUD: create / update / deactivate (enum-valid features) | ✅ PASS (3) |
| Server boot (fresh restart) — Mongo connect, seed message, no duplicate-index warning | ✅ |
| `GET /api/health` | ✅ 200 |
| `GET /api/subscriptions/plans` | ✅ 200 — returns the 3 seeded plans (Shape `{success, plans}` — frontend matches) |
| `GET /manifest.json`, `GET /sw.js` | ✅ 200 |
| `GET /api/orders/track/<unknown>` | ✅ 404 JSON (route serves, no 500) |
| `GET /api/users/me` (anonymous) | ✅ 401 (guard active) |
| `GET /api/subscriptions/my` (anonymous) | ✅ 401 |
| Static-blocking guard (`.env`, `package-lock.json`, controller sources) | ✅ Still blocked (P0 regression) |

### E2E notes
- The harness created 4 throwaway accounts (`.test` domain), one COD order + a second order (IDOR victim), one delivery assignment, one subscription, two reviews and one admin plan — **every artifact was deleted afterward** (verified: 0 remaining test docs), and the +1 product stock decrement per test order was restored to its original value (Pineapple 20). Seeded plans, catalog prices/stock and all real records were untouched.
- The delivery OTP is emailed to the customer; to exercise the DELIVERED step the harness recovered the 4-digit OTP from the stored SHA-256 hash locally (matching what the email would contain) — the API itself never sees the plaintext.

---

## 10. REMAINING / NOTES FOR PRODUCTION

- Authenticated flows are now **E2E-verified** (49/49 PASS) against the live server; the test accounts/orders were removed, so verify the seed plans live (`GET /api/subscriptions/plans`) and create real admin & delivery accounts for human use.
- PWA: enable/verify on `https://` production (SW requires secure context); confirm `vercel.json` serves `sw.js`/`manifest.json`.
- Nothing was committed or deployed (per instruction). Review with `git status` / `git diff` before deploy.

---

## 11. PER-FEATURE STATUS (KEEP / FIXED / ENHANCED / IMPLEMENTED / SKIPPED)

- **Catalog, cart, checkout (COD + Razorpay), orders, coupons, search/filters** → KEEP (working, not touched except COD payment-status fix + review/rating fixes).
- **Auth (cookie session, OTP, Google, forgot-password)** → KEEP (rate limits confirmed present; `optionalProtect` added to reviews).
- **Delivery partner platform (admin assign tab + partner app + OTP proof)** → KEEP (backend rewritten earlier) → ENHANCED in Part 2: OTP hash-only storage, management endpoints verified, partner cards fixed, delivery.html action matrix corrected, profile availability wiring.
- **Subscriptions** → IMPLEMENTED (backend routes + frontend + guarded seed).
- **Customer profile page** → IMPLEMENTED (was an empty shell).
- **Customer tracking + partner visibility** → ENHANCED (partner name/phone on owner view, name only on public track).
- **PWA (manifest + offline SW)** → IMPLEMENTED (production wiring added).
- **Anything not listed** → SKIPPED (not required by Part 2 spec / already working).

---

## 12. ADDENDUM — NOTES CENTER (R14)

In-app notifications inbox (in-app center now; web-push later). Additive — new collection + endpoints + frontend; nothing changed in existing behavior.

### Backend
- `models/Notification.js` (new) — `user` (indexed), `type` enum `["order_status","delivery_assignment","low_stock","subscription","payment","review","system"]`, `title`, `message`, `data` (Mixed), `read`, `readAt`, timestamps; indexes `{user, read}` and `{user, createdAt:-1}`.
- `controllers/notificationController.js` (new) — `notifyBase(userId, payload)` / `notifyRole(role, payload)` (fire-and-forget, never throw/block); `getMyNotifications` (owner-scoped, `?limit&skip&type&read`), `getUnreadCount`, `markAllRead`, `markRead` (valid ObjectId + owner; else 404).
- `routes/notificationRoutes.js` (new) — all `protect`: `GET /`, `GET /unread-count`, `PUT /read-all`, `PUT /:id/read`. Mounted at `/api/notifications` in `app.js` (works on dev + Vercel via `api/index.js`).
- **Event wiring** (fire-and-forget):
  - `orderController.createOrder` → customer **Order placed**; after stock decrement, **Low stock alert** to all admins (`notifyRole("admin")`) for products with stock ≤ 5.
  - `orderController.updateOrderStatus` / `cancelOrder` → customer **Order `<status>`** / **Order cancelled** (owner-only; guests skipped via `inboxNotify` guard).
  - `deliveryRoutes` `/assign` → partner **New delivery assignment**, customer **Delivery partner assigned**; on `DELIVERED` → customer **Order delivered**.
  - `subscriptionRoutes` subscribe/pause/resume/cancel → customer **subscription** notes.

### Frontend
- `notifications.html` + `notifications.js` — inbox list (type icon, relative time, unread styling), "Mark all as read", per-item "Mark read", View link uses the stored `data.link`; empty state.
- `script.js` — bell button with red unread badge injected into the logged-in header (`updateAuthHeader`), badge refreshed on render + every 60s; `"notifications"` added to `AUTH_PROTECTED_PAGES` + a `runPage` branch calling `loadNotifications()`.
- `api.js` — `apiFetchNotifications`, `apiUnreadCount`, `apiMarkNotificationRead`, `apiMarkAllNotificationsRead`.
- `style.css` — `.fm-notif-badge`, `.fm-notif-card` (additive).
- `vercel.json` — added static build for `notifications.js`.

### R14 tests (authenticated E2E harness `part3_notif_e2e.js`, controlled users + one controlled low-stock product)
| Test | Result |
|------|--------|
| `node --check` — all R14 JS files (model/controller/routes/order/delivery/subscription/app/api/script/notifications.js) | ✅ ALL OK |
| Fresh inbox: customer/delivery/admin/other all start with 0 notes | ✅ (4) |
| Controlled product (stock 6) → COD order → stock 5 | ✅ (2) |
| Customer receives **Order placed**; unread-count consistent with filter count; note shape (`_id,type,title,message,read,createdAt`) | ✅ (3) |
| Admin receives **Low stock alert** (≤5) | ✅ (1) |
| Inbox isolation: other user empty; IDOR mark-read of a stranger's note → 404 | ✅ (2) |
| Mark single read → `read:true` + `readAt`, unread decremented by 1 | ✅ (2) |
| Assign → partner gets **delivery_assignment** + customer gets **Delivery partner assigned** | ✅ (2) |
| Full lifecycle to **DELIVERED** (accept/pickup/en-route/local OTP recovery) → customer gets **Order delivered**; admin low-stock note persists | ✅ (2) |
| Mark-all-read → unread 0; inbox all read | ✅ (2) |
| Unauthenticated `GET /api/notifications` → 401 | ✅ (1) |
| **Total** | ✅ **30/30 ALL PASS** |
| Cleanup + `db_sanity_r14` | ✅ 0 test users/orders/assignments/payments/notifications/products remain; 3 seeded plans intact; `Notification` collection back to 0 (a harness side-effect fired `low_stock` to the two real admin accounts — those 4 notes were deleted to restore pre-R14 state) |

### R14 files
- ADDED: `models/Notification.js`, `controllers/notificationController.js`, `routes/notificationRoutes.js`, `notifications.html`, `notifications.js`.
- MODIFIED: `app.js`, `controllers/orderController.js`, `routes/deliveryRoutes.js`, `routes/subscriptionRoutes.js`, `api.js`, `script.js`, `style.css`, `vercel.json`.