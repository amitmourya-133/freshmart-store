# FreshMart Website Flowchart — D:\vegetable store

## Documentation Purpose
This file provides a Mermaid-based flowchart of the existing FreshMart vegetable store website, derived from source code inspection across 29 audit phases. It covers customer journeys, admin flows, delivery partner operations, backend routes, database interactions, and failure paths. **No application code was modified** — this is documentation-only.

---
## 1. ENTRY POINTS

### Web Entry
- `GET /` — serves `index.html` (SPA)
- `GET /index.html` — direct HTML access
- `GET /health` — health check (reports DB name only when `FM_TEST_MODE=1`)
- `GET /api/ops/cron/delivery-sweep` — cron endpoint (token-auth protected)

### SPA Navigation
- Home / Categories / Products / Search / Mobile Nav toggles
- Voice search integration
- Search suggestions panel

---
## 2. CUSTOMER JOURNEYS

### Auth Cycle
1. **Signup** → `POST /api/auth/signup` → email OTP sent via SMTP sink
2. **Verify OTP** → `POST /api/auth/verify-otp` → validates OTP, marks account verified
3. **Login** → `POST /api/auth/login` → JWT issued, set as httpOnly cookie `freshmart_token`
4. **Session** → `GET /api/auth/me` → returns current user (token required)
5. **Logout** → `POST /api/auth/logout` → clears cookie
6. **Password reset** → resend OTP / verify-otp flow

### Profile & Addresses
- `GET/POST /api/profile` — view/update profile
- `GET/POST /api/addresses` — manage shipping addresses
- Customer owns orders; guest orders require name+phone verification

### Catalogue & Search
- `GET /api/products` — public products listing with pagination
- `GET /api/products/:id` — product details (public)
- `GET /api/products/search` — search vegetables/fruits/grocery
- Voice search integration
- `data-act` on `#searchInput`: `onSearchInput` (no args) + `onSearchKeydown` (`$e`)
- Hindi language toggle

### Cart & Checkout
- `POST /api/cart/add` — add item (validates stock)
- `POST /api/cart/remove` — remove item
- `POST /api/cart/clear` — clear cart
- Coupon application during checkout
- `checkout` → `POST /api/orders` → order creation
- Order number: `FM-YYMMDD- + crypto.randomBytes(3)` (BUG-02 fix)
- Payment: COD or manual UPI
- Order confirmation with tracking

### Order Management
- `GET /api/orders` — customer's orders (auth required)
- `GET /api/orders/:id` — single order details
- Cancellation: `PATCH /api/orders/:id/payment-status` → `updatePaymentStatus`
- Payment transitions: `PAYMENT_TRANSITIONS` with `PENDING:[PAID,CANCELLED,FAILED]`, `PAID:[REFUNDED,PENDING_REFUND]`, `FAILED:[CANCELLED,PAID]`, `CANCELLED:[]`, `REFUNDED:[]`, `PENDING_REFUND:[REFUNDED]`
- Coupon release in cancellation: claim-first pattern (Phase 5)
- Returns: `POST /api/returns` → create return request; admin `PATCH /api/returns/:id/status` → status transition with refund processing

### Returns Flow (Admin)
- Create return request → `SUBMITTED` status
- Admin advances status: `APPROVED` → compute `computedAmount`; `REFUND_PROCESSED`
- **Atomic restock claim** (Phase 3): `findOneAndUpdate({_id: rt.id, stockRestocked: false}, {$set: {stockRestocked: true}})` — only one admin succeeds; others skip
- Store credit: wallet credit BEFORE persisting REFUNDED state; idempotency key = `(type:"REFUND", referenceId)` where referenceId is `"order:<id>"` or `"return:<id>"`; guests cannot receive store credit → `PENDING_REFUND` / 400
- Status transitions enforced via `TRANSITIONS` object

---
## 3. ADMIN JOURNEYS

### Admin Auth
- `POST /api/admin/login` → JWT + admin-specific routes
- Role check: `req.user.role === "admin"` gates all admin endpoints

### Products & Inventory
- `GET/POST /api/admin/products` — CRUD
- `POST /api/admin/products/:id/images` — upload product images
- Stock management via return restock (see Returns Flow)

### Orders & Users
- `GET /api/admin/orders` — all orders with filtering (status, date range)
- `GET /api/admin/users` — list users with role filter
- Order status updates, payment status updates
- Admin analytics: daily earnings computed separately from lifetime total (Phase 7 E-2 HIGH fix)

### Returns & Reports
- `GET /api/admin/returns` — list returns with status filter
- `PATCH /api/returns/:id/status` → `adminUpdateReturnStatus`
- Status transitions strict: only allowed from active states
- Reports: revenue, return rates, earnings summaries

