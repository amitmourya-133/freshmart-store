require('dotenv').config();
// AUD-01: account-seeding helpers must never open the production DB by accident.
require('./utils/dbGuard').assertSafeDbUri(process.env.MONGODB_URI, { purpose: 'setup_users' });

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection;

    const adminEmail = 'amitmourya822@gmail.com';
    const adminPw = 'Admin@' + Math.random().toString(36).slice(2, 8) + 'X1';
    const delEmail = 'delivery@freshmart.com';
    const delPw = 'Deliver@' + Math.random().toString(36).slice(2, 8) + 'X1';

    const adminHash = await bcrypt.hash(adminPw, 10);
    const delHash = await bcrypt.hash(delPw, 10);

    await db.collection('users').updateOne(
        { email: adminEmail },
        { $set: { password: adminHash, role: 'admin', name: 'Admin' } },
        { upsert: true }
    );

    await db.collection('users').updateOne(
        { email: delEmail },
        { $set: { password: delHash, role: 'delivery', name: 'Delivery Partner' } },
        { upsert: true }
    );

    console.log('ADMIN_EMAIL=' + adminEmail);
    console.log('ADMIN_PASSWORD=' + adminPw);
    console.log('DELIVERY_EMAIL=' + delEmail);
    console.log('DELIVERY_PASSWORD=' + delPw);

    const users = await db.collection('users').countDocuments();
    console.log('total_users=' + users);

    await mongoose.disconnect();
}

main().catch(err => { console.error(err.message); process.exit(1); });
