require('dotenv').config();
// AUD-01: any script that can open MongoDB must never connect to production by accident.
require('./utils/dbGuard').assertSafeDbUri(process.env.MONGODB_URI, { purpose: 'db_counts_check' });
const mongoose = require('mongoose');

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection;
    const collections = {
        users: 'User',
        orders: 'Order',
        products: 'Product',
        carts: 'Cart',
        reviews: 'Review',
        assignments: 'DeliveryAssignment',
        payments: 'Payment',
        subscriptions: 'Subscription',
        plans: 'SubscriptionPlan'
    };
    const counts = {};
    for (const [key, model] of Object.entries(collections)) {
        try {
            counts[key] = await db.collection(model).countDocuments();
        } catch (e) {
            counts[key] = 'ERROR: ' + e.message;
        }
    }
    console.log(JSON.stringify(counts, null, 2));
    await mongoose.disconnect();
}

main().catch(err => { console.error(err.message); process.exit(1); });
