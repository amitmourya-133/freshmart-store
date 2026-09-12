// ===============================
// FRESHMART - ADMIN PANEL LOGIC
// ===============================

var adminOrders = [];
var adminProducts = [];
var adminEditingId = null;

var ORDER_STATUSES = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];

function adminLogout() {
    setAuthToken(null);
    localStorage.removeItem("freshMartLoggedIn");
    writeStorageValue("freshMartUser", null);
    window.location.href = "login.html";
}

function switchTab(tab) {
    var ordersSec = document.getElementById("adminOrdersSection");
    var productsSec = document.getElementById("adminProductsSection");
    var ordersBtn = document.getElementById("tabOrdersBtn");
    var productsBtn = document.getElementById("tabProductsBtn");

    if (tab === "orders") {
        ordersSec.style.display = "block";
        productsSec.style.display = "none";
        ordersBtn.classList.add("active");
        productsBtn.classList.remove("active");
        loadAdminOrders();
    } else {
        ordersSec.style.display = "none";
        productsSec.style.display = "block";
        productsBtn.classList.add("active");
        ordersBtn.classList.remove("active");
        loadAdminProducts();
    }
}

// ===============================
// ORDERS TAB
// ===============================

function loadAdminOrders() {
    var container = document.getElementById("adminOrdersList");
    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading orders...</p>';

    fetchAdminOrders()
        .then(function(orders) {
            adminOrders = orders;
            renderOrders();
        })
        .catch(function(err) {
            container.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:40px;">' +
                (err.message || "Failed to load orders. Make sure you are logged in as admin.") + '</p>';
        });
}

function renderOrders() {
    var container = document.getElementById("adminOrdersList");

    if (!adminOrders || adminOrders.length === 0) {
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">📦</div><h3>No orders yet</h3><p>Customer orders will appear here.</p></div>';
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
        else if (order.status === "Shipped" || order.status === "Processing" || order.status === "Preparing" || order.status === "Out for Delivery" || order.status === "Confirmed") statusColor = "#f39c12";

        html += '<div class="admin-order-card">' +
            '<div class="admin-order-head">' +
                '<div><strong>#' + (order.orderNumber || order._id || "N/A") + '</strong>' +
                '<span class="admin-order-date">' + (order.date || order.createdAt || "") + '</span></div>' +
                '<span class="order-status-badge" style="background:' + statusColor + ';">' + (order.status || "Placed") + '</span>' +
            '</div>' +
            '<div class="admin-order-customer">' +
                (customer.name || order.name || "Customer") + ' • ' + (customer.phone || order.phone || "") +
                '<div class="admin-order-address">' + (customer.address || order.address || "") + (customer.city ? ", " + customer.city : "") + (customer.pincode ? " - " + customer.pincode : "") + '</div>' +
            '</div>' +
            '<div class="admin-order-items">' + itemsHtml + '</div>' +
            '<div class="admin-order-foot">' +
                '<div class="admin-order-total">Total: <strong>₹' + (order.total || 0) + '</strong></div>' +
                '<div class="admin-order-actions">' +
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

function changeOrderStatus(orderId, status) {
    apiUpdateOrderStatus(orderId, status)
        .then(function() {
            showToast("Order marked as " + status, "success");
            loadAdminOrders();
        })
        .catch(function(err) {
            showToast(err.message || "Failed to update status", "error");
            loadAdminOrders();
        });
}

// ===============================
// PRODUCTS TAB
// ===============================

function loadAdminProducts() {
    var container = document.getElementById("adminProductsList");

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

        html += '<div class="admin-product-card' + (inactive ? " inactive" : "") + '">' +
            '<div class="admin-product-emoji" style="background:' + (p.gradient || "linear-gradient(135deg,#56ab2f,#a8e063)") + ';">' +
                (p.emoji || "🥬") +
                (inactive ? '<span class="inactive-tag">Hidden</span>' : '') +
            '</div>' +
            '<div class="admin-product-info">' +
                '<div class="admin-product-name">' + (p.name || "Product") + '</div>' +
                '<div class="admin-product-meta">' + (p.category || "") + ' • ₹' + (p.price || 0) + ' / ' + (p.unit || "") + '</div>' +
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
    if (!confirm("Remove this product from the store?")) return;
    apiDeleteProduct(productId)
        .then(function() {
            showToast("Product removed", "success");
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
    document.getElementById("pfDescription").value = "";
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
    document.getElementById("pfDescription").value = p.description || "";
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
        description: document.getElementById("pfDescription").value.trim()
    };

    if (!data.name) {
        showToast("Product name required", "error");
        return;
    }

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

    switchTab("orders");
}

// Ensure showToast exists even if script.js order differs
if (typeof showToast === "undefined") {
    function showToast(msg, type) {
        alert(msg);
    }
}

document.addEventListener("DOMContentLoaded", initAdminPage);
