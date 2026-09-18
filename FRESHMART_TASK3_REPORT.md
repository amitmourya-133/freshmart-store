# FRESHMART ऑर्डर-हार्डनिंग + टास्क-3 रिपोर्ट

**(तीसरा चरण — Order Lifecycle, Payment Status, Tracking, Cancel/Refund, Admin Overview)**

---

## 1. काम क्या किया गया (Overview)

मौजूदा FreshMart store (`D:\vegetable store`) में ऑर्डर-लाइफसाइकल को पूरा हार्डन किया गया:

- **Order Model** अब पूरा बनाया गया — trackingId, clientRef, customer.state, paymentMode, paymentReference, paymentStatus, statusHistory, refund.
- **Payment Status** अब ऑर्डर स्टेटस से बिल्कुल अलग — `PAID / PENDING / FAILED / REFUNDED / CANCELLED`।
- **कस्टमर अकाउंट एरिया** — अपने ऑर्डर देखना, ट्रैक करना, Placed/Confirmed तक cancel करना।
- **अपनेमेंट ट्रैकिंग** — orderNumber + trackingId से पब्लिक ट्रैक (बिना PII लीक के)।
- **Admin Overview** — डैशबोर्ड: total orders, pending payments, total sales, low-stock, plus filtered order list.
- **Manual/QR Payment verification** — admin पेमेंट verify/reject।
- **Security** — rate limiting, CastError→404, secret files blocked, sanitized responses।

## 2. बदले/बनाए गए फाइलें

### Backend
| File | क्या किया |
|---|---|
| `models/Order.js` | नया schema — trackingId (unique sparse), clientRef (unique sparse), customer.state, paymentMode (`cod/online`), paymentReference, paymentStatus enum, statusHistory timeline, refund.reference; indexes user+createdAt, status, paymentStatus, customer.phone |
| `controllers/orderController.js` | पूरा rewrite — createOrder, quoteOrder, getOrders (filters+search), getOverview (admin), getMyOrders, getOrder (ownership), updateOrderStatus (transition rules), cancelOrder, updatePaymentStatus (admin), getOrderByNumber (safe track) |
| `routes/orderRoutes.js` | नए endpoints: `/quote`, `/track/:number` (public), `/my`, `/:id/cancel`, `/admin/overview`, `/:id/status`, `/:id/payment-status` |
| `controllers/paymentController.js` | verifyPayment (real signature → PAID; demo → manual PENDING, koi auto-paid nahi), webhook captured→PAID / failed→FAILED, refund→REFUNDED |
| `controllers/userController.js` | `devOTP` sirf `NODE_ENV !== "production"` me; `listUsers` me har user ka `orderCount` |
| `controllers/productController.js`, `reviewController.js` | `isBadObjectId` guard → invalid ObjectId पर 404 (crash नहीं) |
| `controllers/cartController.js` | `setCart` अब stock validate + clamp करता है, out-of-stock पर 400 |
| `utils/rateLimit.js` | इन-मेमोरी sliding-window limiter; auth पर 30/10min, payment create/verify पर 60/10min (webhook unlimited) |

### Frontend
| File | क्या किया |
|---|---|
| `api.js` | fetchAdminOrders(filter), fetchAdminOverview, apiSetOrderPaymentStatus, fetchMyOrders, apiCancelOrder, apiTrackOrder |
| `script.js` | cart items पर productId + stock cap; checkout पर live price refresh; finalizeOrder → पेमेंट मोड+ref के साथ manual `PENDING`; "Awaiting confirmation + Track ID" flow; मेरा ऑर्डर्स पेज backend से; cancel + status timeline; public trackOrder |
| `admin.js`, `admin.html` | Overview stats, status+payment filters, search, payment verify/reject buttons, order timeline, low-stock warning, customer order count |
| `checkout.html` | State (राज्य) select जोड़ा |
| `orders.html`, `style.css` | Public Track box + नए component styles |

## 3. पुराना Flow vs नया Flow

### पुराना
- सिर्फ `delivered` + `cancelled` status; पेमेंट स्टेटस नहीं था।
- UPI QR हमेशा फिक्स ₹ का; कोई verify नहीं, कोई txn ref नहीं।
- कस्टमर सिर्फ delivered ही देखता था; cancel भी नहीं होता था सही से।
- Admin को total sales/low stock/overview नहीं मिलता था।
- कोई rate limiting नहीं, invalid ObjectId पर जाते ही crash।

