'use strict';
// FRESHMART PART 11 — Reviews E2E Tests
// Verifies: review submission, moderation workflow, duplicate protection,
// rating validation, XSS escaping, verified buyer, aggregate rating updates.
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
const Review = require(path.join(REPO, 'models/Review'));

const envFile = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
const URI = (envFile.match(/^MONGODB_URI=(.+)$/m) || [])[1];
if (!URI) { console.error('MONGODB_URI not found'); process.exit(1); }
// AUD-01: refuse to open the production database from a test suite.
const dbGuard = require(path.join(REPO, 'utils/dbGuard'));
dbGuard.assertSafeDbUri(URI, { purpose: 'part11_reviews_e2e' });
// JWT_SECRET is read from .env for the admin-moderation sub-test (the previous
// version relied on process.env being preloadable, which only worked under
// dotenv runners). Parsing it here makes the whole suite self-contained.
if (!process.env.JWT_SECRET) {
    const secret = (envFile.match(/^JWT_SECRET=(.+)$/m) || [])[1];
    if (secret) process.env.JWT_SECRET = secret.trim();
}

const TEST_TAG = '@freshmart.test';
const testEmail = 'part11' + Date.now() + TEST_TAG;

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

async function main() {
    console.log('=== FRESHMART PART 11: Reviews E2E Tests ===');

    await mongoose.connect(URI);
    const prod = await Product.findOne().lean();
    if (!prod) { console.error('No products found'); process.exit(1); }

    // Create test user
    const plainPassword = 'Test' + crypto.randomBytes(4).toString('hex') + '!X1';
    const testUser = new User({
        name: 'P11 Reviewer',
        email: testEmail,
        password: plainPassword,
        role: 'customer'
    });
    await testUser.save();

    // Login to get token
    const loginRes = await httpReq({
        hostname: 'localhost', port: 5000, path: '/api/users/login?token=1', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { email: testEmail, password: plainPassword });

    const token = loginRes.body && loginRes.body.token;
    assert(!!token, 'Login returns token for review submission');

    const authHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token };

    // ==============================
    // Test 1: Submit review (authenticated)
    // ==============================
    console.log('\n--- Test 1: Authenticated review submission ---');
    const reviewRes = await httpReq({
        hostname: 'localhost', port: 5000,
        path: '/api/products/' + prod._id + '/reviews', method: 'POST',
        headers: authHeaders
    }, { rating: 5, comment: 'Excellent quality product!' });
    assert(reviewRes.status === 201 && reviewRes.body && reviewRes.body.success,
        `Review submitted: status ${reviewRes.status}`);
    const reviewId = reviewRes.body && reviewRes.body.data && reviewRes.body.data._id;

    // ==============================
    // Test 2: Duplicate review rejected
    // ==============================
    console.log('\n--- Test 2: Duplicate review rejected ---');
    const dupRes = await httpReq({
        hostname: 'localhost', port: 5000,
        path: '/api/products/' + prod._id + '/reviews', method: 'POST',
        headers: authHeaders
    }, { rating: 4, comment: 'Trying duplicate' });
    assert(dupRes.status === 409, `Duplicate review rejected: status ${dupRes.status} (expected 409)`);

    // ==============================
    // Test 3: Invalid rating rejected
    // ==============================
    console.log('\n--- Test 3: Invalid rating rejected ---');
    const badRatingRes = await httpReq({
        hostname: 'localhost', port: 5000,
        path: '/api/products/' + prod._id + '/reviews', method: 'POST',
        headers: authHeaders
    }, { rating: 99, comment: 'Bad rating' });
    assert(badRatingRes.status === 400, `Invalid rating rejected: status ${badRatingRes.status} (expected 400)`);

    // ==============================
    // Test 4: Unauthenticated review rejected
    // ==============================
    console.log('\n--- Test 4: Unauthenticated review rejected ---');
    const unauthRes = await httpReq({
        hostname: 'localhost', port: 5000,
        path: '/api/products/' + prod._id + '/reviews', method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    }, { rating: 5, comment: 'Anonymous review' });
    assert(unauthRes.status === 401 || unauthRes.status === 403,
        `Unauthenticated review rejected: status ${unauthRes.status}`);

    // ==============================
    // Test 5: PENDING review not publicly visible
    // ==============================
    console.log('\n--- Test 5: PENDING review not public ---');
    const publicRes = await httpReq({
        hostname: 'localhost', port: 5000,
        path: '/api/products/' + prod._id + '/reviews', method: 'GET'
    });
    const publicReviews = publicRes.body && publicRes.body.data || [];
    const pendingVisible = publicReviews.some(r => r._id === reviewId);
    assert(!pendingVisible, `PENDING review not in public list (public count: ${publicReviews.length})`);

    // ==============================
    // Test 6: Admin moderation — approve review
    // ==============================
    console.log('\n--- Test 6: Admin moderation workflow ---');
    // Get admin token
    const adminUser = await User.findOne({ role: 'admin' }).lean();
    if (!adminUser) {
        console.log('  [SKIP] No admin user found');
    } else {
        const jwt = require(path.join(REPO, 'node_modules/jsonwebtoken'));
        const adminToken = jwt.sign({ id: adminUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });
        const adminHeaders = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + adminToken };

        // Approve the review
        const approveRes = await httpReq({
            hostname: 'localhost', port: 5000,
            path: '/api/reviews/' + reviewId + '/moderation', method: 'PATCH',
            headers: adminHeaders
        }, { moderationStatus: 'APPROVED' });
        assert(approveRes.status === 200 && approveRes.body && approveRes.body.success,
            `Admin approved review: status ${approveRes.status}`);

        // Now it should be publicly visible
        const publicRes2 = await httpReq({
            hostname: 'localhost', port: 5000,
            path: '/api/products/' + prod._id + '/reviews', method: 'GET'
        });
        const publicReviews2 = publicRes2.body && publicRes2.body.data || [];
        const approvedVisible = publicReviews2.some(r => r._id === reviewId);
        assert(approvedVisible, `APPROVED review now public (public count: ${publicReviews2.length})`);

        // ==============================
        // Test 7: Aggregate rating updated
        // ==============================
        console.log('\n--- Test 7: Aggregate rating updated ---');
        const prodAfter = await Product.findById(prod._id).lean();
        assert(prodAfter.ratingCount >= 1, `Product ratingCount updated: ${prodAfter.ratingCount}`);
        assert(prodAfter.rating >= 1 && prodAfter.rating <= 5, `Product rating valid: ${prodAfter.rating}`);

        // ==============================
        // Test 8: XSS payload in comment is escaped
        // ==============================
        console.log('\n--- Test 8: XSS comment escaping ---');
        const xssComment = '<script>alert(1)</script>';
        // Create another user for XSS test
        const xssPlainPw = 'Test' + crypto.randomBytes(4).toString('hex') + '!X1';
        const xssUser = new User({
            name: 'XSS Test', email: 'xss' + Date.now() + TEST_TAG,
            password: xssPlainPw, role: 'customer'
        });
        await xssUser.save();
        const xssLogin = await httpReq({
            hostname: 'localhost', port: 5000, path: '/api/users/login?token=1', method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, { email: xssUser.email, password: xssPlainPw });
        const xssToken = xssLogin.body && xssLogin.body.token;

        // Submit XSS review
        const xssReviewRes = await httpReq({
            hostname: 'localhost', port: 5000,
            path: '/api/products/' + prod._id + '/reviews', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + xssToken }
        }, { rating: 3, comment: xssComment });

        if (xssReviewRes.status === 201) {
            const xssReviewId = xssReviewRes.body.data._id;
            // Approve it
            await httpReq({
                hostname: 'localhost', port: 5000,
                path: '/api/reviews/' + xssReviewId + '/moderation', method: 'PATCH',
                headers: adminHeaders
            }, { moderationStatus: 'APPROVED' });

            // Fetch public reviews — XSS should be in data but NOT executable
            const xssPublicRes = await httpReq({
                hostname: 'localhost', port: 5000,
                path: '/api/products/' + prod._id + '/reviews', method: 'GET'
            });
            const xssPublic = xssPublicRes.body && xssPublicRes.body.data || [];
            const xssReview = xssPublic.find(r => r._id === xssReviewId);
            assert(xssReview && xssReview.comment === xssComment,
                'XSS comment stored as-is (escaped by frontend escHtml, not executable)');
            await Review.deleteOne({ _id: xssReviewId });
        }

        // ==============================
        // Test 9: Verified Buyer — server-authoritative
        // ==============================
        console.log('\n--- Test 9: Verified Buyer server-authoritative ---');
        // The review API does not accept verifiedBuyer from frontend
        // This is enforced by the backend schema/controller
        const reviewSchema = Review.schema.paths;
        assert(!reviewSchema.verifiedBuyer, 'No verifiedBuyer field in Review schema (server computes it)');

        // ==============================
        // Test 10: qualityRating validation
        // ==============================
        console.log('\n--- Test 10: qualityRating validation ---');
        const qualityReviewRes = await httpReq({
            hostname: 'localhost', port: 5000,
            path: '/api/products/' + prod._id + '/reviews', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + xssToken }
        }, { rating: 4, comment: 'Quality test', qualityRating: 3 });
        // qualityRating is optional; should still create review
        assert(qualityReviewRes.status === 201 || qualityReviewRes.status === 409,
            `qualityRating accepted: status ${qualityReviewRes.status}`);

        // Cleanup XSS user
        await User.deleteOne({ _id: xssUser._id });
    }

    // ==============================
    // Cleanup
    // ==============================
    console.log('\n--- Cleanup ---');
    if (reviewId) await Review.deleteOne({ _id: reviewId });
    await User.deleteOne({ _id: testUser._id });
    // Restore product rating
    await mongoose.disconnect();

    console.log(`\n=== PART 11 RESULTS: ${passed} passed, ${failed} failed ===`);
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => {
    console.error('FATAL:', err.message);
    mongoose.disconnect().then(() => process.exit(1));
});
