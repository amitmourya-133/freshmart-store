require('dotenv').config({ path: 'D:/vegetable store/.env' });
// AUD-01: account-seeding helpers must never open the production DB by accident.
require('./utils/dbGuard').assertSafeDbUri(process.env.MONGODB_URI, { purpose: 'create_users' });

const readline = require('readline');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(q) {
    return new Promise(resolve => rl.question(q, resolve));
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    const db = mongoose.connection;

    const adminEmail = (await ask('Admin email: ')).trim();
    const adminPw = (await ask('Admin password: ')).trim();
    const delEmail = (await ask('Delivery email: ')).trim();
    const delPw = (await ask('Delivery password: ')).trim();

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

    console.log('Admin created:', adminEmail);
    console.log('Delivery created:', delEmail);
    console.log('Total users:', await db.collection('users').countDocuments());

    rl.close();
    await mongoose.disconnect();
}

main().catch(err => { console.error(err.message); process.exit(1); });