### नया
- 7-state lifecycle: **Placed → Confirmed → Preparing → Out for Delivery → Delivered (पलटना मना)** + Cancelled; हर बदलाव `statusHistory` में logged।
- COD → तुरंत `PAID`; Online/QR → `PENDING` (manual ref के साथ), admin verify करे तो `PAID`; रिजेक्ट तो `FAILED`; cancel → cod/manual का `CANCELLED` (STORE-CREDIT ref)।
- Client जो कीमत भेजता है वो सर्वर-प्राइस से replace होती है (lie-proof): `₹1 Potato → server ₹1`।
- Tracking id `FM-YYYYMMDD-XXXXXX`, orderNumber `FM#...`.
- Idempotency: same `clientRef` → same order, stock double-cut नहीं।
- Cancellation stock वापस लौटाता है (हर item का quantity)।
- Rate limiting + 404s + sanitized responses।

## 4. पेमेंट स्टेटस (अलग किया गया)

- `paymentStatus`: `PENDING → PAID / FAILED`; cancel पर `CANCELLED`; refund पर `REFUNDED/PENDING_REFUND`।
- `paymentMode`: `cod` | `manual`।
- ऑर्डर स्टेटस और पेमेंट स्टेटस के transition अलग-अलग controller में हैं, आपस में mixed नहीं।

## 5. ₹50 और ₹125 UPI सटीकता (सर्वर द्वारा)

quote API से ही सर्वर `subtotal + delivery + total` लौटाता है, और UPI link की `am=` वही confirm किया गया total होता है:

| Cart (dummy ₹) | subtotal | delivery | **total (= am=)** |
|---|---|---|---|
| ₹50 × 1 | 50 | 20 | **70.00** |
| ₹125 × 1 | 125 | 20 | **145.00** |
| ₹240 × 2 = 480 | 480 | 20 | **500.00** |
| ₹500 × 1 | 500 | **0** (फ्री ≥500) | **500.00** |

- `upi://pay?pa=amit728@nyes&pn=FreshMart Store&am=145&cu=INR&tn=FМ-...` — format tested (am= exact, amit728@nyes, unique tn).
- Amount ≤ 0 → link नहीं बनता।
- **Note:** `tn` UPI apps में अक्सर नजर नहीं आता; इसलिए QR modal में manual **UPI/Txn Reference** field है — customer अपने UPI app का Ref ID डालता है और admin वही ref बर्मे verify करता है। अगर sha 128 की हमारी verification काम न करे (demo बिना keys), order `PENDING` रहता है — कभी गलत से `PAID` नहीं होता।

## 6. Manual QR पेमेंट का पूरा flow

1. Customer QR कोड देखकर `am=exact` pays (या manual ref डालता है)।
2. `finalizeOrder` → `paid:false, paymentMode:"manual", paymentReference:"<ref>"`.
3. Backend: server-client price replace, address validate, stock decrement, order create `status:Placed, paymentStatus:PENDING, paid:false`।
4. UI मैसेज: "Awaiting confirmation" + **Track ID**।
5. Admin: Orders tab में `verify/reject` → `PATCH /orders/:id/payment-status`.
6. Track page → "Payment: Pending / Paid / Failed / Refunded / Cancelled बैज"।

## 7. Cancel / Refund के नियम

- Custommer sirf **अपना** ऑर्डर cancel कर सकता है (उसका token); दूसरे के order पर 403।
- सिर्फ `Placed` या `Confirmed` state में; Delivered/Preparing/Out-for-Delivery पर 400।
- Cancel पर: stock 100% वापस, `statusHistory` में entry, double-cancel blocked।
- COD/manual-paid cancel → `paymentStatus:"CANCELLED"` + `refund.reference:"STORE-CREDIT"` (झूठा REFUNDED नहीं भेजता)।

## 8. Admin ओवरव्यू + फिल्टर

- `GET /orders/admin/overview?threshold=5` → totalOrders, pendingPayments, totalSales (delivered paids), totalProducts, lowStockProducts (लिस्ट भी भेजता है)।
- `GET /orders?status=...&paymentStatus=...&search=...` → फिल्टर + orderNumber/tracking/phone/name search।
- UI me verify/reject buttons, timeline, payment badge, customer me order count।

