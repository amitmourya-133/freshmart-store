// ===============================
// FRESHMART - API LAYER
// Handles backend calls with localStorage fallback
// ===============================

const API = {
    base: (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
        ? "http://localhost:5000/api"
        : "/api"
};

// ---------- AUTH TOKEN ----------
function getAuthToken() {
    return readStorageValue("freshMartToken", null);
}

function setAuthToken(token) {
    if (token) writeStorageValue("freshMartToken", token);
    else localStorage.removeItem("freshMartToken");
}

function getAuthHeaders() {
    var token = getAuthToken();
    var headers = { "Content-Type": "application/json" };
    if (token) headers["Authorization"] = "Bearer " + token;
    return headers;
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
    var token = getAuthToken();
    if (!token) return Promise.resolve(null);
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
