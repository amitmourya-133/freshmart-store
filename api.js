// ===============================
// FRESHMART - API LAYER
// Handles backend calls with localStorage fallback
// ===============================

const API = {
    base: (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
        ? "http://localhost:5000/api"
        : "/api"
};

// ---------- AUTH SESSION ----------
// The session JWT now lives ONLY in an httpOnly cookie set by the backend at
// login / signup-verify / google-login and cleared at logout. The token is
// never written to localStorage (javascript / XSS cannot read httpOnly cookies)
// and it is sent automatically with every same-origin API call — no
// Authorization header is needed. getAuthToken() intentionally always returns
// null; remaining call sites use hasSession() for the "am I logged in?" signal.
function getAuthToken() {
    return null;
}

// No-op for backward compatibility: the JWT is delivered via the httpOnly
// cookie, so there is nothing to persist here. Old callers that invoke
// setAuthToken(data.token) after login keep working safely.
function setAuthToken(token) {}

// "Am I logged in?" — driven by the local UI flag, not by localStorage token
// presence. The actual credential is the httpOnly cookie the server sets.
function hasSession() {
    return readStorageValue("freshMartLoggedIn", "false") === "true";
}

function getAuthHeaders() {
    // The httpOnly cookie rides along automatically on same-origin calls; only
    // the JSON content type is needed (no readable Bearer token exists).
    return { "Content-Type": "application/json" };
}

// Check if backend is reachable (returns promise)
function checkBackend() {
    return fetch(API.base + "/health")
        .then(function(res) { return res.ok; })
        .catch(function() { return false; });
}

// ---------- PRODUCTS ----------
// Fetch products from backend, fallback to localStorage seed
function fetchProducts() {
    return fetch(API.base + "/products")
        .then(function(res) {
            if (!res.ok) throw new Error("Network error");
            return res.json();
        })
        .then(function(data) {
            return data.data;
        })
        .catch(function() {
            // Fallback: use the in-browser products array
            var local = (typeof products !== "undefined" && Array.isArray(products)) ? products : [];
            return local.map(function(p, i) {
                return {
                    _id: "local-" + i,
                    id: i,
                    name: p.name,
                    price: p.price,
                    unit: p.unit,
                    category: p.category,
                    emoji: p.emoji,
                    gradient: p.gradient,
                    description: p.description,
                    nutrition: p.nutrition,
                    tips: p.tips,
                    origin: p.origin,
                    stock: 50
                };
            });
        });
}

// ---------- ORDERS ----------
function submitOrder(order) {
    return fetch(API.base + "/orders", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(order)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Order failed");
            return data.data;
        })
        .catch(function(err) {
            // Fallback: save to localStorage
            return saveOrderLocally(order);
        });
}

// Get server-validated totals for the payment amount (no order is created).
// couponCode is optional; when present the server recomputes the discount.
function getOrderQuote(items, couponCode) {
    var body = { items: items };
    if (couponCode) body.couponCode = couponCode;
    return fetch(API.base + "/orders/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Could not calculate the order total");
            return data.data;
        });
}

// Create order on backend (returns full response, propagates errors)
function createOrderBackend(order) {
    return fetch(API.base + "/orders", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(order)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Order failed");
            return data;
        });
}

function saveOrderLocally(order) {
    return new Promise(function(resolve) {
        var orderNumber = "FM" + Date.now().toString().slice(-6);
        var saved = {
            orderNumber: orderNumber,
            customer: order.customer,
            items: order.items,
            payment: order.payment || "Cash On Delivery",
            subtotal: order.subtotal || 0,
            delivery: order.delivery !== undefined ? order.delivery : 20,
            total: order.total || (order.subtotal + 20),
            status: "Placed",
            date: new Date().toLocaleString()
        };

        var orders = [];
        var savedOrders = localStorage.getItem("freshMartOrders");
        if (savedOrders) {
            try { orders = JSON.parse(savedOrders); } catch (e) {}
        }
        orders.unshift(saved);
        localStorage.setItem("freshMartOrders", JSON.stringify(orders));
        resolve(saved);
    });
}

// ---------- SETTINGS (delivery policy + config) ----------

// Public read-only delivery policy (safe values only — customers can never edit).
function fetchShippingSettings() {
    return fetch(API.base + "/settings/shipping", { headers: { "Content-Type": "application/json" } })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load delivery settings");
            return data.data;
        })
        .catch(function() {
            // Offline fallback: keep the historical defaults (fewer surprises on the checkout page).
            return { deliveryCharge: 20, freeDeliveryThreshold: 500 };
        });
}

// Admin: read the full settings (delivery + low-stock threshold)
function apiGetSettings() {
    return fetch(API.base + "/settings", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load settings");
            return data.data;
        });
}

