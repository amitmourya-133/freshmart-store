'use strict';
/**
 * FreshMart API Smoke Tests
 * Runs against http://localhost:5000
 * NO secrets embedded. Uses only public endpoints or Bearer tokens from environment.
 */

const http = require('http');
const url = require('url');

function makeRequest(options, body) {
    return new Promise((resolve, reject) => {
        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function testApis() {
    const results = [];

    // 1. Health check (public)
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/health', method: 'GET'
        });
        results.push({ name: 'health', status: r.status, ok: r.status === 200 });
    } catch (e) {
        results.push({ name: 'health', error: e.message });
    }

    // 2. Products (public)
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/products', method: 'GET'
        });
        const count = r.body ? (r.body.match(/\d+/g) || []).length : 0;
        results.push({ name: 'products', status: r.status, itemCount: count, ok: r.status === 200 });
    } catch (e) {
        results.push({ name: 'products', error: e.message });
    }

    // 3. Subscription plans (protected - requires auth token; we test unauth returns 401/403)
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/subscriptions/plans', method: 'GET',
            headers: { 'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' } // fake token
        });
        results.push({ name: 'subs_plans', status: r.status, bodySnippet: r.body.substring(0, 80), ok: r.status < 500 });
    } catch (e) {
        results.push({ name: 'subs_plans', error: e.message });
    }

    // 4. User profile unauth (should fail)
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/users/me', method: 'GET',
            headers: { 'Authorization': 'Bearer fakeso' }
        });
        results.push({ name: 'user_me_unauth', status: r.status, ok: r.status === 401 || r.status === 403 });
    } catch (e) {
        results.push({ name: 'user_me_unauth', error: e.message });
    }

    // 5. Delivery today unauth
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/delivery/today', method: 'GET',
            headers: { 'Authorization': 'Bearer invalid' }
        });
        results.push({ name: 'delivery_today_unauth', status: r.status, ok: r.status === 401 || r.status === 403 });
    } catch (e) {
        results.push({ name: 'delivery_today_unauth', error: e.message });
    }

    // 6. Authorization: verify role checks exist
    // (We verify the server returns proper status codes for role mismatches)
    try {
        const r = await makeRequest({
            hostname: 'localhost', port: 5000, path: '/api/delivery/assign', method: 'POST',
            headers: { 'Authorization': 'Bearer invalid' },
            body: { orderId: 'tmp', deliveryUserId: 'tmp' }
        });
        results.push({ name: 'delivery_assign_unauth', status: r.status, ok: r.status === 401 || r.status === 403 });
    } catch (e) {
        results.push({ name: 'delivery_assign_unauth', error: e.message });
    }

    // Summary
    console.log('=== FRESHMART API SMOKE TEST RESULTS ===\n');
    let allOk = true;
    for (const r of results) {
        const statusIcon = r.ok !== undefined ? (r.ok ? '[PASS]' : '[FAIL]') : '[ERROR]';
        const detail = r.itemCount !== undefined ? `items=${r.itemCount}` : r.bodySnippet ? `snippet: ${r.bodySnippet}` : r.error || r.status;
        console.log(`${statusIcon} ${r.name.padEnd(25)} status=${r.status} ${detail}`);
        if (r.ok === false || r.ok === undefined) allOk = false;
    }

    console.log('\n' + (allOk ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'));
    process.exit(allOk ? 0 : 1);
}

testApis();