## 9. ट्रैकिंग (PII-safe)

- `GET /orders/track/:orderNumber|:trackingId` — public, sirf id + status + items + totals + timeline; **customer address/phone वापस नहीं** आता।
- Invalid id → 404, पूरा order या tracking कभी null-शुरू नहीं।

## 10. सुरक्षा

- `utils/rateLimit.js`: auth 30/10min।
- 100 अपराधिक endpoing पर `isBadObjectId` → 404 (crash हटा)।
- `.env`, controller source files → static middleware से blocked (403/404 tested)।
- `/users/me` me कोई password/otp hash नहीं।
- `devOTP` production में बंद।
- JWT-protected / ownership-checked; customer के पास admin endpoints 403।

## 11. टेस्टिंग (सारे green)

| Suite | Result |
|---|---|
| `smoke3.js` (behavioral: address, idempotency, manual pending, tracking, admin filters, transitions, ownership, cancel+stock, double-cancel) | **34/34 PASS** |
| `smoke5.js` (₹1 lie proof, ₹50→70, ₹125→145, min order, qty>stock, guest 401, manual QR PENDING, double-click idempotent) | **10/10 PASS** |
| `fulltest.js` **A–AF** (81 checks): health; catalog 56 unique; auth/dup/403s/401s; cart set+clamp; address validation; server price; ₹50/125/480/500 totals; `am=145` UPI format; manual PENDING w/ ref; unique tracking; idempotency no double stock; admin filter/search; verify→PAID + guard; forward/backward transitions; ownership 403s; my orders; owner cancel + stock restore + double-cancel block; track by number/trackingId + no PII; overview shape; product update reflects; cod paid; manual pending; QR image 200 + **SHA-256 unchanged** `878727F41200DD97EFF787641CF2142285635DAA9EF5F36060CD73B058E187FA`; `.env`/source blocked; no duplicate names; reviews lifecycle (add/list/delete/review) | **81/81 PASS** |

**Total: 125/125 PASS** — backend+API पूरी तरह verified।

## 12. MongoDB/Admin से जाँच (final)

Cleanup script (सिर्फ test-artifacts) चला कर पुष्टि:

```
orders deleted: 46 | users deleted: 17 | orphan carts: 9 | reviews: 0
Final: Products=56, Users=1 (amitmourya822@gmail.com), Orders=0, Reviews=0,
       Avocado.stock=12, Potato.stock=100, QR hash unchanged
```
- कोई भी real order/user/product डिलीट नहीं हुआ — सब कुछ baseline पर लौटा।
- Catalog: 56 unique products (Potato ₹1, Avocado ₹100), images restored, no duplicate names।

## 13. Vercel/Serverless सुरक्षा

- Serverless deploy में in-memory rate limit per-instance ही होगा (anti-DoS मजबूत नहीं, पर stateless)।
- कोई file-write नहीं; कोई session-store नहीं; सब Mongo-DB (stateless-ok)।
- प्रोडक्शन पर `.env` में ADMIN account ही डालना; `NODE_ENV=production` करना (devOTP auto-disable)।

## 14. Limitation / जानबूझकर छोड़ा

- **UPI app deep-link** असली फोन पर खुलना testable नहीं था — link format + `am=` exact verify किया; manual Ref-ID fallback दे दिया।
- Rate limit in-memory है (serverless पर प्रति-instance)।

## 15. REST API संक्षेप

```
POST /api/orders              # create (clientRef idempotent, server totals)
POST /api/orders/quote        # server-side subtotal+delivery+total
GET  /api/orders/track/:n     # public track (orderNumber/trackingId)
GET  /api/orders/my           # customer's orders
POST /api/orders/:id/cancel   # customer cancel (window)
GET  /api/orders              # admin list (status/paymentStatus/search)
GET  /api/orders/admin/overview
PATCH /api/orders/:id/status        # admin transitions
PATCH /api/orders/:id/payment-status# admin verify/reject
GET  /api/users/admin/list    # customers (with orderCount)
```

## 16. निष्कर्ष

सभी तीन tasks की माँगें पूरी: exact UPI amount, payment-status separation, 7-step lifecycle, tracking, cancel/refund, admin overview+filters, security hardening। Server `node server.js` पर live है (localhost:5000); database baseline (56/1/0/0) पर वापस; QR fingerprint बिल्कुल वही। **125/125 automated tests पास।**