// Admin: update the settings (server-validated)
function apiUpdateSettings(data) {
    return fetch(API.base + "/settings", {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to update settings");
            return res.data;
        });
}

// ---------- AUTH ----------
function apiSignup(user) {
    return fetch(API.base + "/users/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(user)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Signup failed");
            return data;
        });
}

// Step 2 of signup: confirm the emailed OTP. Only on success does the backend
// issue the session JWT (set by this helper before returning).
function apiSignupVerifyOtp(email, otp) {
    return fetch(API.base + "/users/signup/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, otp: otp })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Email verification failed.");
            if (data.token) setAuthToken(data.token);
            return data;
        });
}

function apiSignupResendOtp(email) {
    return fetch(API.base + "/users/signup/resend-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Could not resend the code.");
            return data;
        });
}

function apiForgotPasswordRequest(email) {
    return fetch(API.base + "/users/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Could not send the OTP.");
            return data;
        });
}

function apiForgotPasswordVerify(email, otp) {
    return fetch(API.base + "/users/forgot-password/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, otp: otp })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "OTP verification failed.");
            return data;
        });
}

function apiForgotPasswordResend(email) {
    return fetch(API.base + "/users/forgot-password/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Could not resend the OTP.");
            return data;
        });
}

function apiForgotPasswordReset(resetToken, newPassword) {
    return fetch(API.base + "/users/forgot-password/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resetToken: resetToken, newPassword: newPassword })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Password reset failed.");
            return data;
        });
}

function apiLogin(creds) {
    return fetch(API.base + "/users/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(creds)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) {
                var e = new Error(data.message || "Login failed");
                if (data.needsVerification) e.needsVerification = true;
                throw e;
            }
            return data;
        });
}

// Real Google OAuth: POST the authorization code + CSRF state returned on the
// login page callback; the server exchanges and verifies the ID token.
function apiGoogleLogin(code, state) {
    return fetch(API.base + "/users/google-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code, state: state })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Google login failed");
            if (data.token) setAuthToken(data.token);
            return data;
        });
}

// Public probe: is Google OAuth configured server-side? (boolean only, no secrets)
function apiGoogleStatus() {
    return fetch(API.base + "/users/google-config")
        .then(function(res) { return res.json(); })
        .catch(function() { return { success: false, configured: false }; });
}

// ---------- AUTH SESSION HELPERS (customer entry flow) ----------

// Sanitized mirror of the logged-in customer (name/email/phone only — never a password)
function getAuthUser() {
    var raw = readStorageValue("freshMartUser", null);
    if (!raw) return null;
    try {
        var u = JSON.parse(raw);
        return u && typeof u === "object" ? u : null;
    } catch (e) {
        return null;
    }
}

function getAuthUserName() {
    var u = getAuthUser();
    var name = u && (u.name || u.displayName) ? String(u.name || u.displayName) : "";
    return name;
}

// Remember the requested page so the user is sent back there after login
function storeAuthRedirect(url) {
    if (!url) return;
    writeStorageValue("freshMartRedirect", String(url));
}

// Read (and consume) the saved post-login destination
function getAuthRedirect() {
    var r = readStorageValue("freshMartRedirect", null);
    localStorage.removeItem("freshMartRedirect");
    return r;
}

// Follow-up pages a customer may return to after login (never login/signup/admin)
function safeRedirectDestination(fallback) {
    var r = getAuthRedirect();
    if (r && /^(index|checkout|orders|product-detail|subscription)\.html/.test(r)) {
        return r;
    }
    return fallback || "index.html";
}

// End the session: ask the server to clear the httpOnly cookie AND wipe the
// local auth state. Safe to call when already logged out (server is
// idempotent); the local state is always cleared even if the server is down.
function apiLogout() {
    return fetch(API.base + "/users/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            clearAuthState();
            return data;
        })
        .catch(function() {
            clearAuthState();
            return { success: false };
        });
}

// Remove every auth artifact from local storage (logout / expired token)
function clearAuthState() {
    try {
        localStorage.removeItem("freshMartToken");
        localStorage.removeItem("freshMartLoggedIn");
        localStorage.removeItem("freshMartUser");
        localStorage.removeItem("freshMartRedirect");
    } catch (e) {}
}

// Enrich the stored auth profile (name/email/phone) with the backend role so the
// header can render the Admin shortcut only for real admins. This never grants
// access on its own - admin.html and every admin API still enforce auth on the server.
function refreshAuthProfile() {
    if (!hasSession()) return Promise.resolve(null);
    return apiGetMe().then(function(user) {
        var existing = getAuthUser() || {};
        var merged = {
            name: user.name || existing.name || "",
            email: user.email || existing.email || "",
            phone: user.phone || existing.phone || "",
            role: user.role || "",
            isAdmin: !!user.isAdmin || user.role === "admin"
        };
        writeStorageValue("freshMartUser", JSON.stringify(merged));
        if (typeof updateAuthHeader === "function") updateAuthHeader();
        return merged;
    }).catch(function() {
        return null;
    });
}

