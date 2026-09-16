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

// DB-backed store configuration (delivery + low-stock threshold).
var adminSettings = { deliveryCharge: 20, freeDeliveryThreshold: 500, lowStockThreshold: 20, minimumOrderValue: 0 };
var adminSettingsLoaded = false;

var ORDER_STATUSES = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];

function loadAdminSettings() {
    if (adminSettingsLoaded || typeof apiGetSettings !== "function") return Promise.resolve(adminSettings);
    return apiGetSettings().then(function(s) {
        adminSettings = {
            deliveryCharge: (typeof s.deliveryCharge === "number" && s.deliveryCharge >= 0) ? s.deliveryCharge : 20,
            freeDeliveryThreshold: (typeof s.freeDeliveryThreshold === "number" && s.freeDeliveryThreshold >= 0) ? s.freeDeliveryThreshold : 500,
            lowStockThreshold: (typeof s.lowStockThreshold === "number" && s.lowStockThreshold >= 1) ? s.lowStockThreshold : 20,
            minimumOrderValue: (typeof s.minimumOrderValue === "number" && s.minimumOrderValue >= 0) ? s.minimumOrderValue : 0
        };
        adminSettingsLoaded = true;
        return adminSettings;
    }).catch(function() {
        return adminSettings;
    });
}

function adminLogout() {
    setAuthToken(null);
    localStorage.removeItem("freshMartLoggedIn");
    writeStorageValue("freshMartUser", null);
    window.location.href = "login.html";
}

