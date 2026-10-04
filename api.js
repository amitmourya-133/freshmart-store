// ===============================
// FRESHMART - API LAYER
// Handles backend calls with localStorage fallback
// ===============================

const API = {
    base: (typeof window !== "undefined" && (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1"))
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

// Search suggestions for the autocomplete dropdown (real catalog data).
function apiGetSearchSuggestions(q, limit) {
    var url = API.base + "/products/suggestions?q=" + encodeURIComponent(q) +
        "&limit=" + (limit || 8);
    return fetch(url)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Suggestion search failed");
            return data.suggestions || [];
        });
}

// AI search. Secrets stay on the server; this only sends the plain query text.
function apiAiSearch(query, limit) {
    return fetch(API.base + "/products/ai-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: query, limit: limit || 8 })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Search failed");
            return data;
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

// Public coverage check (early warning at checkout). The server re-validates
// everything at order creation, so this never has to be trusted.
function apiDeliveryCoverage(lat, lng) {
    return fetch(API.base + "/settings/delivery-check?lat=" + encodeURIComponent(lat) + "&lng=" + encodeURIComponent(lng), {
        headers: { "Content-Type": "application/json" }
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Could not check delivery coverage");
            return data.data;
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

// Update order status (admin). "Delivered" additionally carries the admin's
// audit reason, which the status endpoint now requires.
function apiUpdateOrderStatus(id, status, reason) {
    const body = { status: status };
    if (reason) body.reason = String(reason);
    return fetch(API.base + "/orders/" + id + "/status", {
        method: "PATCH",
        headers: getAuthHeaders(),
        body: JSON.stringify(body)
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

// "Use My Current Location" capture with graceful degradation and DISTINCT
// handling for every failure mode (denied / unavailable / timeout / insecure /
// unsupported). Each rejection carries a stable `locCode` so callers and the
// regression suite can branch on the real cause instead of a generic string.
function locError(code, message) {
    var e = new Error(message);
    e.locCode = code;
    return e;
}

// Map a browser PositionError (or a thrown error) to a {locCode, message}.
function geolocationErrorFor(err) {
    var c = err && err.code;
    if (c === 1) {
        return locError("denied", "Location permission was blocked. Please allow Location for Chrome/FreshMart in your device's settings, then tap \"Use My Current Location\" again.");
    }
    if (c === 2) {
        return locError("unavailable", "Your location could not be determined right now. Move near a window or step outdoors and tap \"Use My Current Location\" again.");
    }
    if (c === 3) {
        return locError("timeout", "We couldn't get your location in time. Tap \"Use My Current Location\" again — sharing it outdoors gives the most accurate pin.");
    }
    return locError("unavailable", "Location is unavailable right now. Please try again, or enter your address manually.");
}

// Fresh, high-accuracy fix. maximumAge:0 FORCES the browser to ask the radio/GPS
// stack instead of replaying a stale cached position, so the shared pin is the
// customer's current whereabouts — never an old one. A generous timeout avoids
// Android Chrome's cold-start GPS taking longer than the timeout.
function captureCurrentLocation() {
    return new Promise(function(resolve, reject) {
        if (typeof navigator === "undefined" || !navigator || !navigator.geolocation) {
            reject(locError("unsupported", "Location sharing is not supported by this browser. Please enter your address manually, or pick your spot on the map."));
            return;
        }
        var ctx = (typeof window !== "undefined" && typeof window.isSecureContext === "boolean") ? window.isSecureContext : true;
        if (!ctx) {
            reject(locError("insecure", "Location sharing needs a secure (HTTPS) connection. Please open this page over https:// and try again."));
            return;
        }
        var geo = navigator.geolocation;
        var done = false;
        var finish = function(pos) {
            if (done) return;
            done = true;
            if (!pos || !pos.coords || pos.coords.latitude == null || pos.coords.longitude == null ||
                !Number.isFinite(Number(pos.coords.latitude)) || !Number.isFinite(Number(pos.coords.longitude))) {
                reject(locError("unavailable", "Could not read your location. Please try again."));
                return;
            }
            var acc = pos.coords.accuracy;
            resolve({
                latitude: Number(pos.coords.latitude),
                longitude: Number(pos.coords.longitude),
                accuracy: acc != null && Number.isFinite(Number(acc)) ? Math.round(Number(acc) * 10) / 10 : null,
                capturedAt: new Date().toISOString()
            });
        };
        var fail = function(err) {
            if (done) return;
            done = true;
            reject(geolocationErrorFor(err));
        };
        try {
            geo.getCurrentPosition(finish, fail, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
        } catch (syncErr) {
            fail(syncErr);
        }
    });
}

// ============================================================
// COORDINATE SAFETY NET — THE single gate every coordinate passes.
// Never converts missing/invalid coordinates to 0. A value is valid only when:
//   - after Number() it is a finite number,
//   - latitude in [-90, 90] and longitude in [-180, 180],
//   - it is NOT (0,0) (rejected explicitly as an invalid delivery fallback).
// Returns { latitude, longitude } or null. null => refuse everywhere.
// ============================================================
function toValidLatLng(lat, lng) {
    var latNum = parseCoord(lat);
    var lngNum = parseCoord(lng);
    if (latNum === null || lngNum === null) return null;
    if (Math.abs(latNum) > 90 || Math.abs(lngNum) > 180) return null;
    if (latNum === 0 && lngNum === 0) return null;
    return { latitude: latNum, longitude: lngNum };
}

// Number() implies Number("") === 0 and Number("  ") === 0, which silently
// turned empty tracking fields into the dreaded 0,0 destination. parseCoord
// instead rejects blank/undefined/null and any non-numeric string outright.
function parseCoord(raw) {
    if (raw === undefined || raw === null) return null;
    if (typeof raw === "number") {
        if (!Number.isFinite(raw)) return null;
        return raw;
    }
    var s = String(raw).trim();
    if (s === "") return null; // Number("") === 0 must NEVER slip through
    var n = Number(s);
    if (!Number.isFinite(n)) return null;
    return n;
}

// Canonical captured-location object — the ONE shape shared by the mini-map,
// the map picker, the checkout payload, and every downstream consumer
// (admin/delivery partner maps read the very same object off the stored order).
// Returns null for any missing/invalid axis (never 0, never partial coords).
function canonicalLocation(latRaw, lngRaw, accRaw, atRaw) {
    var v = toValidLatLng(latRaw, lngRaw);
    if (!v) return null;
    var loc = {
        latitude: Math.round(v.latitude * 1e6) / 1e6,
        longitude: Math.round(v.longitude * 1e6) / 1e6,
        capturedAt: (atRaw && String(atRaw).trim()) ? String(atRaw).trim() : new Date().toISOString()
    };
    var accNum = parseCoord(accRaw);
    if (accNum !== null && accNum >= 0 && accNum <= 5000) loc.accuracy = Math.round(accNum * 10) / 10;
    return loc;
}

// The shipping payload is exactly the canonical object (same 1e-6 precision,
// same accuracy rounding) so what the customer sees on the map is 1:1 with
// what the delivery partner receives.
function deliveryLocationPayload(latRaw, lngRaw, accRaw, atRaw) {
    return canonicalLocation(latRaw, lngRaw, accRaw, atRaw);
}

// Last-line pre-submit guard for requirement "same selected location reaches
// the order". A captured pin must travel with an address derived from THOSE
// coordinates (synced) or one the customer explicitly fixed afterwards
// (manual). A pin combined with untouched old-saved text (unsynced) is refused.
// Pure/stateless so the regression suite can exercise every branch.
function locationSubmitGuard(meta) {
    if (!meta || !meta.pin) return { ok: true, state: "no-pin" };
    if (meta.synced) return { ok: true, state: "synced" };
    if (meta.handledManually) return { ok: true, state: "manual" };
    return { ok: false, state: "unsynced", message: "We captured your pin, but its address was not auto-filled. Please confirm it on the map, or enter your street, city and pincode for your pin." };
}

// Google Maps link builder. REFUSES to create a URL for missing/invalid/0,0
// coordinates and returns "" instead — callers must show "Customer location is
// unavailable." rather than navigate to the Gulf of Guinea. The validated
// coordinates are finite Numbers, so they are emitted with a literal comma
// (canonical ?q=lat,lng form) — never %-encoded, never /dir/.
function openInMapsHref(lat, lng) {
    var v = toValidLatLng(lat, lng);
    if (!v) return "";
    return "https://maps.google.com/?q=" + v.latitude + "," + v.longitude;
}

// Key-free OpenStreetMap embed inside a modal lightbox (DOM-built so no
// untrusted text ever reaches a string-built HTML sink).
function openMapView(lat, lng, title) {
    var v = toValidLatLng(lat, lng);
    if (!v) return;

    var coordLat = v.latitude;
    var coordLng = v.longitude;

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

// "Bengaluru Urban District" / "Saharanpur district" must read like a city name
// in the CITY field, not like an administrative blob.
function cleanCityName(value) {
    var v = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (!v) return "";
    var stripped = v.replace(/\s*[\(\[].*?[\)\]]\s*$/g, "").replace(/\s+(district|dist\.?)$/i, "").trim();
    return stripped || v;
}

// Map OSM Nominatim "address" components into FreshMart's address fields.
// Uses a professional fallback hierarchy and NEVER invents data: empty inputs
// produce empty outputs. town/village/municipality belong to the CITY field and
// are NOT duplicated into the address line (neighbourhood/suburb are the
// locality tokens that belong on the street line).
// Street-less pins (very common in India: village/colony/plot layouts) carry no
// house_number/road token, so the nearest NAMED locality becomes the address
// line instead of leaving the Address field empty with only City filled.
function geocodeToAddress(nominatimData) {
    var data = nominatimData || {};
    var a = data.address || {};
    var first = function(keys) {
        for (var i = 0; i < keys.length; i++) {
            var v = a[keys[i]];
            if (v) return String(v).replace(/\s+/g, " ").trim();
        }
        return "";
    };
    var house = first(["house_number"]);
    var road = first(["road", "pedestrian", "footway", "path", "service", "residential", "highway", "square", "track"]);
    var area = first(["neighbourhood", "suburb", "quarter", "locality", "borough", "city_district", "hamlet"]);
    var addressLine = [house, road, area].filter(function(v) { return Boolean(v); }).join(", ");
    if (!addressLine) {
        var locality = first(["neighbourhood", "suburb", "quarter", "locality", "borough",
            "city_district", "hamlet", "village", "town", "district", "county", "state_district"]);
        var placeName = String(data.name || "").replace(/\s+/g, " ").trim();
        var cityName = first(["city", "town", "village", "municipality"]);
        if (!locality && placeName && placeName !== cityName) locality = placeName;
        addressLine = locality;
    }
    var city = cleanCityName(first(["city", "town", "village", "municipality"])) ||
        cleanCityName(first(["county", "city_district", "state_district"]));
    var state = first(["state", "state_district", "county", "region"]);
    var pincode = first(["postcode"]);
    var full = [];
    if (addressLine) full.push(addressLine);
    if (city && city !== addressLine) full.push(city);
    if (state && state !== city) full.push(state);
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
    // NO fake/default marker and NO 0,0. Without a confirmed GPS fix the map
    // opens on a neutral country-level view (India centre) so the customer
    // still sees India instead of blank water — and must place their own pin.
    if (!hasFix) { startLat = 21.8; startLng = 77.5; }
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
            addrText.textContent = "Tap the map, search your area/landmark, or use My Location — your pin becomes the exact delivery point and the full address fills automatically.";
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
            var marker = null;
            var accCircle;
            // NEVER pre-seed a location: when the picker opens without an existing
            // valid fix there is NO default point. The customer must tap the map,
            // search, or share GPS — otherwise Confirm stays disabled and 0,0 /
            // an unrelated centre can never be committed.
            var lastPos = { latitude: hasFix ? startLat : NaN, longitude: hasFix ? startLng : NaN, accuracy: accuracy };
            var hasSelection = hasFix;
            var lastAddr = null;
            var lastAddrAt = null;
            var geocodeTimer = null;

            function setAddrText(msg, isError) {
                addrText.style.color = isError ? "#c0392b" : "";
                addrText.textContent = msg;
            }

            function ensureMarker(lat, lng) {
                if (!marker) {
                    marker = L.marker([lat, lng], { draggable: true }).addTo(map);
                    marker.on("dragend", function() {
                        var ll = marker.getLatLng();
                        setMarker(ll.lat, ll.lng, true);
                    });
                } else {
                    marker.setLatLng([lat, lng]);
                }
                return marker;
            }

            function setMarker(lat, lng, moveMap) {
                var v = toValidLatLng(lat, lng);
                if (!v) return;
                lastPos.latitude = v.latitude;
                lastPos.longitude = v.longitude;
                hasSelection = true;
                if (confirmBtn) confirmBtn.disabled = false;
                ensureMarker(v.latitude, v.longitude);
                if (accCircle) accCircle.setLatLng([v.latitude, v.longitude]);
                if (moveMap && map) map.setView([v.latitude, v.longitude], Math.max(map.getZoom(), 16));
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
                var v = toValidLatLng(lastPos.latitude, lastPos.longitude);
                if (!v) {
                    setAddrText("Please tap the map, search your area, or share GPS to choose a location first.", true);
                    return;
                }
                var lat = v.latitude;
                var lng = v.longitude;
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
                zoom: hasFix ? 16 : 5,
                scrollWheelZoom: false
            });
            L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
                maxZoom: 19,
                attribution: "&copy; OpenStreetMap contributors"
            }).addTo(map);

            // Marker appears ONLY when there is a genuinely valid starting fix —
            // otherwise the customer must explicitly pick a point (no 0,0 and no
            // unrelated default location can ever be committed).
            if (hasFix && toValidLatLng(startLat, startLng)) {
                ensureMarker(startLat, startLng);
                if (accuracy && accuracy > 0) {
                    accCircle = L.circle([startLat, startLng], { radius: accuracy, className: "map-picker-acc-circle" }).addTo(map);
                }
            } else {
                setAddrText("Tap the map or search your area to place your delivery pin.", false);
            }

            map.on("click", function(ev) {
                setMarker(ev.latlng.lat, ev.latlng.lng, false);
            });

            // Initial resolve so the address card is populated right away.
            if (hasFix && toValidLatLng(startLat, startLng)) {
                geocodeDebounced();
            }
        });
    });
}

// ===============================
// GROWTH FEATURES (analytics, wallet, referral, back-in-stock, reviews+photos)
// ===============================

// Lightweight client-side analytics. Fire-and-forget: never waits, never throws
// into UI code, and works offline (the request simply fails silently). Guess-y
// PII is never sent — only an opaque visitor id + the event itself.
function trackEvent(eventName, data) {
    try {
        var anon = readStorageValue("freshmart_anon_id", "");
        if (!anon) {
            anon = "v" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            writeStorageValue("freshmart_anon_id", anon);
        }
        var sess = readStorageValue("freshmart_session_id", "");
        if (!sess) {
            sess = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
            writeStorageValue("freshmart_session_id", sess);
        }
        var payload = {
            eventName: eventName,
            anonymousId: anon,
            sessionId: sess,
            page: (window.location && window.location.pathname || "").split("/").pop()
        };
        data = data || {};
        if (data.productId) payload.productId = String(data.productId);
        if (data.metadata) payload.metadata = data.metadata;
        fetch(API.base + "/analytics/track", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(function () { /* silent */ });
    } catch (e) { /* silent */ }
}

// Server review list for a product (approved, with photos + verified flag).
function apiGetProductReviews(productId) {
    return fetch(API.base + "/products/" + encodeURIComponent(productId) + "/reviews")
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load reviews");
            return data.data || [];
        });
}

// Upload one review photo (base64 data URI) -> secure Cloudinary URL.
function apiUploadReviewPhoto(productId, imageDataUri) {
    return fetch(API.base + "/products/" + encodeURIComponent(productId) + "/reviews/photos", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ image: imageDataUri })
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Photo upload failed");
            return data.data && data.data.url;
        });
}