// ---------- ADMIN ----------
// Fetch all orders (admin) with optional filters: status, paymentStatus, search
function fetchAdminOrders(filter) {
    var url = API.base + "/orders";
    var query = [];
    if (filter && filter.status) query.push("status=" + encodeURIComponent(filter.status));
    if (filter && filter.paymentStatus) query.push("paymentStatus=" + encodeURIComponent(filter.paymentStatus));
    if (filter && filter.search) query.push("search=" + encodeURIComponent(filter.search));
    if (query.length) url += "?" + query.join("&");
    return fetch(url, {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed");
            return data.data;
        });
}

// Admin dashboard metrics (orders, customers, low stock, sales)
function fetchAdminOverview() {
    return fetch(API.base + "/orders/admin/overview", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed");
            return data.data;
        });
}

// Admin verify / reject / refund marker for an order's payment
function apiSetOrderPaymentStatus(id, paymentStatus, reference) {
    return fetch(API.base + "/orders/" + id + "/payment-status", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ paymentStatus: paymentStatus, reference: reference })
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// ---------- CUSTOMER ORDERS ----------
// Public tracking by Order ID or Track ID (returns sanitized data only)
function apiTrackOrder(ref) {
    return fetch(API.base + "/orders/track/" + encodeURIComponent(String(ref || "").trim()))
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Order not found");
            return data.data;
        });
}

// Live order history straight from the backend (never localStorage)
function fetchMyOrders() {
    return fetch(API.base + "/orders/my", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load your orders");
            return data.data;
        });
}

// Customer-initiated cancellation (backend validates ownership + window)
function apiCancelOrder(id) {
    return fetch(API.base + "/orders/" + id + "/cancel", {
        method: "POST",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Cancel failed");
            return res.data;
        });
}

// Fetch all products including inactive (admin)
function fetchAdminProducts() {
    return fetch(API.base + "/products/admin/all", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed");
            return data.data;
        });
}

// Upload a product image (admin) — server validates, uploads to Cloudinary,
// returns only the secure delivery URL. The data URI is never persisted.
function apiUploadProductImage(dataUri) {
    return fetch(API.base + "/products/upload", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ image: dataUri })
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Upload failed");
            return res.imageUrl;
        });
}

// Create product (admin)
function apiCreateProduct(data) {
    return fetch(API.base + "/products", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// Update product (admin)
function apiUpdateProduct(id, data) {
    return fetch(API.base + "/products/" + id, {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// Update stock (admin)
function apiUpdateStock(id, stock) {
    return fetch(API.base + "/products/" + id + "/stock", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ stock: stock })
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// Update price only (admin) - validated backend-side, up or down
function apiUpdateProductPrice(id, price) {
    return fetch(API.base + "/products/" + id + "/price", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ price: price })
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to update price");
            return res.data;
        });
}

// Delete product (admin)
function apiDeleteProduct(id) {
    return fetch(API.base + "/products/" + id, {
        method: "DELETE",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// Update order status (admin)
function apiUpdateOrderStatus(id, status) {
    return fetch(API.base + "/orders/" + id + "/status", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify({ status: status })
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}

// ---------- CART (persistent DB cart) ----------
function apiGetCart() {
    return fetch(API.base + "/cart", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load cart");
            return data.data;
        });
}

function apiSetCart(items) {
    return fetch(API.base + "/cart", {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ items: items })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to sync cart");
            return data.data;
        });
}

function apiMergeCart(guestItems) {
    return fetch(API.base + "/cart/merge", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ items: guestItems })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to merge cart");
            return data.data;
        });
}

function apiClearCart() {
    return fetch(API.base + "/cart", {
        method: "DELETE",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to clear cart");
            return data.data;
        });
}

// ---------- USERS (admin) ----------
// Get the currently logged-in user (verifies JWT backend-side)
function apiGetMe() {
    return fetch(API.base + "/users/me", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Not authorized");
            return data.data;
        });
}

// List all registered customers (admin only)
function fetchAdminCustomers(search) {
    var url = API.base + "/users/admin/list";
    if (search) url += "?search=" + encodeURIComponent(search);
    return fetch(url, {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load users");
            return data.data;
        });
}

// Order history for a specific customer (admin only)
function fetchAdminCustomerOrders(userId) {
    return fetch(API.base + "/users/admin/" + encodeURIComponent(userId) + "/orders", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load orders");
            return data;
        });
}

// Fetch a single order by id (owner or admin only)
function apiGetOrder(id) {
    return fetch(API.base + "/orders/" + encodeURIComponent(id), {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Order not found");
            return data.data;
        });
}