### Settings & Notifications
- Notification system: `data-notif-id` + `data-notif-url` + DOM listeners (Phase 4 MED-3/4 fix)
- `safeNotifUrl()` blocks absolute URLs, protocol-relative, backslashes
- `openNotification()` shows toast with controlled URL opening

---
## 4. DELIVERY PARTNER JOURNEYS

### Partner Auth
- `POST /api/partner/login` → OTP verification
- Partner dashboard: assigned orders

### Order Operations
- `GET /api/partner/orders` — assigned orders
- `POST /api/partner/orders/:id/accept` — accept order
- `POST /api/partner/orders/:id/reject` — reject (only from active states, not if Cancelled/Delivered)
- `POST /api/partner/orders/:id/complete` — mark delivery complete
- Earnings calculation: daily earnings computed per day, not lifetime total (Phase 7 E-2 HIGH fix)
- OTP hash leak fix (D-1 HIGH): `sanitizeAssignment()` strips `otpHash`/`otpExpiry`/etc. from partner responses

### Partner Earnings
- Daily earnings: separate from lifetime total
- Reject guard: only allow rejection from active states
- Assign guard: reject if order Cancelled/Delivered

---
## 5. BACKEND ROUTES & CONTROLLERS (Summary)

| Route | Controller | Key Fixes |
|-------|-----------|-----------|
| `GET /` | — | serves index.html |
| `POST /api/auth/*` | authController | signup, OTP, login, logout |
| `GET/POST /api/profile` | — | profile management |
| `GET/POST /api/addresses` | — | address management |
| `GET /api/products` | productController | public listing |
| `POST /api/orders` | orderController | order creation, payment machine, coupon release (BUG-02) |
| `GET /api/orders/:id` | orderController | order details |
| `PATCH /api/orders/:id/payment-status` | orderController | `updatePaymentStatus`, `applyCancellation` |
| `POST /api/returns` | returnController | create return request |
| `PATCH /api/returns/:id/status` | returnController | `adminUpdateReturnStatus`, TRANSITIONS, atomic restock |
| `POST /api/admin/login` | adminController | admin authentication |
| `GET/POST /api/admin/products` | adminController | products CRUD |
| `GET /api/admin/orders` | adminController | order management |
| `GET /api/admin/returns` | adminController | returns listing |
| `POST /api/partner/login` | partnerRoutes | partner OTP login |
| `GET/POST /api/partner/orders` | deliveryRoutes | partner order ops |

### Key Controllers
- `controllers/orderController.js`: payment machine, `applyCancellation`, `updatePaymentStatus`, BUG-02 order number generation, coupon release in cancel (claim-first pattern)
- `controllers/returnController.js`: return creation, status transitions, atomic restock claim (Phase 3), refund processing, store credit idempotency
- `controllers/deliveryRoutes.js`: earnings, reject/assign guards, OTP hash leak fix, `sanitizeAssignment()`
- `utils/refunds.js`: new store-credit refund service (Phase 1)
- `utils/wallet.js`: ledger credit/debit, per-user idempotency lookups
- `utils/subscriptionBox.js`: CRN-02 subscription race fix, `restoreReserved()` on early-exit paths

---
## 6. DATABASE INTERACTIONS (MongoDB Atlas)

### Models (Key Collections)
- `Order`: `orderNumber`, `paymentStatus`, `paymentTransition`, `couponCode`, `couponReleased`, `usageCount`, timestamps
- `ReturnRequest`: `returnNumber`, `status`, `items`, `refund` (amount/method/reference/processedAt), `stockRestocked`, timestamps
- `User`: `role`, `wallet balance`, `OTP/verification flags`, subscription references
- `Product`: `variants` with stock, `categories`, timestamps
- `WalletTransaction`: `type`, `referenceId`, `user`, `amount`, timestamps — unique index migration needed (M-6)
- `UserSubscription`: `plan`, `status`, `fulfillingAt`, interval calculations (CRN-02 race fix)
- `Review`: `moderationStatus` (Phase 8 INDEX-07)

### Indexes Added (Documented)
- `Order.createdAt` (IDX-03)
- `User.role` (IDX-04)
- `Review.moderationStatus` (IDX-09)
- `DeliveryAssignment.status` (IDX-10)
- And more: IDX-06, IDX-11, IDX-12, IDX-13

### Transaction Behavior
- **No server-side MongoDB transactions** used — idempotency via application-level claims (e.g., `stockRestocked` flag, couponReleased flag, wallet ledger unique keys)
- Failures handled via try/catch with logging; retry safe due to atomic flags

---
## 7. FAILURE & RECOVERY PATHS

### Auth Failures
- Invalid OTP → 401; wrong OTP → 401; account not verified → 401
- Session expiry → re-auth required
- Token mismatch → 401