// Wallet: my balance + recent ledger.
function apiGetMyWallet() {
    return fetch(API.base + "/wallet", { headers: getAuthHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load wallet");
            return data.data;
        });
}

// Wallet: full paginated ledger.
function apiGetMyWalletTransactions(limit, skip) {
    var url = API.base + "/wallet/transactions";
    var q = [];
    if (limit) q.push("limit=" + encodeURIComponent(limit));
    if (skip) q.push("skip=" + encodeURIComponent(skip));
    if (q.length) url += "?" + q.join("&");
    return fetch(url, { headers: getAuthHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load transactions");
            return data;
        });
}

// Referral: my shareable code + who referred me.
function apiGetMyReferral() {
    return fetch(API.base + "/referral/me", { headers: getAuthHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load referral");
            return data.data;
        });
}

// Referral: claim a friend's code.
function apiClaimReferral(code) {
    return fetch(API.base + "/referral/claim", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ code: code })
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Could not apply referral code");
            return data;
        });
}

// Back-in-stock: ask to be notified when an out-of-stock product is back.
function apiSubscribeStockAlert(productId) {
    return fetch(API.base + "/stock-alerts", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({ productId: productId })
    })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Could not subscribe");
            return data;
        });
}

// Admin: growth analytics for a range (today|7d|30d|90d).
function apiAdminAnalytics(range) {
    var url = API.base + "/admin/analytics?range=" + encodeURIComponent(range || "30d");
    return fetch(url, { headers: getAuthHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load analytics");
            return data;
        });
}

