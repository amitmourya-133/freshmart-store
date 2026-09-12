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
            if (data.token) setAuthToken(data.token);
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
            if (!data.success) throw new Error(data.message || "Login failed");
            if (data.token) setAuthToken(data.token);
            return data;
        });
}

function apiSendOTP(email) {
    return fetch(API.base + "/users/send-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email })
    }).then(function(res) { return res.json(); });
}

function apiVerifyOTP(email, otp) {
    return fetch(API.base + "/users/verify-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email, otp: otp })
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "OTP verification failed");
            if (data.token) setAuthToken(data.token);
            return data;
        });
}

// ---------- ADMIN ----------
// Fetch all orders (admin)
function fetchAdminOrders() {
    return fetch(API.base + "/orders", {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed");
            return data.data;
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

// ---------- PAYMENT (Razorpay) ----------

// Check whether Razorpay is configured (live vs demo mode)
function apiPaymentConfig() {
    return fetch(API.base + "/payments/config")
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data.success) throw new Error(data.message || "Failed to check payment config");
            return data;
        });
}

// Create Razorpay order for an existing unpaid order (amount is server-authoritative)
function apiCreatePaymentOrder(data) {
    return fetch(API.base + "/payments/create-order", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed to initialise payment");
            return res;
        });
}

// Verify payment after Razorpay checkout
function apiVerifyPayment(data) {
    return fetch(API.base + "/payments/verify", {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify(data)
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Payment verification failed");
            return res.data;
        });
}

// Initiate refund (admin)
function apiRefundPayment(id) {
    return fetch(API.base + "/payments/refund/" + id, {
        method: "POST",
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Refund failed");
            return res.data;
        });
}

// Get receipt / payment details
function apiGetReceipt(id) {
    return fetch(API.base + "/payments/receipt/" + id, {
        headers: getAuthHeaders()
    })
        .then(function(res) { return res.json(); })
        .then(function(res) {
            if (!res.success) throw new Error(res.message || "Failed");
            return res.data;
        });
}