// ---------- REVIEWS ----------
// Submit a review for a product (public backend endpoint; fire-and-forget from the store)
function apiAddReview(productId, data) {
    return fetch(API.base + "/products/" + productId + "/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to save review");
            return res.data;
        });
}

// List all reviews (admin only)
function fetchAdminReviews(search) {
    var url = API.base + "/reviews";
    if (search) url += "?search=" + encodeURIComponent(search);
    return fetch(url, {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load reviews");
            return data.data;
        });
}

// Delete a review (admin only)
function apiDeleteReview(id) {
    return fetch(API.base + "/reviews/" + id, {
        method: "DELETE",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to delete review");
            return res.data;
        });
}

// ---------- COUPONS & ADMIN DASHBOARD ----------

// Validate a coupon during checkout (requires login; server computes discount).
function apiValidateCoupon(code, subtotal) {
    return fetch(API.base + "/coupons/validate", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ code: code, subtotal: subtotal })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Coupon validation failed");
            return data.data;
        });
}

// Admin: list all coupons (including usage stats)
function fetchAdminCoupons() {
    return fetch(API.base + "/coupons", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load coupons");
            return data.data;
        });
}

// Admin: create coupon
function apiCreateCoupon(data) {
    return fetch(API.base + "/coupons", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to create coupon");
            return res.data;
        });
}

// Admin: update coupon
function apiUpdateCoupon(id, data) {
    return fetch(API.base + "/coupons/" + encodeURIComponent(id), {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to update coupon");
            return res.data;
        });
}

// Admin: delete coupon
function apiDeleteCoupon(id) {
    return fetch(API.base + "/coupons/" + encodeURIComponent(id), {
        method: "DELETE",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to delete coupon");
            return res.data;
        });
}

// Admin: sales dashboard analytics
function fetchAdminDashboard(from, to) {
    var url = API.base + "/admin/dashboard";
    var query = [];
    if (from) query.push("from=" + encodeURIComponent(from));
    if (to)   query.push("to=" + encodeURIComponent(to));
    if (query.length) url += "?" + query.join("&");
    return fetch(url, {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load dashboard");
            return data.data;
        });
}

// Notifications inbox (R14). All calls are cookie-authed and owner-scoped.
function apiFetchNotifications(opts) {
    var url = API.base + "/notifications";
    var query = [];
    if (opts) {
        if (opts.limit) query.push("limit=" + encodeURIComponent(opts.limit));
        if (opts.skip) query.push("skip=" + encodeURIComponent(opts.skip));
        if (opts.type) query.push("type=" + encodeURIComponent(opts.type));
        if (opts.read !== undefined) query.push("read=" + opts.read);
    }
    if (query.length) url += "?" + query.join("&");
    return fetch(url, { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load notifications");
            return data; // { success, count, unreadCount, data: [...] }
        });
}

function apiUnreadCount() {
    return fetch(API.base + "/notifications/unread-count", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load unread count");
            return Number(data.unreadCount) || 0;
        });
}

function apiMarkNotificationRead(id) {
    return fetch(API.base + "/notifications/" + encodeURIComponent(id) + "/read", {
        method: "PUT",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to update notification");
            return data.data;
        });
}

function apiMarkAllNotificationsRead() {
    return fetch(API.base + "/notifications/read-all", {
        method: "PUT",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to update notifications");
            return data;
        });
}

// Returns / refunds / replacement (customer + admin). All cookie-authed.
function apiSubmitReturn(body) {
    return fetch(API.base + "/returns", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(body || {})
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Submit return failed");
            return data.data;
        });
}

function apiMyReturns() {
    return fetch(API.base + "/returns/my", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load returns");
            return data; // { success, count, data: [...] }
        });
}

function apiCancelReturn(id) {
    return fetch(API.base + "/returns/" + encodeURIComponent(id) + "/cancel", {
        method: "POST",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Cancel return failed");
            return data.data;
        });
}

function apiUploadReturnProof(imageDataUri) {
    return fetch(API.base + "/returns/upload-proof", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ image: imageDataUri })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Upload failed");
            return data.imageUrl;
        });
}

function adminListReturns(status) {
    var url = API.base + "/returns";
    if (status) url += "?status=" + encodeURIComponent(status);
    return fetch(url, { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load returns");
            return data.data;
        });
}

function adminUpdateReturnStatus(id, body) {
    return fetch(API.base + "/returns/" + encodeURIComponent(id) + "/status", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify(body || {})
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Update return status failed");
            return data.data;
        });
}

function adminListReviews(status) {
    var url = API.base + "/reviews";
    if (status) url += "?status=" + encodeURIComponent(status);
    return fetch(url, { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load reviews");
            return data.data;
        });
}

