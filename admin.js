// ===============================
// FRESHMART - ADMIN PANEL LOGIC
// Backend enforces role="admin" on every admin API.
// ===============================

var adminOrders = [];
var adminProducts = [];
var adminCustomers = [];
var adminReviews = [];
var adminEditingId = null;
var activeTab = "orders";

var ORDER_STATUSES = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];

function adminLogout() {
    setAuthToken(null);
    localStorage.removeItem("freshMartLoggedIn");
    writeStorageValue("freshMartUser", null);
    window.location.href = "login.html";
}

function switchTab(tab) {
    activeTab = tab;
    var sections = {
        orders: "adminOrdersSection",
        products: "adminProductsSection",
        customers: "adminCustomersSection",
        reviews: "adminReviewsSection"
    };
    var buttons = {
        orders: "tabOrdersBtn",
        products: "tabProductsBtn",
        customers: "tabCustomersBtn",
        reviews: "tabReviewsBtn"
    };

    Object.keys(sections).forEach(function(key) {
        var sec = document.getElementById(sections[key]);
        if (sec) sec.style.display = key === tab ? "block" : "none";
        var btn = document.getElementById(buttons[key]);
        if (btn) btn.classList.toggle("active", key === tab);
    });

    if (tab === "orders") loadAdminOrders();
    else if (tab === "products") loadAdminProducts();
    else if (tab === "customers") loadAdminCustomers();
    else if (tab === "reviews") loadAdminReviews();
}

// Helper: resolve the image file for a product (override `image` field wins)
function adminProductImage(p) {
    if (p && p.image) {
        return p.image.indexOf("images/") === 0 ? p.image : "images/" + p.image;
    }
    if (p && typeof getProductImage === "function") {
        return getProductImage(p.name);
    }
    return "";
}

// ===============================
// ORDERS TAB
// ===============================

function loadAdminOrders() {
    var container = document.getElementById("adminOrdersList");
    if (!container) return;

    loadAdminOverview();

    var searchEl = document.getElementById("adminOrderSearch");
    var statusEl = document.getElementById("adminOrderStatus");
    var paymentEl = document.getElementById("adminOrderPayment");
    var filters = {
        search: searchEl ? searchEl.value.trim() : "",
        status: statusEl ? statusEl.value : "",
        paymentStatus: paymentEl ? paymentEl.value : ""
    };

    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading orders...</p>';

    fetchAdminOrders(filters)
        .then(function(orders) {
            adminOrders = orders;
            renderOrders();
        })
        .catch(function(err) {
            container.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:40px;">' +
                (err.message || "Failed to load orders. Make sure you are logged in as admin.") + '</p>';
        });
}

// Dashboard metrics for the Orders tab
function loadAdminOverview() {
    var box = document.getElementById("adminOverview");
    if (!box) return;
    fetchAdminOverview().then(function(m) {
        var cards = [
            { label: "Total Orders", value: m.totalOrders },
            { label: "Pending Orders", value: m.pendingOrders },
            { label: "Delivered", value: m.deliveredOrders },
            { label: "Cancelled", value: m.cancelledOrders },
            { label: "Paid (Payment)", value: m.paidOrders },
            { label: "Total Sales", value: "₹" + m.totalSales },
            { label: "Low Stock (≤" + m.lowStockThreshold + ")", value: m.lowStockProducts, warn: m.lowStockProducts > 0 },
            { label: "Products", value: m.totalProducts },
            { label: "Customers", value: m.totalCustomers }
        ];
        box.innerHTML = cards.map(function(c) {
            return '<div class="admin-stat' + (c.warn ? " stat-warn" : "") + '"><strong>' + c.value + '</strong><span>' + c.label + '</span></div>';
        }).join("");
    }).catch(function() {
        box.innerHTML = "";
    });
}