// Admin: waiting back-in-stock alerts.
function apiAdminStockAlertsWaiting() {
    return fetch(API.base + "/admin/stock-alerts/waiting", { headers: getAuthHeaders() })
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.success) throw new Error(data.message || "Failed to load stock alerts");
            return data.data;
        });
}

// ---------- CSP-SAFE DELEGATED ACTION DISPATCHER ----------
// Replaces every inline on* attribute (both static markup and innerHTML
// templates) with data-act / data-arg hooks. It lives in api.js because that is
// the first script on every page, so script.js / admin.js / features.js /
// delivery-ops.js / notifications.js / subscription.js / help.js handlers are
// all resolvable by name at event time - the same global lookup an inline
// handler performed, minus the CSP violation.
//
// data-act accepts either form:
//   data-act="fnName" data-arg='["a",1]'                  (shorthand)
//   data-act='[["someHandler",["a",1]],["$stop",[]]]'        (compound)
//
// Argument tokens resolved against the element / event:
//   "$el" -> element   "$val" -> element.value   "$checked" -> element.checked
//   "$src" -> element.src   "$e" -> event
//
// Builtin pseudo-actions. Invoked as fn.call(element, event, ...args), so the
// owning element is always `this` and the event is always the first parameter.
// Argument shapes come from the migrated call sites:
//   $stop()  $prevent()  $nav(href)
//   $hideSelf()  $hideSelfShow(selector)  $closeModal()  $imgMissing()
(function (global) {
    var BUILTIN = {
        $stop: function (ev) {
            if (ev && ev.stopPropagation) ev.stopPropagation();
        },
        $prevent: function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
        },
        $nav: function (ev, href) {
            if (href == null || href === "") return;
            global.location.href = href;
        },
        $hideSelf: function () {
            if (this) this.style.display = "none";
        },
        $hideSelfShow: function (ev, selector) {
            if (this) this.style.display = "none";
            var target = selector ? global.document.querySelector(selector) : null;
            if (target) target.style.display = "block";
        },
        $closeModal: function () {
            var m = this && this.closest ? this.closest(".qr-modal") : null;
            if (m) m.remove();
        },
        $imgMissing: function () {
            var el = this;
            // Capture the parent first: clearing it detaches the <img>, so
            // re-reading el.parentNode afterwards would be null.
            var parent = el && el.parentNode;
            if (!parent) return;
            var span = global.document.createElement("span");
            span.className = "admin-img-missing";
            span.textContent = "Image not found: " + (el.getAttribute("data-fb-text") || "");
            parent.textContent = "";
            parent.appendChild(span);
        }
    };

    function argValue(v, el, ev) {
        if (typeof v === "string") {
            if (v === "$el") return el;
            if (v === "$val") return el.value;
            if (v === "$checked") return el.checked;
            if (v === "$src") return el.src;
            if (v === "$e") return ev;
        }
        return v;
    }

    function parsePlan(el, type) {
        var raw = el.getAttribute("data-act-" + type) || el.getAttribute("data-act");
        if (!raw) return null;
        raw = raw.trim();
        if (raw.charAt(0) === "[") {
            try {
                var parsed = JSON.parse(raw);
                return Array.isArray(parsed) ? parsed : null;
            } catch (err) {
                if (global.console) console.warn("[data-act] unparseable plan", raw);
                return null;
            }
        }
        // Declared-spec form, e.g.  data-act="updateOrderStatus(id, this.value)".
        // Parsed by the allow-listed tokenizer below - never eval / Function.
        var spec = parseSpec(raw);
        if (spec) return spec;
        // Bare-name form: data-act="fnName" + data-arg='["a",1]'
        var bare = raw.trim();
        if (/^[A-Za-z_$][\w$]*$/.test(bare)) {
            var args = [];
            try {
                args = JSON.parse(el.getAttribute("data-arg") || "[]");
            } catch (err2) {
                args = [];
            }
            if (!Array.isArray(args)) args = [];
            return [[bare, args]];
        }
        if (global.console) console.warn("[data-act] unsupported spec", raw);
        return null;
    }

    // ---- strict tokenizer for declared specs -------------------------------
    // Deliberately tiny: only the exact shapes the migrated call sites used.
    // Anything unexpected returns null so the call is skipped and logged,
    // rather than being evaluated.
    var SIMPLE = {
        "this": "$el",
        "event": "$e",
        "true": true,
        "false": false,
        "null": null
    };

    function scan(src, i, stopChars) {
        // returns { value, end } for one token, or null
        while (i < src.length && /\s/.test(src[i])) i++;
        if (i >= src.length) return null;
        var c = src[i];
        if (c === "'" || c === '"') {
            var buf = c;
            i++;
            while (i < src.length) {
                if (src[i] === "\\") { buf += src[i] + (src[i + 1] || ""); i += 2; continue; }
                buf += src[i];
                if (src[i] === c) { i++; break; }
                i++;
            }
            var inner = buf.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
            return { value: inner, end: i, quoted: true };
        }
        var start = i;
        while (i < src.length && stopChars.indexOf(src[i]) === -1) i++;
        var word = src.slice(start, i);
        if (!word) return null;
        if (/^-?\d+(?:\.\d+)?$/.test(word)) return { value: Number(word), end: i };
        return { value: word, end: i, word: true };
    }

    function parseSpec(src) {
        if (!src || src.length > 400) return null;
        var steps = [];
        var i = 0;
        var guard = 0;
        while (i < src.length) {
            if (guard++ > 40) return null;
            while (i < src.length && (/\s/.test(src[i]) || src[i] === ";")) i++;
            if (i >= src.length) break;

            // window.location.href = 'x'
            var navm = src.slice(i).match(/^window\.location\.href\s*=\s*/);
            if (navm) {
                i += navm[0].length;
                var nt = scan(src, i, "");
                if (!nt || !nt.quoted) return null;
                steps.push(["$nav", [nt.value]]);
                i = nt.end;
                continue;
            }

            // event.preventDefault() / event.stopPropagation() must be matched
            // before the generic call path, which would choke on the dot.
            var evtM = src.slice(i).match(/^event\s*\.\s*(preventDefault|stopPropagation)\s*\(\s*\)/);
            if (evtM) {
                steps.push([evtM[1] === "preventDefault" ? "$prevent" : "$stop", []]);
                i += evtM[0].length;
                continue;
            }

            var nameTok = scan(src, i, "(");
            if (!nameTok || !nameTok.word) return null;
            i = nameTok.end;
            while (i < src.length && /\s/.test(src[i])) i++;
            if (src[i] !== "(") return null;
            i++;
            var args = [];
            for (;;) {
                while (i < src.length && /\s/.test(src[i])) i++;
                if (src[i] === ")") { i++; break; }
                if (i >= src.length) return null;
                var t = scan(src, i, ",)");
                if (!t) return null;
                i = t.end;
                var key = t.word ? t.word : null;
                if (key && Object.prototype.hasOwnProperty.call(SIMPLE, key)) {
                    args.push(SIMPLE[key]);
                } else if (key && key.indexOf("this.") === 0) {
                    var prop = key.slice(5);
                    if (prop !== "value" && prop !== "checked" && prop !== "src") return null;
                    args.push(prop === "value" ? "$val" : (prop === "checked" ? "$checked" : "$src"));
                } else if (t.quoted) {
                    args.push(t.value);
                } else if (typeof t.value === "number") {
                    args.push(t.value);
                } else {
                    return null; // bare identifier / unsupported expression
                }
                while (i < src.length && /\s/.test(src[i])) i++;
                if (src[i] === ",") { i++; continue; }
                if (src[i] === ")") { i++; break; }
                return null;
            }

            var fname = nameTok.value;
            if (fname.indexOf(".") !== -1) return null; // no arbitrary member calls
            steps.push([fname, args]);
        }
        return steps.length ? steps : null;
    }

    function runPlan(el, ev, type) {
        var steps = parsePlan(el, type);
        if (!steps) return;
        for (var i = 0; i < steps.length; i++) {
            var step = steps[i];
            var name = step[0];
            var isBuiltin = Object.prototype.hasOwnProperty.call(BUILTIN, name);
            var fn = isBuiltin ? BUILTIN[name] : global[name];
            if (typeof fn !== "function") {
                if (global.console) console.warn("[data-act] no such function:", name);
                continue;
            }
            // A step's payload may be an argument array or a single scalar
            // (e.g. ["$nav","index.html"]). Scalars must not be iterated, or a
            // string would be split into individual characters.
            var rawArgs = step[1];
            if (rawArgs === undefined || rawArgs === null) rawArgs = [];
            else if (!Array.isArray(rawArgs)) rawArgs = [rawArgs];
            var args = [];
            for (var j = 0; j < rawArgs.length; j++) args.push(argValue(rawArgs[j], el, ev));
            try {
                // Builtins get the event first and the element as `this`;
                // page handlers keep the original inline-handler call shape.
                if (isBuiltin) fn.apply(el, [ev].concat(args));
                else fn.apply(el, args);
            } catch (err3) {
                if (global.console) console.error("[data-act] " + name + " threw", err3);
            }
        }
    }

    function owner(el, type) {
        var n = el;
        var specific = "data-act-" + type;
        while (n && n.nodeType === 1) {
            if (n.hasAttribute && (n.hasAttribute(specific) || n.hasAttribute("data-act"))) return n;
            n = n.parentElement;
        }
        return null;
    }

    function delegate(type) {
        document.addEventListener(type, function (ev) {
            var t = ev.target;
            if (!t || t.nodeType !== 1) return;
            var el = owner(t, type);
            if (el) runPlan(el, ev, type);
        });
    }

    ["click", "change", "input", "keydown", "submit", "blur", "focus"].forEach(delegate);

    // Resource errors (img onerror) do not bubble - listen in capture phase.
    document.addEventListener("error", function (ev) {
        var t = ev.target;
        if (!t || t.nodeType !== 1) return;
        var el = owner(t, "error");
        if (el) runPlan(el, ev, "error");
    }, true);

    // Exposed so innerHTML templates can emit escaped plans safely.
    global.fmActionAttr = function (name, args) {
        return escAttr(JSON.stringify([[name, args || []]]));
    };
    global.escAttr = function (s) {
        return String(s == null ? "" : s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    };

    // Fallback dark-mode toggle for the pages that load neither script.js nor
    // features.js (subscription.html, delivery.html). Pages that ship their own
    // copy load it later and win, because global function declarations are
    // applied in load order.
    if (typeof global.toggleDarkMode !== "function") {
        global.toggleDarkMode = function () {
            if (!document.body) return;
            document.body.classList.toggle("dark-mode");
            var isDark = document.body.classList.contains("dark-mode");
            try {
                var KEY = "freshMartTheme";
                if (typeof writeStorageValue === "function") writeStorageValue(KEY, isDark ? "dark" : "light");
                else if (global.localStorage) global.localStorage.setItem(KEY, isDark ? "dark" : "light");
            } catch (e) { }
            if (typeof updateDarkModeIcon === "function") { updateDarkModeIcon(); return; }
            var btn = document.getElementById("darkModeToggle");
            if (!btn) return;
            btn.innerHTML = isDark ? "☀️" : "🌙";
            btn.title = isDark ? "Switch to Light Mode" : "Switch to Dark Mode";
        };
    }
})(window);