function apiModerateReview(id, body) {
    return fetch(API.base + "/reviews/" + encodeURIComponent(id) + "/moderation", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify(body || {})
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Update review failed");
            return data.data;
        });
}

// ---------- DELIVERY PARTNER (cookie-authed, delivery role) ----------

function apiDeliveryToday() {
    return fetch(API.base + "/delivery/today", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load deliveries");
            return data.deliveries || [];
        });
}

function apiDeliveryEarnings() {
    return fetch(API.base + "/delivery/earnings", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load earnings");
            return data;
        });
}

function apiDeliveryAction(action, assignmentId, extra) {
    var body = Object.assign({ assignmentId: assignmentId }, extra || {});
    return fetch(API.base + "/delivery/" + encodeURIComponent(action), {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Action failed");
            return data.assignment;
        });
}

function apiDeliveryAccept(assignmentId) { return apiDeliveryAction("accept", assignmentId); }
function apiDeliveryReject(assignmentId) { return apiDeliveryAction("reject", assignmentId); }
function apiDeliveryStatus(assignmentId, status, otp) { return apiDeliveryAction("status", assignmentId, { status: status, otp: otp }); }

function apiDeliveryAvailability(isAvailable) {
    return fetch(API.base + "/delivery/availability", {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ isAvailable: isAvailable === true })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to update availability");
            return data;
        });
}

function apiDeliveryShareLocation(lat, lng) {
    return fetch(API.base + "/delivery/location", {
        method: "PUT",
        headers: getAuthHeaders(),
        body: JSON.stringify({ lat: lat, lng: lng })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to share location");
            return data;
        });
}

function apiDeliveryProof(assignmentId, imageData) {
    return fetch(API.base + "/delivery/proof-image", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ assignmentId: assignmentId, imageData: imageData })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Upload failed");
            return data.proofImage;
        });
}

// ---------- DELIVERY ADMIN (cookie-authed, admin role) ----------

function apiAdminDeliveryPartners() {
    return fetch(API.base + "/delivery/management/partners", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load delivery partners");
            return data.deliveryUsers || [];
        });
}

function apiAdminDeliveryToday() {
    return fetch(API.base + "/delivery/management/today", { headers: getAuthHeaders() })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to load deliveries");
            return data.deliveries || [];
        });
}

function apiAdminAssignDelivery(orderId, deliveryUserId) {
    return fetch(API.base + "/delivery/assign", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ orderId: orderId, deliveryUserId: deliveryUserId })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Assignment failed");
            return data.assignment;
        });
}

// ---------- GEOLOCATION + MAPS (shared UI helpers) ----------