function payBadge(order) {
    var s = order.paymentStatus || (order.paid ? "PAID" : "PENDING");
    var map = {
        PAID: ["Paid ✓", "#27ae60"],
        PENDING: ["Payment pending", "#f39c12"],
        FAILED: ["Payment failed", "#e74c3c"],
        CANCELLED: ["Not charged", "#7f8c8d"],
        REFUNDED: ["Refunded", "#8e44ad"],
        PENDING_REFUND: ["Refund in progress", "#f39c12"]
    };
    var m = map[s] || [s, "#f39c12"];
    return '<span class="pay-badge" style="background:' + m[1] + ';">' + m[0] + '</span>';
}

function orderDate(order) {
    var d = order.createdAt || order.updatedAt || order.date;
    if (!d) return "";
    try { return new Date(d).toLocaleString(); } catch (e) { return ""; }
}

function renderOrders() {
    var container = document.getElementById("adminOrdersList");
    if (!container) return;

    if (!adminOrders || adminOrders.length === 0) {
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">📦</div><h3>No orders match</h3><p>Customer orders will appear here.</p></div>';
        return;
    }

    var html = "";
    adminOrders.forEach(function(order) {
        var customer = order.customer || {};
        var itemsHtml = "";
        (order.items || []).forEach(function(item) {
            itemsHtml += '<div class="admin-order-item">' +
                '<span>' + (item.name || item.productName || "Item") + ' × ' + (item.quantity || 1) + '</span>' +
                '<strong>₹' + ((item.price || 0) * (item.quantity || 1)) + '</strong>' +
                '</div>';
        });

        var statusColor = "#27ae60";
        if (order.status === "Cancelled") statusColor = "#e74c3c";
        else if (["Preparing", "Out for Delivery", "Confirmed"].indexOf(order.status) !== -1) statusColor = "#f39c12";

        // Manual payment awaiting verification -> quick verify / reject buttons
        var payActions = "";
        if (order.paymentStatus === "PENDING" && order.paymentMode === "manual") {
            payActions = '<button class="row-btn verify" onclick="setOrderPayment(\'' + order._id + '\', \'PAID\')" title="Verify payment">✓ Verify</button>' +
                         '<button class="row-btn reject" onclick="setOrderPayment(\'' + order._id + '\', \'FAILED\', \'Rejected by admin\')" title="Reject payment">✕ Reject</button>';
        }

        html += '<div class="admin-order-card">' +
            '<div class="admin-order-head">' +
                '<div><strong>#' + (order.orderNumber || order._id || "N/A") + '</strong>' +
                (order.trackingId ? '<div class="admin-order-track">Track: ' + order.trackingId + '</div>' : "") +
                '<span class="admin-order-date">' + orderDate(order) + '</span></div>' +
                '<span class="order-status-badge" style="background:' + statusColor + ';">' + (order.status || "Placed") + '</span>' +
            '</div>' +
            payBadge(order) +
            '<div class="admin-order-customer">' +
                (customer.name || order.name || "Customer") + ' • ' + (customer.phone || order.phone || "") +
                '<div class="admin-order-address">' + (customer.address || order.address || "") + (customer.city ? ", " + customer.city : "") + (customer.state ? ", " + customer.state : "") + (customer.pincode ? " - " + customer.pincode : "") + '</div>' +
            '</div>' +
            '<div class="admin-order-items">' + itemsHtml + '</div>' +
            '<div class="admin-order-foot">' +
                '<div class="admin-order-total">Total: <strong>₹' + (order.total || 0) + '</strong></div>' +
                '<div class="admin-order-actions">' +
                    '<button class="row-btn edit" onclick="openOrderDetail(\'' + order._id + '\')" title="View details">👁️</button>' +
                    payActions +
                    '<select class="status-select" onchange="changeOrderStatus(\'' + order._id + '\', this.value)">' +
                        ORDER_STATUSES.map(function(s) {
                            return '<option value="' + s + '" ' + (s === order.status ? "selected" : "") + '>' + s + '</option>';
                        }).join("") +
                    '</select>' +
                '</div>' +
            '</div>' +
        '</div>';
    });

    container.innerHTML = html;
}