// Node-visible surface used ONLY by automated regression suites — harmless in
// the browser (typeof module is undefined there).
if (typeof module !== "undefined" && module.exports) {
    module.exports = { toValidLatLng: toValidLatLng, parseCoord: parseCoord, canonicalLocation: canonicalLocation, deliveryLocationPayload: deliveryLocationPayload, locationSubmitGuard: locationSubmitGuard, geocodeToAddress: geocodeToAddress, captureCurrentLocation: captureCurrentLocation, geolocationErrorFor: geolocationErrorFor, openInMapsHref: openInMapsHref, openMapView: openMapView, API: API, apiDeliveryCoverage: apiDeliveryCoverage, apiGetSearchSuggestions: apiGetSearchSuggestions, apiAiSearch: apiAiSearch, trackEvent: trackEvent, apiGetProductReviews: apiGetProductReviews, apiUploadReviewPhoto: apiUploadReviewPhoto, apiGetMyWallet: apiGetMyWallet, apiGetMyWalletTransactions: apiGetMyWalletTransactions, apiGetMyReferral: apiGetMyReferral, apiClaimReferral: apiClaimReferral, apiSubscribeStockAlert: apiSubscribeStockAlert, apiAdminAnalytics: apiAdminAnalytics, apiAdminStockAlertsWaiting: apiAdminStockAlertsWaiting };
}