function switchTab(tab) {
    activeTab = tab;
    var sections = {
        dashboard: "adminDashboardSection",
        orders: "adminOrdersSection",
        products: "adminProductsSection",
        customers: "adminCustomersSection",
        reviews: "adminReviewsSection",
        coupons: "adminCouponsSection",
        settings: "adminSettingsSection"
    };
    var buttons = {
        dashboard: "tabDashboardBtn",
        orders: "tabOrdersBtn",
        products: "tabProductsBtn",
        customers: "tabCustomersBtn",
        reviews: "tabReviewsBtn",
        coupons: "tabCouponsBtn",
        settings: "tabSettingsBtn"
    };

    Object.keys(sections).forEach(function(key) {
        var sec = document.getElementById(sections[key]);
        if (sec) sec.style.display = key === tab ? "block" : "none";
        var btn = document.getElementById(buttons[key]);
        if (btn) btn.classList.toggle("active", key === tab);
    });

    if (tab === "dashboard") loadAdminDashboard();
    else if (tab === "orders") loadAdminOrders();
    else if (tab === "products") loadAdminProducts();
    else if (tab === "customers") loadAdminCustomers();
    else if (tab === "reviews") loadAdminReviews();
    else if (tab === "coupons") loadAdminCoupons();
    else if (tab === "settings") renderSettingsTab();
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
            { label: "Processing", value: m.preparingOrders },
            { label: "Delivered", value: m.deliveredOrders },
            { label: "Cancelled", value: m.cancelledOrders },
            { label: "Paid (Payment)", value: m.paidOrders },
            { label: "Total Sales", value: "â‚¹" + m.totalSales },
            { label: "Low Stock (â‰¤" + m.lowStockThreshold + ")", value: m.lowStockProducts, warn: m.lowStockProducts > 0 },
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

// Dashboard tab: real DB-backed store metrics + sales analytics
function loadAdminDashboard() {
    var box = document.getElementById("adminDashboardStats");
    if (!box) return;
    box.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:20px;">Loading dashboard...</p>';

    var overviewP = (typeof fetchAdminOverview === "function")
        ? fetchAdminOverview().catch(function() { return null; })
        : Promise.resolve(null);
    var dashP = (typeof fetchAdminDashboard === "function")
        ? fetchAdminDashboard().catch(function() { return null; })
        : Promise.resolve(null);

    Promise.all([overviewP, dashP]).then(function(results) {
        var m = results[0] || {};
        var d = results[1] || {};

        var cards = [];
        function card(label, value, warn) {
            cards.push({ label: label, value: value, warn: !!warn });
        }

        if (d && d.today && typeof d.today === "object") {
            card("Today's Sales", "₹" + (d.today.sales || 0).toLocaleString("en-IN"));
            card("Today's Orders", d.today.orders || 0);
            card("Pending Orders", d.pendingOrders, (d.pendingOrders || 0) > 0);
            card("Delivered Orders", d.deliveredOrders);
            card("Total Sales", "₹" + (d.totalSales || 0).toLocaleString("en-IN"));
            card("Total Orders", d.totalOrders);
            card("Total Products", m.totalProducts != null ? m.totalProducts : (d.totalOrders !== undefined ? "" : ""));
            card("Total Customers", m.totalCustomers != null ? m.totalCustomers : "");
            card("Cancelled Orders", d.cancelledOrders);
        } else {
            // Backwards-compatible overview grid (old endpoint only).
            card("Total Products", m.totalProducts);
            card("Total Customers", m.totalCustomers);
            card("Total Orders", m.totalOrders);
            card("Pending Orders", m.pendingOrders);
            card("Processing Orders", m.preparingOrders);
            card("Delivered Orders", m.deliveredOrders);
            card("Total Sales", "₹" + (m.totalSales || 0));
            card("Cancelled", m.cancelledOrders);
            card("Paid (Payment)", m.paidOrders);
            card("Low Stock (≤" + m.lowStockThreshold + ")", m.lowStockProducts, m.lowStockProducts > 0);
            card("Out of Stock", m.outOfStockProducts, m.outOfStockProducts > 0);
        }

        var statsHtml = cards.map(function(c) {
            return '<div class="admin-stat' + (c.warn ? " stat-warn" : "") + '"><strong>' + c.value + '</strong><span>' + c.label + '</span></div>';
        }).join("");

        var lower = "";
        if (d && d.today) lower = renderDashboardDetails(d);

        box.innerHTML = '<div class="admin-dash-grid">' + statsHtml + '</div>' + lower;
        if (d && d.salesDefinition && document.getElementById("dashSalesNote")) {
            document.getElementById("dashSalesNote").title = d.salesDefinition;
        }
    }).catch(function(err) {
        box.innerHTML = '<p style="text-align:center;color:#e74c3c;padding:20px;">' +
            (err.message || "Failed to load dashboard") + '</p>';
    });
}

// Escape the value shown inside HTML (dashboard numbers/stocks are safe, but
// product names can contain < > & which must not corrupt the markup).
function dashEsc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderDashboardDetails(d) {
    var top = (d.topSelling || []).map(function(t) {
        return '<div class="dash-item"><span>' + dashEsc(t.name) + '</span><strong>' + t.quantity + ' sold</strong></div>';
    }).join("") || '<p class="dash-empty">No sales recorded.</p>';

    var low = (d.lowStock || []).map(function(p) {
        return '<div class="dash-item"><span>⚠️ ' + dashEsc(p.name) + '</span><strong>' + p.stock + '</strong></div>';
    }).join("") || '<p class="dash-empty">No low-stock products.</p>';

    var out = (d.outOfStock || []).map(function(p) {
        return '<div class="dash-item"><span>❌ ' + dashEsc(p.name) + '</span><strong>0</strong></div>';
    }).join("") || '<p class="dash-empty">No out-of-stock products.</p>';

    var rows = (d.dateWise || []).map(function(r) {
        return '<tr><td>' + dashEsc(r.date) + '</td><td>₹' + (r.sales || 0).toLocaleString("en-IN") + '</td><td>' + r.orders + '</td></tr>';
    }).join("") || '<tr><td colspan="3">No data</td></tr>';

    return '' +
        '<div class="dash-blocks">' +
            '<div class="dash-block dash-today">' +
                '<h4>📅 Today (' + (d.today ? d.today.date : "") + ')</h4>' +
                '<div class="dash-today-nums">' +
                    '<div class="dash-num"><strong>₹' + (d.today ? (d.today.sales || 0).toLocaleString("en-IN") : 0) + '</strong><span>Sales</span></div>' +
                    '<div class="dash-num"><strong>' + (d.today ? d.today.orders : 0) + '</strong><span>Orders</span></div>' +
                    '<div class="dash-num"><strong>' + d.pendingOrders + '</strong><span>Pending</span></div>' +
                    '<div class="dash-num"><strong>' + d.deliveredOrders + '</strong><span>Delivered</span></div>' +
                '</div>' +
            '</div>' +
            '<div class="dash-block">' +
                '<h4>🏆 Top Selling Products</h4>' +
                '<div class="dash-list">' + top + '</div>' +
            '</div>' +
            '<div class="dash-block">' +
                '<h4>📉 Low Stock (≤ ' + d.lowStockThreshold + ')</h4>' +
                '<div class="dash-list">' + low + '</div>' +
            '</div>' +
            '<div class="dash-block">' +
                '<h4>💥 Out of Stock</h4>' +
                '<div class="dash-list">' + out + '</div>' +
            '</div>' +
        '</div>' +
        '<div class="dash-range-block">' +
            '<div class="dash-range-head">' +
                '<h4>📊 Date-wise Sales</h4>' +
                '<span id="dashSalesNote" class="dash-note" title="">Sales = non-cancelled order totals (server-computed)</span>' +
            '</div>' +
            '<div class="dash-range-controls">' +
                '<label>From <input type="date" id="dashFrom" value="' + dashEsc(d.from || "") + '"></label>' +
                '<label>To <input type="date" id="dashTo" value="' + dashEsc(d.to || "") + '"></label>' +
                '<button type="button" class="secondary-btn" onclick="loadDashboardRange()">Apply</button>' +
            '</div>' +
            '<table class="dash-table"><thead><tr><th>Date</th><th>Sales</th><th>Orders</th></tr></thead>' +
            '<tbody id="dashDateWiseBody">' + rows + '</tbody></table>' +
        '</div>';
}

// Re-fetch the date-wise table with the admin-chosen range.
function loadDashboardRange() {
    var fromEl = document.getElementById("dashFrom");
    var toEl = document.getElementById("dashTo");
    var body = document.getElementById("dashDateWiseBody");
    if (!body) return;
    var from = fromEl ? fromEl.value : "";
    var to = toEl ? toEl.value : "";
    body.innerHTML = '<tr><td colspan="3">Loading...</td></tr>';
    fetchAdminDashboard(from, to).then(function(d) {
        var rows = (d.dateWise || []).map(function(r) {
            return '<tr><td>' + dashEsc(r.date) + '</td><td>₹' + (r.sales || 0).toLocaleString("en-IN") + '</td><td>' + r.orders + '</td></tr>';
        }).join("");
        body.innerHTML = rows || '<tr><td colspan="3">No data</td></tr>';
        var note = document.getElementById("dashSalesNote");
        if (note && d.salesDefinition) note.title = d.salesDefinition;
    }).catch(function(err) {
        body.innerHTML = '<tr><td colspan="3">' + dashEsc(err.message || "Failed to load") + '</td></tr>';
    });
}

function payBadge(order) {
    var s = order.paymentStatus || (order.paid ? "PAID" : "PENDING");
    var map = {
        PAID: ["Paid &#10003;", "#27ae60"],
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
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">ðŸ“¦</div><h3>No orders match</h3><p>Customer orders will appear here.</p></div>';
        return;
    }

    var html = "";
    adminOrders.forEach(function(order) {
        var customer = order.customer || {};
        var itemsHtml = "";
        (order.items || []).forEach(function(item) {
            itemsHtml += '<div class="admin-order-item">' +
                '<span>' + (item.name || item.productName || "Item") + ' Ã— ' + (item.quantity || 1) + '</span>' +
                '<strong>â‚¹' + ((item.price || 0) * (item.quantity || 1)) + '</strong>' +
                '</div>';
        });

        var statusColor = "#27ae60";
        if (order.status === "Cancelled") statusColor = "#e74c3c";
        else if (["Preparing", "Out for Delivery", "Confirmed"].indexOf(order.status) !== -1) statusColor = "#f39c12";

        // Manual payment awaiting verification -> quick verify / reject buttons
        var payActions = "";
        if (order.paymentStatus === "PENDING" && order.paymentMode === "manual") {
            payActions = '<button class="row-btn verify" onclick="setOrderPayment(\'' + order._id + '\', \'PAID\')" title="Verify payment">âœ“ Verify</button>' +
                         '<button class="row-btn reject" onclick="setOrderPayment(\'' + order._id + '\', \'FAILED\', \'Rejected by admin\')" title="Reject payment">âœ• Reject</button>';
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
                (customer.name || order.name || "Customer") + ' â€¢ ' + (customer.phone || order.phone || "") +
                (customer.email || (order.user && order.user.email) ? '<div class="admin-order-email">âœ‰ï¸ ' + (customer.email || (order.user && order.user.email)) + '</div>' : "") +
                '<div class="admin-order-address">' + (customer.address || order.address || "") + (customer.city ? ", " + customer.city : "") + (customer.state ? ", " + customer.state : "") + (customer.pincode ? " - " + customer.pincode : "") + '</div>' +
            '</div>' +
            '<div class="admin-order-items">' + itemsHtml + '</div>' +
            '<div class="admin-order-foot">' +
                '<div class="admin-order-total">Total: <strong>â‚¹' + (order.total || 0) + '</strong></div>' +
                '<div class="admin-order-actions">' +
                    '<button class="row-btn edit" onclick="openOrderDetail(\'' + order._id + '\')" title="View details">ðŸ‘ï¸</button>' +
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
            showToast(paymentStatus === "PAID" ? "Payment verified âœ“" : "Payment rejected", "success");
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
    showOrderDetail(order, skipReload);
}

// Render an order object into the detail modal (used by order list + customer history)
function showOrderDetail(order, skipReload) {
    if (!skipReload) {
        document.getElementById("orderDetailTitle").innerText = "Order #" + (order.orderNumber || order._id);
    }

    var customer = order.customer || {};
    var items = (order.items || []).map(function(item) {
        var img = adminProductImage({ name: item.name || item.productName, image: item.image });
        var thumb = img
            ? '<img class="order-item-thumb" src="' + img + '" alt="" onerror="this.style.display=\'none\'">'
            : '<span class="order-item-emoji">' + (item.emoji || "ðŸ¥¬") + '</span>';
        return '<tr><td>' + thumb + (item.name || item.productName || "Item") + '</td><td>' + (item.quantity || 1) + '</td><td>â‚¹' + (item.price || 0) + '</td><td><strong>â‚¹' + ((item.price || 0) * (item.quantity || 1)) + '</strong></td></tr>';
    }).join("");

    var statusOptions = ORDER_STATUSES.map(function(s) {
        return '<option value="' + s + '" ' + (s === order.status ? "selected" : "") + '>' + s + '</option>';
    }).join("");

    var razorpay = order.razorpay || {};
    var refund = order.refund || {};
    var payActions = "";
    if (order.paymentStatus === "PENDING" && order.paymentMode === "manual") {
        payActions = '<div><button class="row-btn verify" onclick="setOrderPayment(\'' + order._id + '\', \'PAID\')">âœ“ Verify Payment</button> ' +
            '<button class="row-btn reject" onclick="setOrderPayment(\'' + order._id + '\', \'FAILED\', \'Rejected by admin\')">âœ• Reject Payment</button></div>';
    }

    var timeline = (order.statusHistory || []).map(function(h) {
        return '<li><strong>' + (h.status || "â€”") + '</strong> <small>' + (h.at ? new Date(h.at).toLocaleString() : "") + (h.by ? " Â· " + h.by : "") + '</small></li>';
    }).join("");

    document.getElementById("orderDetailBody").innerHTML =
        '<div class="order-detail-block">' +
            '<h4>Customer</h4>' +
            '<p>' + (customer.name || order.name || "â€”") + '</p>' +
            '<p>ðŸ“ž ' + (customer.phone || order.phone || "â€”") + '</p>' +
            '<p>âœ‰ï¸ ' + (customer.email || order.email || (order.user && order.user.email) || "â€”") + '</p>' +
            '<p>ðŸ“ ' + ((customer.address || order.address || "") + (customer.city ? ", " + customer.city : "") + (customer.state ? ", " + customer.state : "") + (customer.pincode ? " - " + customer.pincode : "")) + '</p>' +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Payment</h4>' +
            payBadge(order) +
            '<p>Method: ' + (order.paymentMethod || order.payment || "â€”") + (order.paymentMode ? " (" + order.paymentMode + ")" : "") + '</p>' +
            (order.paymentReference ? '<p>UPI Ref: ' + order.paymentReference + '</p>' : "") +
            '<p>Order ID: ' + (order.trackingId || order.orderNumber || "â€”") + '</p>' +
            '<p>Razorpay Order: ' + (razorpay.orderId || "â€”") + '</p>' +
            '<p>Payment ID: ' + (razorpay.paymentId || "â€”") + '</p>' +
            (refund.id ? '<p>Refund: ' + refund.id + ' (â‚¹' + (refund.amount || order.total || 0) + ')</p>' : (refund.status ? '<p>Refund: ' + refund.status + (refund.reference ? " Â· " + refund.reference : "") + '</p>' : "")) +
            payActions +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Items</h4>' +
            '<table class="order-detail-table"><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>' + items + '</tbody></table>' +
        '</div>' +
        '<div class="order-detail-block">' +
            '<h4>Totals</h4>' +
            '<p>Subtotal: â‚¹' + (order.subtotal || 0) + '</p>' +
            '<p>Delivery: â‚¹' + (order.delivery || 0) + '</p>' +
            '<p class="order-detail-total">Total: â‚¹' + (order.total || 0) + '</p>' +
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

    // The configured low-stock threshold is needed before rendering (used server-side too).
    loadAdminSettings().then(function() {
        return fetchAdminProducts();
    })
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
    var catEl = document.getElementById("adminProductCategory");
    var cat = catEl ? catEl.value : "";
    var sortEl = document.getElementById("adminProductSort");
    var sort = sortEl ? sortEl.value : "default";
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
    if (cat) {
        filtered = filtered.filter(function(p) { return (p.category || "") === cat; });
    }
    if (sort === "price-asc") filtered = filtered.slice().sort(function(a, b) { return (a.price || 0) - (b.price || 0); });
    else if (sort === "price-desc") filtered = filtered.slice().sort(function(a, b) { return (b.price || 0) - (a.price || 0); });
    else if (sort === "stock-asc") filtered = filtered.slice().sort(function(a, b) { return (a.stock || 0) - (b.stock || 0); });
    else if (sort === "stock-desc") filtered = filtered.slice().sort(function(a, b) { return (b.stock || 0) - (a.stock || 0); });
    else if (sort === "name-asc") filtered = filtered.slice().sort(function(a, b) { return String(a.name || "").localeCompare(String(b.name || "")); });

    var totalStock = adminProducts.reduce(function(sum, p) { return sum + (p.stock || 0); }, 0);
    var lowThreshold = adminSettings.lowStockThreshold || 20;
    var lowStock = adminProducts.filter(function(p) { return (p.stock || 0) < lowThreshold; }).length;
    var activeCount = adminProducts.filter(function(p) { return p.active !== false; }).length;

    stats.innerHTML =
        '<div class="stat-box"><strong>' + adminProducts.length + '</strong><span>Total Products</span></div>' +
        '<div class="stat-box"><strong>' + activeCount + '</strong><span>Active</span></div>' +
        '<div class="stat-box"><strong>' + totalStock + '</strong><span>Total Stock</span></div>' +
        '<div class="stat-box low"><strong>' + lowStock + '</strong><span>Low Stock (&lt;' + lowThreshold + ')</span></div>';

    if (filtered.length === 0) {
        list.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:30px;">No products found.</p>';
        return;
    }

    var html = "";
    var lowThreshold = adminSettings.lowStockThreshold || 20;
    filtered.forEach(function(p) {
        var inactive = p.active === false;
        var low = (!inactive) && (p.stock || 0) < lowThreshold && (p.stock || 0) > 0;
        var out = (!inactive) && (p.stock || 0) <= 0;
        var img = adminProductImage(p);
        var imgHtml = img
            ? '<img class="admin-product-img" src="' + img + '" alt="' + (p.name || "") + '" onerror="this.style.display=\'none\'">'
            : '';
        var stockTag = out ? '<span class="stock-tag out">Out of Stock</span>'
            : low ? '<span class="stock-tag low" title="Below configured threshold (' + lowThreshold + ')">Low Stock</span>'
            : "";

        html += '<div class="admin-product-card' + (inactive ? " inactive" : "") + '">' +
            '<div class="admin-product-photo">' +
                imgHtml +
                '<div class="admin-product-emoji" style="background:' + (p.gradient || "linear-gradient(135deg,#56ab2f,#a8e063)") + ';">' +
                    (p.emoji || "ðŸ¥¬") +
                    (inactive ? '<span class="inactive-tag">Hidden</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="admin-product-info">' +
                '<div class="admin-product-name">' + (p.name || "Product") + ' ' + stockTag + '</div>' +
                '<div class="admin-product-meta">' + (p.category || "") + ' â€¢ â‚¹' + (p.price || 0) + ' / ' + (p.unit || "") + '</div>' +
                '<div class="admin-product-meta">â­ ' + (p.rating || 0).toFixed(1) + ' (' + (p.ratingCount || 0) + ' ratings)</div>' +
                '<div class="price-row">' +
                    '<span class="stock-label">Price: â‚¹<span id="priceVal_' + p._id + '">' + (p.price || 0) + '</span></span>' +
                    '<button class="row-btn edit" onclick="beginPriceEdit(\'' + p._id + '\')" title="Quick edit price">âœï¸ Price</button>' +
                '</div>' +
                '<div id="priceEdit_' + p._id + '" style="display:none;" class="price-edit-row">' +
                    '<input type="number" id="priceInput_' + p._id + '" class="stock-input" min="0" step="0.01" value="' + (p.price || 0) + '">' +
                    '<button class="row-btn verify" onclick="savePriceEdit(\'' + p._id + '\')">Save</button>' +
                    '<button class="row-btn" onclick="cancelPriceEdit(\'' + p._id + '\')">Cancel</button>' +
                '</div>' +
                '<div class="stock-row">' +
                    '<span class="stock-label' + (low || out ? " low" : "") + '">Stock: ' + (p.stock || 0) + '</span>' +
                    '<input type="number" class="stock-input" min="0" value="' + (p.stock || 0) + '" onchange="quickStock(\'' + p._id + '\', this.value)" title="Update stock">' +
                '</div>' +
            '</div>' +
            '<div class="admin-product-actions">' +
                '<button class="row-btn edit" onclick="openEditProduct(\'' + p._id + '\')" title="Edit">âœï¸</button>' +
                (inactive
                    ? '<button class="row-btn restore" onclick="restoreProduct(\'' + p._id + '\')" title="Restore">â†©ï¸</button>'
                    : '<button class="row-btn remove" onclick="removeProduct(\'' + p._id + '\')" title="Remove">ðŸ—‘ï¸</button>'
                ) +
            '</div>' +
        '</div>';
    });

    list.innerHTML = html;
}

// Inline price edit: show the editor row
function beginPriceEdit(productId) {
    var editor = document.getElementById("priceEdit_" + productId);
    if (editor) editor.style.display = "";
}

// Inline price edit: persist via validated PATCH /products/:id/price
function savePriceEdit(productId) {
    var input = document.getElementById("priceInput_" + productId);
    var editor = document.getElementById("priceEdit_" + productId);
    var price = parseFloat(input && input.value);
    if (isNaN(price) || price < 0 || !isFinite(price)) {
        showToast("Enter a valid positive price", "error");
        return;
    }
    apiUpdateProductPrice(productId, price)
        .then(function(updated) {
            var p = adminProducts.find(function(x) { return x._id === productId; });
            if (p) p.price = updated.price;
            var val = document.getElementById("priceVal_" + productId);
            if (val) val.textContent = updated.price;
            if (editor) editor.style.display = "none";
            showToast("Price updated to â‚¹" + updated.price, "success");
        })
        .catch(function(err) {
            showToast(err.message || "Failed to update price", "error");
        });
}

// Inline price edit: cancel
function cancelPriceEdit(productId) {
    var editor = document.getElementById("priceEdit_" + productId);
    if (editor) editor.style.display = "none";
}

function quickStock(productId, value) {
    var stock = parseInt(value, 10);
    if (isNaN(stock) || stock < 0) return;
    apiUpdateStock(productId, stock)
        .then(function() { showToast("Stock updated", "success"); })
        .catch(function(err) { showToast(err.message || "Failed", "error"); });
}

function removeProduct(productId) {
    if (!confirm("Remove this product from the store? (It becomes hidden â€” nothing is deleted from MongoDB.)")) return;
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
    document.getElementById("pfEmoji").value = "ðŸ¥¬";
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

// Clean inline icons for the Registered Customers UI (ASCII-only SVG, no emoji)
var _icOrders = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" focusable="false" aria-hidden="true"><path d="M19 3h-4.18C14.4 1.84 13.3 1 12 1s-2.4.84-2.82 2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 0c.55 0 1 .45 1 1s-.45 1-1 1-1-.45-1-1 .45-1 1-1zm2 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/></svg>';
var _icEye = '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" focusable="false" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
var _icUsers = '<svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor" focusable="false" aria-hidden="true"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>';
var _icBox = '<svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor" focusable="false" aria-hidden="true"><path d="M20 8h-3V4H3c-1.1 0-2 .9-2 2v11h2c0 1.66 1.34 3 3 3s3-1.34 3-3h6c0 1.66 1.34 3 3 3s3-1.34 3-3h2v-5l-3-4zM6 18.5c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm13.5-9l1.96 2.5H17V9.5h2.5zm-1.5 9c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5z"/></svg>';
var _icWarn = '<svg viewBox="0 0 24 24" width="56" height="56" fill="currentColor" focusable="false" aria-hidden="true"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>';

function esc(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

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
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">' + _icUsers + '</div><h3>No customers yet</h3><p>Registered users will appear here.</p></div>';
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
        var orderCount = (u.orderCount !== undefined) ? u.orderCount : "N/A";
        var viewBtn = '<button type="button" class="row-btn edit" onclick="openCustomerOrders(\'' + u._id + '\')" title="View customer order history">' + _icOrders + ' Orders</button>';
        return '<div class="admin-customer-row">' +
            '<div class="admin-customer-main">' +
                '<div class="admin-customer-title"><strong>' + esc(u.name || "N/A") + '</strong>' + roleBadge + '</div>' +
                '<div class="admin-customer-contact">' +
                    '<span class="email">' + esc(u.email) + '</span>' +
                    (u.phone ? '<span class="admin-cust-sep"></span><span class="phone">' + esc(u.phone) + '</span>' : '') +
                '</div>' +
                '<div class="admin-customer-orders">Orders placed: ' + orderCount + '</div>' +
                '<div class="admin-customer-action">' + viewBtn + '</div>' +
            '</div>' +
            '<div class="admin-customer-date">' + joined + '</div>' +
        '</div>';
    }).join("");

    container.innerHTML = '<div class="admin-customer-list">' + rows + '</div>';
}

// ===============================
// CUSTOMER ORDER HISTORY (admin)
// ===============================

// Open a modal listing every order a specific customer has placed
function openCustomerOrders(userId) {
    var modal = document.getElementById("customerOrdersModal");
    var body = document.getElementById("customerOrdersBody");
    var c = adminCustomers.find(function(u) { return u._id === userId; });
    document.getElementById("customerOrdersTitle").innerText = "Orders for " + ((c && c.name) || "Customer");
    if (modal) modal.style.display = "flex";
    if (body) body.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:30px;">Loading orders...</p>';
    fetchAdminCustomerOrders(userId)
        .then(function(res) {
            var orders = res.data || [];
            if (!orders.length) {
                body.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">' + _icBox + '</div><h3>No orders yet</h3><p>This customer has not placed any orders.</p></div>';
                return;
            }
            var rows = orders.map(function(o) {
                var items = (o.items || []).map(function(it) {
                    return '<span>' + esc(it.name || "Item") + ' &times; ' + (it.quantity || 1) + ' &mdash; &#8377;' + ((it.price || 0) * (it.quantity || 1)) + '</span>';
                }).join("");
                var statusColor = "#27ae60";
                if (o.status === "Cancelled") statusColor = "#e74c3c";
                else if (["Preparing", "Out for Delivery", "Confirmed"].indexOf(o.status) !== -1) statusColor = "#f39c12";
                return '<div class="admin-order-card">' +
                    '<div class="admin-order-head">' +
                        '<div><strong>#' + esc(o.orderNumber || o._id || "N/A") + '</strong>' +
                        '<span class="admin-order-date">' + orderDate(o) + '</span></div>' +
                        '<span class="order-status-badge" style="background:' + statusColor + ';">' + esc(o.status || "Placed") + '</span>' +
                    '</div>' +
                    payBadge(o) +
                    '<div class="admin-order-items">' + items + '</div>' +
                    '<div class="admin-order-foot">' +
                        '<div class="admin-order-total">Total: <strong>&#8377;' + (o.total || 0) + '</strong></div>' +
                        '<div class="admin-order-actions">' +
                            '<button type="button" class="row-btn edit" onclick="viewCustomerOrderDetails(\'' + o._id + '\')" title="View details">' + _icEye + ' View</button>' +
                        '</div>' +
                    '</div>' +
                '</div>';
            }).join("");
            body.innerHTML = rows;
        })
        .catch(function(err) {
            body.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">' + _icWarn + '</div><h3>Failed to load</h3><p>' +
                esc(err.message) + '</p></div>';
        });
}

function closeCustomerOrders() {
    document.getElementById("customerOrdersModal").style.display = "none";
}

// View a single order's full detail from the customer history modal
function viewCustomerOrderDetails(orderId) {
    apiGetOrder(orderId)
        .then(function(order) {
            showOrderDetail(order);
        })
        .catch(function(err) {
            showToast(err.message || "Failed to load order", "error");
        });
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
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">â­</div><h3>No reviews yet</h3><p>Customer reviews will appear here.</p></div>';
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
                    '<span class="admin-review-rating">' + (typeof starHTML === "function" ? starHTML(rev.rating) : ("â˜…".repeat(rev.rating) + "â˜…".repeat(5 - rev.rating))) + '</span>' +
                    '<button class="row-btn remove" onclick="deleteReview(\'' + rev._id + '\', \'' + String(rev.productName || "").replace(/'/g, "") + '\')" title="Delete review">ðŸ—‘ï¸</button>' +
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
            switchTab("dashboard");
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

// ===============================
// SETTINGS TAB (delivery + low-stock config)
// ===============================

function renderSettingsTab() {
    var section = document.getElementById("adminSettingsBody");
    if (!section) return;

    loadAdminSettings().then(function(s) {
        var badRange = (s.minimumOrderValue > 0 && s.freeDeliveryThreshold > 0 && s.freeDeliveryThreshold < s.minimumOrderValue);
        section.innerHTML =
            '<div class="settings-card">' +
                '<div class="settings-head"><h3>⚙️ Delivery Charge</h3><p>Customise what customers pay for delivery. The server enforces these amounts on every order — they are never taken from client-side values.</p></div>' +
                '<div class="settings-row">' +
                    '<label for="setDeliveryCharge">Delivery Charge (₹)</label>' +
                    '<input type="number" id="setDeliveryCharge" class="stock-input" min="0" step="1" value="' + s.deliveryCharge + '">' +
                '</div>' +
                '<div class="settings-row">' +
                    '<label for="setFreeThreshold">Free-Delivery Threshold (₹)</label>' +
                    '<input type="number" id="setFreeThreshold" class="stock-input" min="0" step="1" value="' + s.freeDeliveryThreshold + '">' +
                '</div>' +
                '<div class="settings-row">' +
                    '<label for="setMinOrder">Minimum Order Value (₹) — 0 = no minimum</label>' +
                    '<input type="number" id="setMinOrder" class="stock-input" min="0" step="1" value="' + s.minimumOrderValue + '">' +
                '</div>' +
                '<div class="settings-row">' +
                    '<label for="setLowStock">Low-Stock Warning Threshold (units)</label>' +
                    '<input type="number" id="setLowStock" class="stock-input" min="1" step="1" value="' + s.lowStockThreshold + '">' +
                '</div>' +
                (badRange ? '<p class="settings-hint warn">⚠️ The free-delivery threshold is below the minimum order value. With this combination every order becomes eligible for free delivery — make sure that is intentional.</p>' : '') +
                '<p class="settings-hint">Customers automatically get FREE delivery on orders at or above the threshold. Setting the charge to 0 disables delivery fees; setting the threshold to 0 always charges. The minimum order value blocks below-threshold checkouts entirely (0 keeps the store fully open).</p>' +
                '<button class="row-btn verify settings-save" onclick="saveAdminSettings()">💾 Save Settings</button>' +
                '<div class="settings-status" id="settingsStatus" style="display:none;"></div>' +
            '</div>';
    }).catch(function() {
        section.innerHTML = '<p style="color:#e74c3c;padding:30px;">Could not load settings. Are you logged in as admin?</p>';
    });
}

function saveAdminSettings() {
    var status = document.getElementById("settingsStatus");
    var deliveryCharge = parseFloat(document.getElementById("setDeliveryCharge").value);
    var freeThreshold = parseFloat(document.getElementById("setFreeThreshold").value);
    var minOrder = parseFloat(document.getElementById("setMinOrder").value);
    var lowStock = parseInt(document.getElementById("setLowStock").value, 10);

    if (isNaN(deliveryCharge) || deliveryCharge < 0) {
        showToast("Please enter a valid delivery charge.", "error");
        return;
    }
    if (isNaN(freeThreshold) || freeThreshold < 0) {
        showToast("Please enter a valid free-delivery threshold.", "error");
        return;
    }
    if (isNaN(minOrder) || minOrder < 0) {
        showToast("Minimum order value must be 0 or more.", "error");
        return;
    }
    if (isNaN(lowStock) || lowStock < 1) {
        showToast("Low-stock threshold must be at least 1.", "error");
        return;
    }
    if (typeof apiUpdateSettings !== "function") {
        showToast("Settings API unavailable.", "error");
        return;
    }
    if (minOrder > 0 && freeThreshold > 0 && freeThreshold < minOrder) {
        if (!window.confirm("The free-delivery threshold is below the minimum order value, so every order will ship FREE. Continue?")) return;
    }

    apiUpdateSettings({
        deliveryCharge: deliveryCharge,
        freeDeliveryThreshold: freeThreshold,
        minimumOrderValue: minOrder,
        lowStockThreshold: lowStock
    }).then(function(saved) {
        adminSettingsLoaded = false;
        loadAdminSettings().then(function() {
            if (status) {
                status.style.display = "block";
                status.className = "settings-status ok";
                status.innerHTML = "✅ Settings saved. Delivery fee ₹" + adminSettings.deliveryCharge + " (free above ₹" + adminSettings.freeDeliveryThreshold + "), minimum order ₹" + adminSettings.minimumOrderValue + ", low-stock warning at " + adminSettings.lowStockThreshold + " units.";
                setTimeout(function() { status.style.display = "none"; }, 6000);
            }
            showToast("Settings saved successfully.", "success");
        });
    }).catch(function(err) {
        showToast((err && err.message) ? err.message : "Could not save settings.", "error");
    });
}

// ===============================
// COUPONS TAB
// ===============================

function loadAdminCoupons() {
    var container = document.getElementById("adminCouponsBody");
    if (!container) return;
    container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">Loading coupons...</p>';
    if (typeof fetchAdminCoupons !== "function") {
        container.innerHTML = '<p style="color:#e74c3c;padding:30px;">Coupon API unavailable.</p>';
        return;
    }
    fetchAdminCoupons().then(function(list) {
        renderAdminCoupons(list);
    }).catch(function(err) {
        container.innerHTML = '<p style="color:#e74c3c;padding:30px;">' + (err.message || "Failed to load coupons") + '</p>';
    });
}

function renderAdminCoupons(list) {
    var container = document.getElementById("adminCouponsBody");
    if (!container) return;
    if (!list || list.length === 0) {
        container.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">🎟️</div><h3>No coupons yet</h3><p>Create a coupon to start offering discounts.</p></div>';
        return;
    }
    list.sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    var html = list.map(function(c) {
        var typeLabel = c.discountType === "percentage" ? c.discountValue + "% off" : "₹" + c.discountValue + " off";
        var minNote = c.minimumOrderValue > 0 ? "Min order ₹" + c.minimumOrderValue : "No min order";
        var usageLabel = c.usageLimit ? (c.usageCount + " / " + c.usageLimit + " used") : (c.usageCount + " used");
        var expired = c.expiryDate && new Date(c.expiryDate).getTime() < Date.now();
        var active = c.active && !expired;
        return '<div class="admin-coupon' + (active ? "" : " coupon-inactive") + '">' +
            '<div class="admin-coupon-main">' +
                '<div class="admin-coupon-code">' + dashEsc(c.code) + '</div>' +
                '<div class="admin-coupon-meta">' + typeLabel + ' • ' + minNote + ' • ' + usageLabel + ' • expires ' + new Date(c.expiryDate).toLocaleDateString() + '</div>' +
            '</div>' +
            '<div class="admin-coupon-badges">' +
                (active
                    ? '<span class="coupon-active-badge">Active</span>'
                    : ('<span class="coupon-expired-badge">' + (expired ? "Expired" : "Inactive") + '</span>')) +
            '</div>' +
            '<div class="admin-coupon-actions">' +
                '<button class="row-btn edit" onclick="toggleCoupon(\'' + c._id + '\', ' + (c.active ? 'false' : 'true') + ')" title="' + (c.active ? "Deactivate" : "Activate") + '">' + (c.active ? "⏸" : "▶") + '</button>' +
                '<button class="row-btn edit" onclick="openCouponModal(' + "'" + c._id + "'" + ')" title="Edit">✏️</button>' +
                '<button class="row-btn reject" onclick="deleteCoupon(\'' + c._id + '\')" title="Delete">🗑</button>' +
            '</div>' +
        '</div>';
    }).join("");
    container.innerHTML = html;
}

var adminCoupons = [];
function couponById(id) {
    return adminCoupons.find(function(c) { return String(c._id) === String(id); });
}

function openCouponModal(id) {
    var coupon = id ? couponById(id) : null;
    if (id && !coupon) return;
    if (typeof fetchAdminCoupons === "function" && id && !coupon) {
        fetchAdminCoupons().then(function(list) {
            adminCoupons = list;
            var found = couponById(id);
            if (found) fillCouponForm(found);
        });
        return;
    }
    adminCoupons = adminCoupons || [];
    fillCouponForm(coupon);
}

function fillCouponForm(coupon) {
    document.getElementById("cfId").value = coupon ? coupon._id : "";
    document.getElementById("cfCode").value = coupon ? coupon.code : "";
    document.getElementById("cfType").value = coupon ? coupon.discountType : "percentage";
    document.getElementById("cfValue").value = coupon ? coupon.discountValue : "";
    document.getElementById("cfMinOrder").value = coupon ? (coupon.minimumOrderValue || 0) : 0;
    var exp = document.getElementById("cfExpiry");
    if (coupon && coupon.expiryDate) {
        var d = new Date(coupon.expiryDate);
        exp.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    } else {
        exp.value = "";
    }
    document.getElementById("cfUsageLimit").value = coupon && coupon.usageLimit ? coupon.usageLimit : "";
    document.getElementById("cfActive").checked = coupon ? !!coupon.active : true;
    document.getElementById("couponModalTitle").textContent = coupon ? "Edit Coupon" : "New Coupon";
    document.getElementById("couponModal").style.display = "flex";
}

function closeCouponModal() {
    var el = document.getElementById("couponModal");
    if (el) el.style.display = "none";
}

function saveCoupon(event) {
    if (event) event.preventDefault();
    var id = document.getElementById("cfId").value;
    var payload = {
        code: document.getElementById("cfCode").value,
        discountType: document.getElementById("cfType").value,
        discountValue: parseFloat(document.getElementById("cfValue").value),
        minimumOrderValue: parseFloat(document.getElementById("cfMinOrder").value) || 0,
        expiryDate: document.getElementById("cfExpiry").value,
        usageLimit: document.getElementById("cfUsageLimit").value ? parseInt(document.getElementById("cfUsageLimit").value, 10) : null,
        active: document.getElementById("cfActive").checked
    };
    var fn = id && id.length ? apiUpdateCoupon(id, payload) : apiCreateCoupon(payload);
    fn.then(function() {
        closeCouponModal();
        showToast(id ? "Coupon updated." : "Coupon created.", "success");
        if (typeof fetchAdminCoupons === "function") fetchAdminCoupons().then(function(list) { adminCoupons = list; renderAdminCoupons(list); });
    }).catch(function(err) {
        showToast((err && err.message) ? err.message : "Failed to save coupon.", "error");
    });
}

function toggleCoupon(id, active) {
    apiUpdateCoupon(id, { active: active }).then(function(saved) {
        showToast("Coupon " + (active ? "activated" : "deactivated") + ".", "success");
        if (typeof fetchAdminCoupons === "function") fetchAdminCoupons().then(function(list) { adminCoupons = list; renderAdminCoupons(list); });
    }).catch(function(err) {
        showToast((err && err.message) ? err.message : "Could not update coupon.", "error");
    });
}

function deleteCoupon(id) {
    if (!window.confirm("Delete this coupon permanently?")) return;
    apiDeleteCoupon(id).then(function() {
        showToast("Coupon deleted.", "success");
        if (typeof fetchAdminCoupons === "function") fetchAdminCoupons().then(function(list) { adminCoupons = list; renderAdminCoupons(list); });
    }).catch(function(err) {
        showToast((err && err.message) ? err.message : "Could not delete coupon.", "error");
    });
}

document.addEventListener("DOMContentLoaded", initAdminPage);