// Admin verifies (PAID) or rejects (FAILED/CANCELLED) a manual payment
function setOrderPayment(orderId, paymentStatus, reference) {
    if (paymentStatus === "PAID" && !window.confirm("Confirm this manual UPI payment as received?")) return;
    apiSetOrderPaymentStatus(orderId, paymentStatus, reference || "")
        .then(function() {
            showToast(paymentStatus === "PAID" ? "Payment verified ✓" : "Payment rejected", "success");
            loadAdminOrders();
        })
        .catch(function(err) {
            showToast(err.message || "Failed to update payment", "error");
        });
}

function changeOrderStatus(orderId, status) {
    apiUpdateOrderStatus(orderId, status)
        .then(function() {
            showToast("Order marked as " + status, "success");
            loadAdminOrders();
            if (document.getElementById("orderDetailModal").style.display === "flex") openOrderDetail(orderId, true);
        })
        .catch(function(err) {
            showToast(err.message || "Failed to update status", "error");
            loadAdminOrders();
        });
}

function openOrderDetail(orderId, skipReload) {
    var order = adminOrders.find(function(o) { return o._id === orderId; });
    if (!order) return;

    if (!skipReload) {
        document.getElementById("orderDetailTitle").innerText = "Order #" + (order.orderNumber || order._id);
    }

    var customer = order.customer || {};
    var items = (order.items || []).map(function(item) {
        return '<tr><td>' + (item.name || "Item") + '</td><td>' + (item.quantity || 1) + '</td><td>₹' + (item.price || 0) + '</td><td><strong>₹' + ((item.price || 0) * (item.quantity || 1)) + '</strong></td></tr>';
    }).join("");

    var statusOptions = ORDER_STATUSES.map(function(s) {
        return '<option value="' + s + '" ' + (s === order.status ? "selected" : "") + '>' + s + '</option>';
    }).join("");

    var razorpay = order.razorpay || {};
    var refund = order.refund || {};
    var payActions = "";
    if (order.paymentStatus === "PENDING" && order.paymentMode === "manual") {
        payActions = '<div><button class="row-btn verify" onclick="setOrderPayment(\'' + order._id + '\', \'PAID\')">✓ Verify Payment</button> ' +
            '<button class="row-btn reject" onclick="setOrderPayment(\'' + order._id + '\', \'FAILED\', \'Rejected by admin\')">✕ Reject Payment</button></div>';
    }

    var timeline = (order.statusHistory || []).map(function(h) {
        return '<li><strong>' + (h.status || "—") + '</strong> <small>' + (h.at ? new Date(h.at).toLocaleString() : "") + (h.by ? " · " + h.by : "") + '</small></li>';
    }).join("");

    document.getElementById("orderDetailBody").innerHTML =
        '<div class="order-detail-block">' +
            '<h4>Customer</h4>' +
            '<p>' + (customer.name || order.name || "—") + '</p>' +
            '<p>📞 ' + (customer.phone || order.phone || "—") + '</p>' +
            '<p>✉️ ' + (customer.email || order.email || "—") + '</p>' +
            '<p>📍 ' + ((customer.address || order.address || "") + (customer.city ? ", " + customer.city : "") + (customer.state ? ", " + customer.state : "") + (customer.pincode ? " - " + customer.pincode : "")) + '</p>' +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Payment</h4>' +
            payBadge(order) +
            '<p>Method: ' + (order.paymentMethod || order.payment || "—") + (order.paymentMode ? " (" + order.paymentMode + ")" : "") + '</p>' +
            (order.paymentReference ? '<p>UPI Ref: ' + order.paymentReference + '</p>' : "") +
            '<p>Order ID: ' + (order.trackingId || order.orderNumber || "—") + '</p>' +
            '<p>Razorpay Order: ' + (razorpay.orderId || "—") + '</p>' +
            '<p>Payment ID: ' + (razorpay.paymentId || "—") + '</p>' +
            (refund.id ? '<p>Refund: ' + refund.id + ' (₹' + (refund.amount || order.total || 0) + ')</p>' : (refund.status ? '<p>Refund: ' + refund.status + (refund.reference ? " · " + refund.reference : "") + '</p>' : "")) +
            payActions +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Items</h4>' +
            '<table class="order-detail-table"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>' + items + '</tbody></table>' +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Totals</h4>' +
            '<p>Subtotal: ₹' + (order.subtotal || 0) + '</p>' +
            '<p>Delivery: ₹' + (order.delivery || 0) + '</p>' +
            '<p class="order-detail-total">Total: ₹' + (order.total || 0) + '</p>' +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Status</h4>' +
            '<select class="status-select" onchange="changeOrderStatus(\'' + order._id + '\', this.value)">' + statusOptions + '</select>' +
            (timeline ? '<ul class="order-timeline">' + timeline + '</ul>' : "") +
        '</div>';

    document.getElementById("orderDetailModal").style.display = "flex";
}