// "Use My Current Location" capture with graceful degradation. Rejects with a
// user-friendly message when the browser lacks geolocation or access is denied.
function captureCurrentLocation() {
    return new Promise(function(resolve, reject) {
        if (!("geolocation" in navigator)) {
            reject(new Error("Location sharing is not supported by this browser. Please enter your address manually."));
            return;
        }
        navigator.geolocation.getCurrentPosition(
            function(pos) {
                if (!pos || !pos.coords) {
                    reject(new Error("Could not read your location."));
                    return;
                }
                resolve({
                    latitude: pos.coords.latitude,
                    longitude: pos.coords.longitude,
                    accuracy: pos.coords.accuracy != null ? Math.round(pos.coords.accuracy) : null,
                    capturedAt: new Date().toISOString()
                });
            },
            function() {
                reject(new Error("Location access was denied or unavailable. You can still enter your address manually."));
            },
            { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
        );
    });
}

function openInMapsHref(lat, lng) {
    return "https://maps.google.com/?q=" + encodeURIComponent(String(lat) + "," + String(lng));
}

// Key-free OpenStreetMap embed inside a modal lightbox (DOM-built so no
// untrusted text ever reaches a string-built HTML sink).
function openMapView(lat, lng, title) {
    var coordLat = Number(lat);
    var coordLng = Number(lng);
    if (!Number.isFinite(coordLat) || !Number.isFinite(coordLng)) return;

    var overlay = document.createElement("div");
    overlay.className = "map-modal-overlay";

    var box = document.createElement("div");
    box.className = "map-modal-box";

    var head = document.createElement("div");
    head.className = "map-modal-head";

    var strong = document.createElement("strong");
    strong.textContent = title || "Location";
    head.appendChild(strong);

    var closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "map-modal-close";
    closeBtn.setAttribute("aria-label", "Close map");
    closeBtn.textContent = "✕";
    head.appendChild(closeBtn);

    var frame = document.createElement("div");
    frame.className = "map-modal-frame";

    var iframe = document.createElement("iframe");
    iframe.title = "Map";
    var bbox = [coordLng - 0.005, coordLat - 0.003, coordLng + 0.005, coordLat + 0.003].join(",");
    iframe.src = "https://www.openstreetmap.org/export/embed.html?bbox=" +
        encodeURIComponent(bbox) +
        "&layer=mapnik&marker=" +
        encodeURIComponent(String(coordLat) + "," + String(coordLng));
    iframe.setAttribute("loading", "lazy");
    iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
    frame.appendChild(iframe);

    var link = document.createElement("a");
    link.className = "map-open-link";
    link.href = openInMapsHref(coordLat, coordLng);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open in Google Maps ↗";
    frame.appendChild(link);

    box.appendChild(head);
    box.appendChild(frame);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    closeBtn.addEventListener("click", function() { overlay.remove(); });
    overlay.addEventListener("click", function(e) { if (e.target === overlay) overlay.remove(); });
}

// ---------- REVERSE GEOCODING + INTERACTIVE MAP PICKER ----------
// Free, key-free OSM geocoding. "Pick on Map" auto-fills the FULL address
// so the customer never re-types it, and the draggable marker lets them fix
// a coarse GPS point (the usual cause of a "wrong location" being shared).

// Map OSM Nominatim "address" components into FreshMart's address fields.
function geocodeToAddress(nominatimData) {
    var a = (nominatimData && nominatimData.address) || {};
    var road = a.road || a.pedestrian || a.footway || a.service || a.residential || a.highway || "";
    var house = a.house_number || "";
    var area = a.neighbourhood || a.suburb || a.city_district || a.village || a.hamlet || a.town || "";
    var addressLine = [house, road, area].filter(function(v) { return Boolean(v); }).join(", ");
    var city = a.city || a.town || a.village || a.municipality || a.county || a.city_district || a.state_district || "";
    var state = a.state || a.state_district || "";
    var pincode = a.postcode || "";
    var full = [];
    if (addressLine) full.push(addressLine);
    if (city) full.push(city);
    if (state) full.push(state);
    if (pincode) full.push(pincode);
    return {
        full: full.join(", "),
        address: addressLine,
        city: city,
        state: state,
        pincode: pincode,
        countryCode: String(a.country_code || "").toUpperCase()
    };
}

// Reverse-geocode lat/lng to a full address via OSM Nominatim (no key).
function reverseGeocode(lat, lng) {
    var url = "https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18" +
        "&addressdetails=1&accept-language=en&lat=" + encodeURIComponent(lat) +
        "&lon=" + encodeURIComponent(lng);
    return fetch(url)
        .then(function(res) {
            if (!res.ok) throw new Error("Address lookup failed (" + res.status + ")");
            return res.json();
        })
        .then(function(data) {
            if (!data || !data.address) throw new Error("No address found for this spot");
            return geocodeToAddress(data);
        })
        .catch(function(e) {
            if (e && e.message) throw e;
            throw new Error("Address lookup failed");
        });
}

// Search a free-text place/area and return the best coordinate + address.
function searchPlace(query) {
    var url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1" +
        "&addressdetails=1&accept-language=en&q=" + encodeURIComponent(query);
    return fetch(url)
        .then(function(res) {
            if (!res.ok) throw new Error("Place search failed (" + res.status + ")");
            return res.json();
        })
        .then(function(data) {
            if (!data || !data.length) throw new Error("No place found for \"" + query + "\"");
            var r = data[0];
            var addr = geocodeToAddress({ address: r.address || {} });
            return {
                latitude: Number(r.lat),
                longitude: Number(r.lon),
                displayName: r.display_name || query,
                address: addr
            };
        })
        .catch(function(e) {
            if (e && e.message) throw e;
            throw new Error("Place search failed");
        });
}

// Load the self-hosted Leaflet library once (CSP-safe: same-origin script).
function loadLeaflet() {
    return new Promise(function(resolve, reject) {
        if (typeof window.L !== "undefined") { resolve(window.L); return; }
        var existing = document.getElementById("leafletScriptEl");
        if (existing) {
            var waitFor = function() {
                if (typeof window.L !== "undefined") resolve(window.L);
                else setTimeout(waitFor, 60);
            };
            waitFor();
            return;
        }
        var s = document.createElement("script");
        s.id = "leafletScriptEl";
        s.src = "/leaflet/leaflet.js";
        s.onload = function() {
            if (typeof window.L !== "undefined") resolve(window.L);
            else reject(new Error("Map library failed to initialise"));
        };
        s.onerror = function() { reject(new Error("Could not load the map library. Please try again.")); };
        s.addEventListener("error", function() { reject(new Error("Could not load the map library. Please try again.")); });
        (document.head || document.documentElement).appendChild(s);
    });
}

// Interactive drag-to-place map picker used at checkout. Resolves with
// { latitude, longitude, accuracy, address } or rejects with
// { cancelled: true } when dismissed. All text is DOM-appended (no innerHTML).
function openMapPicker(opts) {
    opts = opts || {};
    var existing = document.getElementById("mapPickerWrap");
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

    var startLat = Number(opts.lat);
    var startLng = Number(opts.lng);
    var hasFix = Number.isFinite(startLat) && Number.isFinite(startLng);
    if (!hasFix) { startLat = 28.6139; startLng = 77.2090; }
    var accuracy = Number(opts.accuracy);
    if (!Number.isFinite(accuracy) || accuracy <= 0) accuracy = 0;
    var title = opts.title || "Set your delivery location";

    if (!document.getElementById("leafletCssLink")) {
        var css = document.createElement("link");
        css.id = "leafletCssLink";
        css.rel = "stylesheet";
        css.href = "/leaflet/leaflet.css";
        css.type = "text/css";
        (document.head || document.documentElement).appendChild(css);
    }

    return loadLeaflet().then(function(L) {
        return new Promise(function(resolve, reject) {
            var overlay = document.createElement("div");
            overlay.className = "map-picker-overlay";
            overlay.setAttribute("role", "dialog");
            overlay.setAttribute("aria-modal", "true");
            overlay.setAttribute("aria-label", title);

            var box = document.createElement("div");
            box.className = "map-picker-box";

            var head = document.createElement("div");
            head.className = "map-picker-head";

            var strong = document.createElement("strong");
            strong.textContent = title;
            head.appendChild(strong);

            var closeBtn = document.createElement("button");
            closeBtn.type = "button";
            closeBtn.className = "map-modal-close";
            closeBtn.setAttribute("aria-label", "Close map picker");
            closeBtn.textContent = "✕";
            head.appendChild(closeBtn);

            var body = document.createElement("div");
            body.className = "map-picker-body";

            var searchRow = document.createElement("div");
            searchRow.className = "map-picker-search";

            var searchInput = document.createElement("input");
            searchInput.type = "search";
            searchInput.placeholder = "Search your area, locality or landmark…";
            searchInput.setAttribute("aria-label", "Search area or landmark");
            searchInput.autocomplete = "off";

            var searchBtn = document.createElement("button");
            searchBtn.type = "button";
            searchBtn.className = "map-picker-search-btn";
            searchBtn.textContent = "Search";

            searchRow.appendChild(searchInput);
            searchRow.appendChild(searchBtn);

            var mapDiv = document.createElement("div");
            mapDiv.className = "map-picker-map";
            mapDiv.setAttribute("id", "mapPickerMap");

            var addrCard = document.createElement("div");
            addrCard.className = "map-picker-addr";

            var addrLabel = document.createElement("div");
            addrLabel.className = "map-picker-addr-label";
            addrLabel.textContent = "Selected location";
            addrCard.appendChild(addrLabel);

            var addrText = document.createElement("div");
            addrText.className = "map-picker-addr-text";
            addrText.textContent = "Drag the marker, search, or use your GPS location — the full address fills automatically.";
            addrCard.appendChild(addrText);

            var foot = document.createElement("div");
            foot.className = "map-picker-foot";

            var useLocBtn = document.createElement("button");
            useLocBtn.type = "button";
            useLocBtn.className = "map-picker-loc-btn";
            useLocBtn.textContent = "📍 Use My Location";

            var cancelBtn = document.createElement("button");
            cancelBtn.type = "button";
            cancelBtn.className = "map-picker-cancel-btn";
            cancelBtn.textContent = "Cancel";

            var confirmBtn = document.createElement("button");
            confirmBtn.type = "button";
            confirmBtn.className = "map-picker-confirm-btn";
            confirmBtn.textContent = "✓ Confirm Location";
            confirmBtn.disabled = true;

            foot.appendChild(useLocBtn);
            foot.appendChild(cancelBtn);
            foot.appendChild(confirmBtn);

            body.appendChild(searchRow);
            body.appendChild(mapDiv);
            body.appendChild(addrCard);
            body.appendChild(foot);

            box.appendChild(head);
            box.appendChild(body);
            overlay.appendChild(box);
            document.body.appendChild(overlay);

            var done = false;
            function finish(v) {
                if (done) return;
                done = true;
                overlay.remove();
                resolve(v);
            }
            function fail(e) {
                if (done) return;
                done = true;
                overlay.remove();
                reject(e);
            }

            closeBtn.addEventListener("click", function() { fail({ cancelled: true }); });
            overlay.addEventListener("click", function(e) { if (e.target === overlay) fail({ cancelled: true }); });
            cancelBtn.addEventListener("click", function() { fail({ cancelled: true }); });

            var map;
            var marker;
            var accCircle;
            var lastPos = { latitude: startLat, longitude: startLng, accuracy: accuracy };
            var lastAddr = null;
            var lastAddrAt = null;
            var geocodeTimer = null;

            function setAddrText(msg, isError) {
                addrText.style.color = isError ? "#c0392b" : "";
                addrText.textContent = msg;
            }

            function setMarker(lat, lng, moveMap) {
                lastPos.latitude = lat;
                lastPos.longitude = lng;
                if (marker) marker.setLatLng([lat, lng]);
                if (accCircle) accCircle.setLatLng([lat, lng]);
                if (moveMap && map) map.setView([lat, lng], Math.max(map.getZoom(), 16));
                setAddrText("Resolving address…", false);
                geocodeDebounced();
            }

            function geocodeDebounced() {
                if (geocodeTimer) clearTimeout(geocodeTimer);
                geocodeTimer = setTimeout(function() {
                    geocodeTimer = null;
                    var reqLat = lastPos.latitude;
                    var reqLng = lastPos.longitude;
                    reverseGeocode(reqLat, reqLng)
                        .then(function(addr) {
                            if (reqLat !== lastPos.latitude || reqLng !== lastPos.longitude) { geocodeDebounced(); return; }
                            lastAddr = addr;
                            lastAddrAt = { latitude: reqLat, longitude: reqLng };
                            setAddrText(addr.full || "Address found", false);
                            confirmBtn.disabled = false;
                        })
                        .catch(function(e) {
                            if (reqLat !== lastPos.latitude || reqLng !== lastPos.longitude) { geocodeDebounced(); return; }
                            setAddrText((e && e.message) || "Could not auto-fill the address. You can still confirm the pin location.", true);
                            confirmBtn.disabled = false;
                        });
                }, 450);
            }

            function runSearch() {
                var q = searchInput.value.trim();
                if (!q) { searchInput.focus(); return; }
                setAddrText("Searching \u201C" + q + "\u201D…", false);
                searchBtn.disabled = true;
                searchPlace(q)
                    .then(function(place) {
                        searchBtn.disabled = false;
                        searchInput.value = place.displayName;
                        setMarker(place.latitude, place.longitude, true);
                    })
                    .catch(function(e) {
                        searchBtn.disabled = false;
                        setAddrText((e && e.message) || "Place not found. Try again.", true);
                    });
            }

            useLocBtn.addEventListener("click", function() {
                useLocBtn.disabled = true;
                useLocBtn.textContent = "📍 Locating…";
                setAddrText("Getting your live location…", false);
                captureCurrentLocation()
                    .then(function(loc) {
                        useLocBtn.disabled = false;
                        useLocBtn.textContent = "📍 Use My Location";
                        lastPos.accuracy = loc.accuracy || 0;
                        if (accCircle) {
                            accCircle.setLatLng([loc.latitude, loc.longitude]);
                            accCircle.setRadius(lastPos.accuracy || 50);
                        }
                        setMarker(loc.latitude, loc.longitude, true);
                    })
                    .catch(function(e) {
                        useLocBtn.disabled = false;
                        useLocBtn.textContent = "📍 Use My Location";
                        setAddrText((e && e.message) || "Could not get your live location. Drag the marker instead.", true);
                    });
            });

            searchBtn.addEventListener("click", runSearch);
            searchInput.addEventListener("keydown", function(ev) {
                if (ev.key === "Enter") { ev.preventDefault(); runSearch(); }
            });

            confirmBtn.addEventListener("click", function() {
                var lat = lastPos.latitude;
                var lng = lastPos.longitude;
                confirmBtn.disabled = true;
                confirmBtn.textContent = "Confirming…";
                var apply = function(addr) {
                    finish({
                        latitude: lat,
                        longitude: lng,
                        accuracy: lastPos.accuracy || 0,
                        address: addr
                    });
                };
                // Fast path: only reuse the auto-filled address if the marker has
                // NOT moved since it was resolved — otherwise always re-resolve the
                // CURRENT pin so the shared location's own address fills.
                var current = lastAddrAt !== null && lastAddrAt.latitude === lat && lastAddrAt.longitude === lng;
                if (current && lastAddr) { apply(lastAddr); return; }
                reverseGeocode(lat, lng).then(apply).catch(function() { apply(null); });
            });

            map = L.map(mapDiv, {
                center: [startLat, startLng],
                zoom: 16,
                scrollWheelZoom: false
            });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "&copy; OpenStreetMap contributors"
            }).addTo(map);

            marker = L.marker([startLat, startLng], { draggable: true }).addTo(map);

            if (accuracy && accuracy > 0) {
                accCircle = L.circle([startLat, startLng], { radius: accuracy, className: "map-picker-acc-circle" }).addTo(map);
            }

            marker.on("dragend", function() {
                var ll = marker.getLatLng();
                setMarker(ll.lat, ll.lng, true);
            });

            map.on("click", function(ev) {
                setMarker(ev.latlng.lat, ev.latlng.lng, false);
            });

            // Initial resolve so the address card is populated right away.
            geocodeDebounced();
        });
    });
}