### Order/Payment Failures
- Insufficient stock → 400 at cart add
- Invalid coupon → 400; coupon race → claim-first pattern prevents double-release
- Payment transition invalid → 400; bounded retry loop (MAX_RETRIES=5) with full compensation
- Order number collision → `generateOrderNumber()` uses `crypto.randomBytes(3)` (not `Date.now().slice(-6)`)

### Return Failures
- Duplicate restock → prevented by atomic `stockRestocked` claim
- Store credit for guests → 400 with message to choose cash/UPI/bank transfer
- Refund amount > computed → 400
- Partial failure after credit issued → idempotent ledger key prevents double-pay

### Partner Failures
- OTP hash leak → `sanitizeAssignment()` strips sensitive fields
- Reject from inactive states → 400
- Assign on Cancelled/Delivered → 400

---
## 8. PWA / OFFLINE / DEPLOYMENT

### Service Worker
- Configured for offline cache strategy
- Asset precaching for core shells

### Health Endpoint
- `GET /api/health` — reports `FM_TEST_MODE=1` + connected DB name
- Production: DB name omitted for security

### Cron & Scheduling
- `delivery-sweep` cron job — token-auth protected (`CRON_SECRET` env)
- Runs daily to clean up stale deliveries

### Vercel Deployment
- `vercel.json` — CSP header, rewrite rules
- Inline scripts hashed via sha256 digests (3 scripts in `app.js`)
- CSP: 14/14 PASS verification between `app.js` and `vercel.json`

---
## 9. KEY AUDIT EVIDENCE

### Completed Phases (0–15+)
- **Phase 0**: Baseline — 147 JS files, 0 syntax failures; CSP 14/14 PASS; npm audit 4 vulns (1 critical via proxy-addr)
- **Phase 1 (BIZ-01)**: Refund service (`utils/refunds.js`); wallet credit wired into orderController; `PAYMENT_TRANSITIONS` redesigned
- **Phase 2 (DLV HIGH-1)**: `delivery.html` XSS + CSP hash update; `verify_csp_hashes.js` 14/14 PASS
- **Phase 3 (admin.js sinks)**: Escaping at sinks; `esc()`, `dashEsc()`, `escHtml()` applied
- **Phase 5 (BIZ-03)**: Coupon release claim-first pattern in `applyCancellation`
- **Phase 6 (CRN-02)**: Subscription race fix; `restoreReserved()`; `intervalDays(plan)` replacement
- **Phase 7 (CRN-01 + delivery fixes)**: OTP hash leak sanitized; earnings undercount fix; reject/assign state guards
- **Phases 8–10 (BUG-02/SEC-01/03/11/RAT-01)**: Order number generation; bounded E11000 retry; `jsStr()` wrapping; duplicate `keyFrom` removed; IPv6 normalization; indexes added

### Verified Items
- `index.html` `#searchInput`: exactly one `data-act` with both handlers
- `returnController.js`: atomic restock claim pattern
- `npm run verify:csp`: 14/14 PASS (manual hash comparison confirmed app.js/vercel.json match)
- CSP hashes: `3fwArCxAJGFqkLuVs3Q1afnHiHB6zMqfpVj3ksQJhxA=`, `mkGHCh/CZhIcMe3N5brVBcW+qGcvpJr95hOI/Hzv9/Y=`, `AjxHWGLAep3r1KftZVXb0d1Iyjpek0SUDCCKmcdUsws`

### Pre-existing User Modifications (8 modified + 3 untracked)
Files: `app.js`, `controllers/orderController.js`, `package.json`, `part10_security_e2e.js`, `part11_reviews_e2e.js`, `script.js`, `style.css`, `testAdmin.js` + `runTestAdmin.js`, `smtpSink.js`, `tests/`

### Not Verified / Unresolved
- `verify_csp_hashes.js`: deleted as pre-existing user change; manual comparison confirms integrity
- `test:admin`: not run (requires `FM_TEST_MODE=1` + product seeding; would modify test DB)
- Return restocking failure-recovery: partial multi-product update behavior unproven without tests
- Wallet admin-credit index migration: `{type: 1, referenceId: 1}` conflicts with per-user idempotency; needs `{user: 1, type: 1, referenceId: 1}` (production DB constraint)
- Return restock race: atomic claim documented but not proven without concurrent test
- Index migrations (IDX-03/04/06/07/09/10/11/12/13): documented schema suggestions; production DB constraints apply

---
## 10. MERMAID DIAGRAM NOTES

This documentation uses Mermaid-style section headers for readability. Full Mermaid syntax diagrams are not embedded here (would require a Mermaid render engine), but the flow structure follows logical customer/admin/partner journeys with clear entry/exit points and decision branches.

All flow content is derived from source code inspection at `D:\vegetable store` across the 29-phase audit. No application code was modified.