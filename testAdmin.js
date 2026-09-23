// ===============================
// Admin Panel Enhancement Tests (TEST A–E)
// Requires .env (MONGODB_URI, JWT_SECRET) and a running server on :5000
// ===============================

require("dotenv").config();
var http = require("http");
var jwt = require("jsonwebtoken");

var BASE = "http://127.0.0.1:5000";
var JWT_SECRET = process.env.JWT_SECRET;
var passed = 0, failed = 0, results = [];

function log(tag, msg) {
    var line = "[" + tag + "] " + msg;
    console.log(line);
    results.push(line);
    if (tag === "PASS") passed++;
    if (tag === "FAIL") failed++;
}

function req(method, path, body, token) {
    return new Promise(function(resolve, reject) {
        var url = BASE + path;
        var parsed = require("url").parse(url);
        var data = body ? JSON.stringify(body) : null;
        var opts = {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.path,
            method: method,
            headers: { "Content-Type": "application/json" }
        };
        if (token) opts.headers["Authorization"] = "Bearer " + token;
        if (data) opts.headers["Content-Length"] = Buffer.byteLength(data);
        var r = http.request(opts, function(res) {
            var chunks = [];
            res.on("data", function(c) { chunks.push(c); });
            res.on("end", function() {
                try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
                catch (e) { resolve({ status: res.statusCode, body: null }); }
            });
        });
        r.on("error", reject);
        if (data) r.write(data);
        r.end();
    });
}

function assert(cond, msg) {
    if (cond) log("PASS", msg);
    else log("FAIL", msg);
}

// ===============================