function closeOrderDetail() {
    document.getElementById("orderDetailModal").style.display = "none";
}

// ===============================
// PRODUCTS TAB
// ===============================

function loadAdminProducts() {
    var container = document.getElementById("adminProductsList");
    if (!container) return;

    fetchAdminProducts()
        .then(function(products) {
            adminProducts = products;
            renderProducts();
        })
        .catch(function(err) {
            container.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:40px;">' +
                (err.message || "Failed to load products.") + '</p>';
        });
}

function renderProducts() {
    var search = document.getElementById("adminProductSearch");
    var term = search ? search.value.trim().toLowerCase() : "";
    var list = document.getElementById("adminProductsList");
    var stats = document.getElementById("adminStats");
    if (!list || !stats) return;

    var filtered = adminProducts;
    if (term) {
        filtered = adminProducts.filter(function(p) {
            return (p.name || "").toLowerCase().indexOf(term) !== -1 ||
                (p.category || "").toLowerCase().indexOf(term) !== -1;
        });
    }

    var totalStock = adminProducts.reduce(function(sum, p) { return sum + (p.stock || 0); }, 0);
    var lowStock = adminProducts.filter(function(p) { return (p.stock || 0) < 20; }).length;
    var activeCount = adminProducts.filter(function(p) { return p.active !== false; }).length;

    stats.innerHTML =
        '<div class="stat-box"><strong>' + adminProducts.length + '</strong><span>Total Products</span></div>' +
        '<div class="stat-box"><strong>' + activeCount + '</strong><span>Active</span></div>' +
        '<div class="stat-box"><strong>' + totalStock + '</strong><span>Total Stock</span></div>' +
        '<div class="stat-box low"><strong>' + lowStock + '</strong><span>Low Stock (&lt;20)</span></div>';

    if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:30px;">No products found.</p>';
        return;
    }

    var html = "";
    filtered.forEach(function(p) {
        var inactive = p.active === false;
        var low = (!inactive) && (p.stock || 0) < 20;
        var img = adminProductImage(p);
        var imgHtml = img
            ? '<img class="admin-product-img" src="' + img + '" alt="' + (p.name || "") + '" onerror="this.style.display=\'none\'">'
            : '';

        html += '<div class="admin-product-card' + (inactive ? " inactive" : "") + '">' +
            '<div class="admin-product-photo">' +
                imgHtml +
                '<div class="admin-product-emoji" style="background:' + (p.gradient || "linear-gradient(135deg,#56ab2f,#a8e063)") + ';">' +
                    (p.emoji || "🥬") +
                    (inactive ? '<span class="inactive-tag">Hidden</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="admin-product-info">' +
                '<div class="admin-product-name">' + (p.name || "Product") + '</div>' +
                '<div class="admin-product-meta">' + (p.category || "") + ' • ₹' + (p.price || 0) + ' / ' + (p.unit || "") + '</div>' +
                '<div class="admin-product-meta">⭐ ' + (p.rating || 0).toFixed(1) + ' (' + (p.ratingCount || 0) + ' ratings)</div>' +
                '<div class="stock-row">' +
                    '<span class="stock-label' + (low ? " low" : "") + '">Stock: ' + (p.stock || 0) + '</span>' +
                    '<input type="number" class="stock-input" min="0" value="' + (p.stock || 0) + '" onchange="quickStock(\'' + p._id + '\', this.value)" title="Update stock">' +
                '</div>' +
            '</div>' +
            '<div class="admin-product-actions">' +
                '<button class="row-btn edit" onclick="openEditProduct(\'' + p._id + '\')" title="Edit">✏️</button>' +
                (inactive
                    ? '<button class="row-btn restore" onclick="restoreProduct(\'' + p._id + '\')" title="Restore">↩️</button>'
                    : '<button class="row-btn remove" onclick="removeProduct(\'' + p._id + '\')" title="Remove">🗑️</button>'
                ) +
            '</div>' +
        '</div>';
    });

    list.innerHTML = html;
}

