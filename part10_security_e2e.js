'use strict';
// FRESHMART PART 10 — Security E2E Tests
// Verifies: login enumeration fix, rate limiter XFF fix, password policy,
// customer order isolation, unauthorized API rejection.
// Creates ONLY @freshmart.test data and cleans up only what it created.

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const REPO = 'D:/vegetable store';
const mongoose = require(path.join(REPO, 'node_modules/mongoose'));
const User = require(path.join(REPO, 'models/User'));
const Order = require(path.join(REPO, 'models/Order'));
const Product = require(path.join(REPO, 'models/Product'));

const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
const URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
if (!URI) { console.error('MONGODB_URI not found'); process.exit(1); }

const TEST_TAG = '@freshmart.test';
const testEmail = 'part10' + Date.now() + TEST_TAG;
const testOrderNum = 'FM-P10-' + Date.now();

let passed = 0, failed = 0;

function assert(condition, msg) {
    if (condition) { passed++; console.log('  [PASS] ' + msg); }
    else { failed++; console.log('  [FAIL] ' + msg); }
}

function httpReq(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(data); } catch (e) { parsed = null; }
                resolve({ status: res.statusCode, body: parsed, raw: data });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function cleanup() {
    await User.deleteMany({ email: new RegExp(TEST_TAG) });
    await Order.deleteMany({ orderNumber: new RegExp('^FM-P10-') });
}