(async function main() {
    var mongoose = require("mongoose");
    var User = require("./models/User");
    var Product = require("./models/Product");
    var Order = require("./models/Order");

    try {
        // ----- DB snapshot & admin JWT mint -----
        await mongoose.connect(process.env.MONGODB_URI);
        var adminUser = await User.findOne({ email: "amitmourya822@gmail.com" }).lean();
        if (!adminUser) throw new Error("Admin user amitmourya822@gmail.com not found");
        var adminToken = jwt.sign({ id: adminUser._id }, JWT_SECRET, { expiresIn: "7d" });
        var productsBefore = await Product.countDocuments();
        var ordersBefore = await Order.countDocuments();

        console.log("------ PRE-FLIGHT ------");
        console.log("Products in DB: " + productsBefore);
        console.log("Orders in DB: " + ordersBefore);
        console.log("Admin user: " + adminUser._id);
        console.log("Admin token minted (not printed)");

        await mongoose.disconnect();

        // ===================== TEST A: Customer signup + order =====================
        console.log("\n------ TEST A: Customer Order Flow ------");
        var ts = Date.now();
        var testEmail = "freshmart_test_" + ts + "@test.store";
        var testPass = "TestPass123!";
        var testPhone = "9" + String(ts).slice(-9);

        // A1: signup
        var signupRes = await req("POST", "/api/users/signup", {
            name: "Admin Test Customer",
            email: testEmail,
            phone: testPhone,
            password: testPass
        });
        assert(signupRes.status === 201 && signupRes.body && signupRes.body.success,
            "A1 - Signup creates customer: status " + signupRes.status);

        // A2: login (token explicitly requested for the API client)
        var loginRes = await req("POST", "/api/users/login?token=1", {
            email: testEmail,
            password: testPass
        });
        assert(loginRes.status === 200 && loginRes.body && loginRes.body.token,
            "A2 - Login returns token: status " + loginRes.status);
        var custToken = loginRes.body && loginRes.body.token;
        var custUser = loginRes.body && loginRes.body.data;

        // A3: customer sees empty order history
        var myOrdersRes = await req("GET", "/api/orders/my", null, custToken);
        assert(myOrdersRes.status === 200 && myOrdersRes.body && myOrdersRes.body.count === 0,
            "A3 - Customer starts with 0 orders: count=" + (myOrdersRes.body && myOrdersRes.body.count));

        // A4: products load (≥1)
        var prodsRes = await req("GET", "/api/products");
        assert(prodsRes.status === 200 && prodsRes.body && prodsRes.body.count > 0,
            "A4 - Public products load: count=" + (prodsRes.body && prodsRes.body.count));
        var prodList = (prodsRes.body && prodsRes.body.data) || [];
        if (!prodList.length) throw new Error("No products to order");

        // A5: place order (product[0], qty=2)
        var chosen = prodList[0];
        var qty = 2;
        var placeRes = await req("POST", "/api/orders", {
            items: [{ productId: chosen._id, quantity: qty }],
            customer: { name: "Admin Test Customer", phone: testPhone, address: "Test Lane 1", city: "Delhi", state: "Delhi", pincode: "110001" },
            paymentMethod: "cod"
        }, custToken);
        assert(placeRes.status === 201 && placeRes.body && placeRes.body.success,
            "A5 - Order placed: status=" + placeRes.status + " orderNo=" + ((placeRes.body && placeRes.body.data && placeRes.body.data.orderNumber) || "N/A"));
        var testOrder = placeRes.body && placeRes.body.data;

        // A6: order persisted in /orders/my
        var myOrders2 = await req("GET", "/api/orders/my", null, custToken);
        assert(myOrders2.status === 200 && myOrders2.body && myOrders2.body.count === 1,
            "A6 - Customer sees 1 order in /orders/my: count=" + (myOrders2.body && myOrders2.body.count));
        var myOrder = (myOrders2.body && myOrders2.body.data && myOrders2.body.data[0]) || testOrder;
        assert(myOrder && myOrder.items && myOrder.items.length > 0, "A6b - Order has items");
        assert(myOrder && myOrder.total > 0, "A6c - Order has total > 0: ₹" + (myOrder && myOrder.total));

        // ===================== TEST B: Admin order verification =====================
        console.log("\n------ TEST B: Admin Order View + Status Update ------");
        // B1: admin order list contains the test order
        var adminOrders = await req("GET", "/api/orders", null, adminToken);
        assert(adminOrders.status === 200 && adminOrders.body && adminOrders.body.success,
            "B1 - Admin order list loads: count=" + (adminOrders.body && adminOrders.body.count));
        var found = (adminOrders.body && adminOrders.body.data || []).find(function(o) { return o._id === testOrder._id; });
        assert(!!found, "B2 - Test order found in admin list: orderNo=" + (testOrder.orderNumber || "N/A"));

        // B3: admin order detail has populated user (email), historical price, subtotal
        if (testOrder && testOrder._id) {
            var detail = await req("GET", "/api/orders/" + testOrder._id, null, adminToken);
            assert(detail.status === 200 && detail.body && detail.body.success,
                "B3 - Admin order detail loads: status=" + detail.status);
            var od = detail.body && detail.body.data;
            assert(od && od.items && od.items[0] && od.items[0].price > 0,
                "B3b - Item has historical price: ₹" + (od && od.items && od.items[0] && od.items[0].price));
            assert(od && od.total > 0, "B3c - Order total persisted: ₹" + (od && od.total));
            // user populated?
            var userEmail = od && od.user && od.user.email;
            assert(!!userEmail, "B3d - Customer email populated: " + (userEmail || "N/A"));
        }

        // B4: update status to Confirmed
        var statusRes = await req("PATCH", "/api/orders/" + testOrder._id + "/status",
            { status: "Confirmed" }, adminToken);
        assert(statusRes.status === 200 && statusRes.body && statusRes.body.success,
            "B4 - Status updated to Confirmed: status=" + statusRes.status);

        // B5: customer sees updated status
        var myOrders3 = await req("GET", "/api/orders/my", null, custToken);
        var updatedOrder = myOrders3.body && myOrders3.body.data && myOrders3.body.data[0];
        assert(updatedOrder && updatedOrder.status === "Confirmed",
            "B5 - Customer sees status=Confirmed: " + (updatedOrder && updatedOrder.status));

        // B6: overview includes preparingOrders metric
        var overview = await req("GET", "/api/orders/admin/overview", null, adminToken);
        assert(overview.status === 200 && overview.body && overview.body.success,
            "B6 - Admin overview loads");
        var ov = overview.body && overview.body.data;
        assert(typeof (ov && ov.preparingOrders) === "number",
            "B6b - Overview has preparingOrders field: value=" + (ov && ov.preparingOrders));

        // B7: admin customer orders endpoint
        if (custUser && custUser._id) {
            var custOrders = await req("GET", "/api/users/admin/" + custUser._id + "/orders", null, adminToken);
            assert(custOrders.status === 200 && custOrders.body && custOrders.body.success,
                "B7 - Admin customer orders endpoint: count=" + (custOrders.body && custOrders.body.count));
        }

        // ===================== TEST C: Price change (up then down, restore) =====================
        console.log("\n------ TEST C: Price Management ------");
        if (prodList.length) {
            var priceProd = prodList[0];
            var origPrice = priceProd.price;

            // C1: price up
            var newPrice = Math.round((origPrice + 10) * 100) / 100;
            var upRes = await req("PATCH", "/api/products/" + priceProd._id + "/price",
                { price: newPrice }, adminToken);
            assert(upRes.status === 200 && upRes.body && upRes.body.success,
                "C1 - Price updated to ₹" + newPrice + ": status=" + upRes.status);

            // C2: verify persisted (admin)
            var chk = await req("GET", "/api/products/" + priceProd._id, null, adminToken);
            var updatedProdPrice = chk.body && chk.body.data && chk.body.data.price;
            assert(updatedProdPrice === newPrice,
                "C2 - Admin sees new price ₹" + updatedProdPrice + " (expected ₹" + newPrice + ")");

            // C3: customer catalog shows new price
            var pubProd = await req("GET", "/api/products/" + priceProd._id);
            var pubPrice = pubProd.body && pubProd.body.data && pubProd.body.data.price;
            assert(pubPrice === newPrice,
                "C3 - Customer catalog price ₹" + pubPrice + " (expected ₹" + newPrice + ")");

            // C4: price down to original-5
            var lowerPrice = Math.round((origPrice - 5) * 100) / 100;
            if (lowerPrice < 0) lowerPrice = 0;
            var downRes = await req("PATCH", "/api/products/" + priceProd._id + "/price",
                { price: lowerPrice }, adminToken);
            assert(downRes.status === 200 && downRes.body && downRes.body.success,
                "C4 - Price lowered to ₹" + lowerPrice + ": status=" + downRes.status);

            var chk2 = await req("GET", "/api/products/" + priceProd._id);
            assert((chk2.body && chk2.body.data && chk2.body.data.price) === lowerPrice,
                "C5 - Lowered price persisted: ₹" + (chk2.body && chk2.body.data && chk2.body.data.price));

            // C6: restore original
            var restoreRes = await req("PATCH", "/api/products/" + priceProd._id + "/price",
                { price: origPrice }, adminToken);
            assert(restoreRes.status === 200 && restoreRes.body && restoreRes.body.success,
                "C6 - Original price restored: ₹" + origPrice);
            var chk3 = await req("GET", "/api/products/" + priceProd._id);
            assert((chk3.body && chk3.body.data && chk3.body.data.price) === origPrice,
                "C7 - Restored price verified: ₹" + (chk3.body && chk3.body.data && chk3.body.data.price));
        }

        // ===================== TEST D: Security =====================
        console.log("\n------ TEST D: Security (no-token / wrong role) ------");
        // D1: no token
        var sec1 = await req("GET", "/api/orders");
        assert(sec1.status === 401, "D1 - No token -> 401 (got " + sec1.status + ")");

        // D2: no token on price endpoint
        var sec2 = await req("PATCH", "/api/products/" + (prodList[0] && prodList[0]._id) + "/price", { price: 999 });
        assert(sec2.status === 401, "D2 - No token PATCH price -> 401 (got " + sec2.status + ")");

        // D3: customer token on admin orders
        var sec3 = await req("GET", "/api/orders", null, custToken);
        assert(sec3.status === 403, "D3 - Customer token GET /orders -> 403 (got " + sec3.status + ")");

        // D4: customer token on PATCH price
        var sec4 = await req("PATCH", "/api/products/" + (prodList[0] && prodList[0]._id) + "/price",
            { price: 999 }, custToken);
        assert(sec4.status === 403, "D4 - Customer token PATCH price -> 403 (got " + sec4.status + ")");

        // D5: admin token on admin orders
        var sec5 = await req("GET", "/api/orders", null, adminToken);
        assert(sec5.status === 200, "D5 - Admin token GET /orders -> 200 (got " + sec5.status + ")");

        // D6: NaN price rejected by admin
        var sec6 = await req("PATCH", "/api/products/" + (prodList[0] && prodList[0]._id) + "/price",
            { price: "abc" }, adminToken);
        assert(sec6.status === 400, "D6 - NaN price rejected by admin -> 400 (got " + sec6.status + ")");

        // D7: negative price rejected
        var sec7 = await req("PATCH", "/api/products/" + (prodList[0] && prodList[0]._id) + "/price",
            { price: -5 }, adminToken);
        assert(sec7.status === 400, "D7 - Negative price rejected -> 400 (got " + sec7.status + ")");

        // ===================== TEST E: DB Integrity =====================
        console.log("\n------ TEST E: DB Integrity After Tests ------");
        await mongoose.connect(process.env.MONGODB_URI);
        var productsAfter = await Product.countDocuments();
        var ordersAfter = await Order.countDocuments();
        assert(productsAfter === productsBefore,
            "E1 - Product count preserved: " + productsBefore + " -> " + productsAfter);
        assert(ordersAfter === ordersBefore + 1,
            "E2 - Orders count increased by 1: " + ordersBefore + " -> " + ordersAfter + " (delta=" + (ordersAfter - ordersBefore) + ")");

        // Verify no product was permanently changed
        if (prodList.length) {
            var refProd = await Product.findById(prodList[0]._id).lean();
            assert(refProd && refProd.price === prodList[0].price,
                "E3 - Product[0] price unchanged: " + (refProd && refProd.price) + " (orig=" + prodList[0].price + ")");
        }
        await mongoose.disconnect();

        // ===================== SUMMARY =====================
        console.log("\n====== FINAL RESULTS ======");
        console.log("PASSED: " + passed);
        console.log("FAILED: " + failed);
        console.log("TOTAL:  " + (passed + failed));
        console.log("STATUS: " + (failed === 0 ? "ALL PASS" : "SOME FAILURES"));

    } catch (err) {
        console.error("FATAL ERROR: " + err.message);
        console.error(err.stack);
        failed++;
    } finally {
        try { await mongoose.disconnect(); } catch(e) {}
        process.exit(failed === 0 ? 0 : 1);
    }
})();