function quickStock(productId, value) {
    var stock = parseInt(value, 10);
    if (isNaN(stock) || stock < 0) return;
    apiUpdateStock(productId, stock)
        .then(function() { showToast("Stock updated", "success"); })
        .catch(function(err) { showToast(err.message || "Failed", "error"); });
}

function removeProduct(productId) {
    if (!confirm("Remove this product from the store? (It becomes hidden — nothing is deleted from MongoDB.)")) return;
    apiDeleteProduct(productId)
        .then(function() {
            showToast("Product removed (hidden)", "success");
            loadAdminProducts();
        })
        .catch(function(err) { showToast(err.message || "Failed", "error"); });
}

function restoreProduct(productId) {
    apiUpdateProduct(productId, { active: true })
        .then(function() {
            showToast("Product restored", "success");
            loadAdminProducts();
        })
        .catch(function(err) { showToast(err.message || "Failed", "error"); });
}

// ===============================
// ADD / EDIT PRODUCT MODAL
// ===============================

function updateImagePreview() {
    var wrap = document.getElementById("pfImagePreview");
    if (!wrap) return;
    var val = document.getElementById("pfImage").value.trim();
    var name = (document.getElementById("pfName").value || "").trim();
    var url = "";
    if (val) url = val.indexOf("images/") === 0 ? val : "images/" + val;
    else if (name) url = adminProductImage({ name: name });
    wrap.innerHTML = url
        ? '<img class="admin-img-preview" src="' + url + '" alt="preview" onerror="this.parentNode.innerHTML=\'<span class=admin-img-missing>Image not found: ' + url.replace(/'/g, "") + '</span>\'">'
        : "";
}

function openAddProduct() {
    adminEditingId = null;
    document.getElementById("productModalTitle").innerText = "Add Product";
    document.getElementById("pfId").value = "";
    document.getElementById("pfName").value = "";
    document.getElementById("pfCategory").value = "Vegetables";
    document.getElementById("pfPrice").value = "";
    document.getElementById("pfUnit").value = "kg";
    document.getElementById("pfEmoji").value = "🥬";
    document.getElementById("pfGradient").value = "linear-gradient(135deg, #56ab2f, #a8e063)";
    document.getElementById("pfOrigin").value = "";
    document.getElementById("pfStock").value = 50;
    document.getElementById("pfRating").value = 4.0;
    document.getElementById("pfRatingCount").value = 1;
    document.getElementById("pfImage").value = "";
    document.getElementById("pfDescription").value = "";
    updateImagePreview();
    document.getElementById("productModal").style.display = "flex";
}

function openEditProduct(productId) {
    var p = adminProducts.find(function(x) { return x._id === productId; });
    if (!p) return;

    adminEditingId = productId;
    document.getElementById("productModalTitle").innerText = "Edit Product";
    document.getElementById("pfId").value = productId;
    document.getElementById("pfName").value = p.name || "";
    document.getElementById("pfCategory").value = p.category || "Vegetables";
    document.getElementById("pfPrice").value = p.price || "";
    document.getElementById("pfUnit").value = p.unit || "kg";
    document.getElementById("pfEmoji").value = p.emoji || "";
    document.getElementById("pfGradient").value = p.gradient || "";
    document.getElementById("pfOrigin").value = p.origin || "";
    document.getElementById("pfStock").value = p.stock || 0;
    document.getElementById("pfRating").value = p.rating || 0;
    document.getElementById("pfRatingCount").value = p.ratingCount || 0;
    document.getElementById("pfImage").value = p.image || "";
    document.getElementById("pfDescription").value = p.description || "";
    updateImagePreview();
    document.getElementById("productModal").style.display = "flex";
}

function closeProductModal() {
    document.getElementById("productModal").style.display = "none";
    adminEditingId = null;
}

function saveProduct(event) {
    event.preventDefault();

    var data = {
        name: document.getElementById("pfName").value.trim(),
        category: document.getElementById("pfCategory").value,
        price: parseFloat(document.getElementById("pfPrice").value) || 0,
        unit: document.getElementById("pfUnit").value.trim(),
        emoji: document.getElementById("pfEmoji").value.trim(),
        gradient: document.getElementById("pfGradient").value.trim(),
        origin: document.getElementById("pfOrigin").value.trim(),
        stock: parseInt(document.getElementById("pfStock").value, 10) || 0,
        rating: parseFloat(document.getElementById("pfRating").value),
        ratingCount: parseInt(document.getElementById("pfRatingCount").value, 10),
        image: document.getElementById("pfImage").value.trim(),
        description: document.getElementById("pfDescription").value.trim()
    };

    if (!data.name) {
        showToast("Product name required", "error");
        return;
    }
    if (isNaN(data.rating)) delete data.rating;
    if (isNaN(data.ratingCount)) delete data.ratingCount;

    var request;
    if (adminEditingId) {
        request = apiUpdateProduct(adminEditingId, data);
    } else {
        request = apiCreateProduct(data);
    }

    request
        .then(function() {
            showToast(adminEditingId ? "Product updated" : "Product added", "success");
            closeProductModal();
            loadAdminProducts();
        })
        .catch(function(err) {
            showToast(err.message || "Failed to save product", "error");
        });
}

// ===============================
// CUSTOMERS TAB
// ===============================

function loadAdminCustomers() {
    var container = document.getElementById("adminCustomersList");
    if (!container) return;
    var searchInput = document.getElementById("adminCustomerSearch");
    var search = searchInput ? searchInput.value.trim() : "";

    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading customers...</p>';

    fetchAdminCustomers(search)
        .then(function(users) {
            adminCustomers = users;
            renderCustomers();
        })
        .catch(function(err) {
            container.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:40px;">' +
                (err.message || "Failed to load customers.") + '</p>';
        });
}

function renderCustomers() {
    var container = document.getElementById("adminCustomersList");
    if (!container) return;

    if (!adminCustomers || adminCustomers.length === 0) {
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">👥</div><h3>No customers yet</h3><p>Registered users will appear here.</p></div>';
        return;
    }

    var rows = adminCustomers.map(function(u) {
        var joined = "";
        if (u.createdAt) {
            var d = new Date(u.createdAt);
            joined = isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        }
        var roleBadge = (u.role === "admin" || u.isAdmin)
            ? '<span class="role-badge admin">Admin</span>'
            : '<span class="role-badge">Customer</span>';
        var orderCount = (u.orderCount !== undefined) ? u.orderCount : "—";
        return '<div class="admin-customer-row">' +
            '<div class="admin-customer-main"><strong>' + (u.name || "—") + '</strong>' + roleBadge +
                '<div>' + (u.email || "") + (u.phone ? " • " + u.phone : "") + '</div>' +
                '<div class="admin-customer-meta">Orders placed: ' + orderCount + '</div></div>' +
            '<div class="admin-customer-date">' + joined + '</div>' +
        '</div>';
    }).join("");

    container.innerHTML = '<div class="admin-customer-list">' + rows + '</div>';
}

// ===============================
// REVIEWS TAB
// ===============================

function loadAdminReviews() {
    var container = document.getElementById("adminReviewsList");
    if (!container) return;
    var searchInput = document.getElementById("adminReviewSearch");
    var search = searchInput ? searchInput.value.trim() : "";

    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading reviews...</p>';

    fetchAdminReviews(search)
        .then(function(reviews) {
            adminReviews = reviews;
            renderReviews();
        })
        .catch(function(err) {
            container.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:40px;">' +
                (err.message || "Failed to load reviews.") + '</p>';
        });
}

function renderReviews() {
    var container = document.getElementById("adminReviewsList");
    if (!container) return;

    if (!adminReviews || adminReviews.length === 0) {
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">⭐</div><h3>No reviews yet</h3><p>Customer reviews will appear here.</p></div>';
        return;
    }

    var html = "";
    adminReviews.forEach(function(rev) {
        var date = "";
        if (rev.createdAt) {
            var d = new Date(rev.createdAt);
            date = isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
        }
        html += '<div class="admin-review-card">' +
            '<div class="admin-review-head">' +
                '<div><strong>' + (rev.productName || "Product") + '</strong>' +
                '<span class="admin-review-user"> by ' + (rev.userName || "Anonymous") + '</span></div>' +
                '<div class="admin-review-actions">' +
                    '<span class="admin-review-rating">' + (typeof starHTML === "function" ? starHTML(rev.rating) : ("★".repeat(rev.rating) + "★".repeat(5 - rev.rating))) + '</span>' +
                    '<button class="row-btn remove" onclick="deleteReview(\'' + rev._id + '\', \'' + String(rev.productName || "").replace(/'/g, "") + '\')" title="Delete review">🗑️</button>' +
                '</div>' +
            '</div>' +
            '<p class="admin-review-comment">' + (rev.comment || "") + '</p>' +
            '<div class="admin-review-date">' + date + '</div>' +
        '</div>';
    });

    container.innerHTML = html;
}

function deleteReview(reviewId, productName) {
    if (!confirm("Delete this review" + (productName ? " for " + productName : "") + "?")) return;
    apiDeleteReview(reviewId)
        .then(function() {
            showToast("Review deleted", "success");
            loadAdminReviews();
        })
        .catch(function(err) {
            showToast(err.message || "Failed to delete review", "error");
        });
}

// ===============================
// PAGE LOAD
// ===============================

function initAdminPage() {
    initDarkMode();

    var token = getAuthToken();
    if (!token) {
        showToast("Please login as admin first", "error");
        setTimeout(function() { window.location.href = "login.html"; }, 800);
        return;
    }

    // Backend-verified role check: a normal customer token cannot use the
    // admin panel even if they know the URL (APIs are also admin-protected).
    apiGetMe()
        .then(function(user) {
            if (!(user && user.role === "admin")) {
                showToast("Admin access only", "error");
                setTimeout(function() { window.location.href = "index.html"; }, 800);
                return;
            }
            switchTab("orders");
        })
        .catch(function() {
            showToast("Session expired. Please login again.", "error");
            setTimeout(function() { window.location.href = "login.html"; }, 800);
        });
}

// Ensure showToast exists even if script.js order differs
if (typeof showToast === "undefined") {
    function showToast(msg, type) {
        alert(msg);
    }
}

document.addEventListener("DOMContentLoaded", initAdminPage);