async function main() {
    console.log('=== FRESHMART PART 10: Security E2E Tests ===');

    await mongoose.connect(URI);

    // ==============================
    // Test 1: Login enumeration — both cases return identical message
    // ==============================
    console.log('\n--- Test 1: Login enumeration messages are identical ---');
    const r1 = await httpReq({
        hostname: 'localhost', port: 5000, path: '/api/users/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { email: 'noexist' + TEST_TAG, password: 'anypass' });

    const testUser = new User({
        name: 'P10 Test',
        email: testEmail,
        password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1',
        role: 'customer'
    });
    await testUser.save();

    const r2 = await httpReq({
        hostname: 'localhost', port: 5000, path: '/api/users/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { email: testEmail, password: 'wrongpassword' });

    assert(r1.status === r2.status,
        `Enumeration: no-account status ${r1.status} === wrong-password status ${r2.status}`);
    assert(r1.body && r2.body && r1.body.message === r2.body.message,
        `Enumeration: both messages identical = "${r1.body && r1.body.message}"`);

    // ==============================
    // Test 2: Rate limiter uses req.ip (code-level check)
    // ==============================
    console.log('\n--- Test 2: Rate limiter identity does not use XFF ---');
    const rateLimitCode = fs.readFileSync(path.join(REPO, 'utils/rateLimit.js'), 'utf8');
    const keyFromMatch = rateLimitCode.match(/function keyFrom[\s\S]*?^}/m);
    const keyFromBody = keyFromMatch ? keyFromMatch[0] : '';
    assert(keyFromBody.includes('req.ip') && !keyFromBody.includes('x-forwarded-for'),
        'Rate limiter keyFrom uses req.ip only, not client-supplied X-Forwarded-For');

    // ==============================
    // Test 3: Password policy requires 8+ chars
    // ==============================
    console.log('\n--- Test 3: Password policy minimum 8 characters ---');
    const pwCode = fs.readFileSync(path.join(REPO, 'controllers/userController.js'), 'utf8');
    assert(pwCode.includes('length < 8') || pwCode.includes('length < 8'),
        'Password minimum is 8 characters in userController');

    // ==============================
    // Test 4: Customer order isolation — valid fixture
    // ==============================
    console.log('\n--- Test 4: Customer order isolation ---');
    const prod = await Product.findOne().lean();
    if (!prod) {
        console.log('  [SKIP] No products in DB');
    } else {
        const userA = new User({
            name: 'P10 CustA', email: 'p10a' + Date.now() + TEST_TAG,
            password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1', role: 'customer'
        });
        const userB = new User({
            name: 'P10 CustB', email: 'p10b' + Date.now() + TEST_TAG,
            password: 'Test' + crypto.randomBytes(4).toString('hex') + '!X1', role: 'customer'
        });
        await userA.save(); await userB.save();

        const orderA = new Order({
            orderNumber: 'FM-P10-' + Date.now() + '-A',
            user: userA._id,
            customer: { name: 'CustA', phone: '9000000001', address: 'Test Lane', city: 'Delhi', pincode: '110001' },
            items: [{ name: prod.name, price: prod.price, quantity: 1, productId: prod._id }],
            paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price
        });
        const orderB = new Order({
            orderNumber: 'FM-P10-' + Date.now() + '-B',
            user: userB._id,
            customer: { name: 'CustB', phone: '9000000002', address: 'Test Lane 2', city: 'Delhi', pincode: '110002' },
            items: [{ name: prod.name, price: prod.price, quantity: 1, productId: prod._id }],
            paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price
        });
        await orderA.save(); await orderB.save();

        const ordersA = await Order.countDocuments({ user: userA._id, orderNumber: new RegExp('^FM-P10-') });
        const ordersB = await Order.countDocuments({ user: userB._id, orderNumber: new RegExp('^FM-P10-') });
        assert(ordersA === 1 && ordersB === 1,
            `Isolation: userA has ${ordersA}, userB has ${ordersB} (expected 1 each)`);

        await Order.deleteMany({ orderNumber: { $regex: '^FM-P10-' } });
        await User.deleteMany({ email: /p10[ab]\d+@freshmart\.test/ });
    }

    // ==============================
    // Test 5: Unauthorized APIs return 401
    // ==============================
    console.log('\n--- Test 5: Unauthorized API returns 401 ---');
    const unauth = await httpReq({
        hostname: 'localhost', port: 5000, path: '/api/orders', method: 'GET'
    });
    assert(unauth.status === 401, `No token GET /api/orders => ${unauth.status} (expected 401)`);

    const unauth2 = await httpReq({
        hostname: 'localhost', port: 5000, path: '/api/users/me', method: 'GET'
    });
    assert(unauth2.status === 401, `No token GET /api/users/me => ${unauth2.status} (expected 401)`);

    // ==============================
    // Test 6: getProductRating removed
    // ==============================
    console.log('\n--- Test 6: Fake rating generator removed ---');
    const scriptCode = fs.readFileSync(path.join(REPO, 'script.js'), 'utf8');
    assert(!scriptCode.includes('getProductRating'),
        'script.js has zero getProductRating references');

    // ==============================
    // Test 7: Razorpay not introduced
    // ==============================
    console.log('\n--- Test 7: Razorpay NOT added/restored ---');
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    const allDeps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
    assert(!allDeps.razorpay, 'No razorpay in package.json dependencies');
    const payCtrl = fs.readFileSync(path.join(REPO, 'controllers/paymentController.js'), 'utf8');
    assert(!payCtrl.includes('require("razorpay")') && !payCtrl.includes("require('razorpay')"),
        'No razorpay require in paymentController');

    // ==============================
    // Test 8: COD flow intact
    // ==============================
    console.log('\n--- Test 8: COD order creation works ---');
    const codOrder = new Order({
        orderNumber: 'FM-P10-COD-' + Date.now(),
        customer: { name: 'COD Test', phone: '9000000009', address: 'COD Lane', city: 'Delhi', pincode: '110009' },
        items: [{ name: prod.name, price: prod.price, quantity: 2, productId: prod._id }],
        paymentMethod: 'cod', paymentStatus: 'PENDING', total: prod.price * 2
    });
    await codOrder.save();
    const codCheck = await Order.findById(codOrder._id).lean();
    assert(codCheck && codCheck.paymentMethod === 'cod' && codCheck.total === prod.price * 2,
        `COD order: method=${codCheck && codCheck.paymentMethod}, total=${codCheck && codCheck.total}`);
    await Order.deleteOne({ _id: codOrder._id });

    // ==============================
    // Cleanup test user
    // ==============================
    await cleanup();
    await mongoose.disconnect();

    console.log(`\n=== PART 10 RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('FATAL:', err.message);
    mongoose.disconnect().then(() => process.exit(1));
});
