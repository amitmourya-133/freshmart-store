// ===============================
// SEED ADMIN - Create / promote the first admin account (secure)
//
// USAGE (from project folder):
//   set ADMIN_EMAIL=you@example.com
//   set ADMIN_PASSWORD=YourStrongPassword
//   npm run seed:admin
//
// Security rules enforced:
//   - Credentials come ONLY from environment variables.
//   - There are NO default/hard-coded passwords here.
//   - The password is NEVER printed to the console or logs.
//   - Idempotent: if the user already exists it is promoted to admin;
//     otherwise a new admin account is created. No data is deleted.
// ===============================

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");

async function seedAdmin() {
    try {
        const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
        const password = process.env.ADMIN_PASSWORD || "";

        if (!email || !password) {
            console.error("❌ Missing credentials. Set ADMIN_EMAIL and ADMIN_PASSWORD environment variables first.");
            console.error('   Example:  set ADMIN_EMAIL=you@example.com');
            console.error('             set ADMIN_PASSWORD=YourStrongPassword');
            process.exit(1);
        }
        if (password.length < 8) {
            console.error("❌ ADMIN_PASSWORD must be at least 8 characters long.");
            process.exit(1);
        }

        const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/freshmart";
        await mongoose.connect(URI);
        console.log("✅ MongoDB connected");

        const user = await User.findOne({ email });
        if (user) {
            user.name = user.name || "Admin";
            user.role = "admin";
            user.isAdmin = true;
            user.password = password;
            await user.save();
            console.log("✅ Promoted existing user to admin: " + email);
        } else {
            await User.create({ name: "Admin", email, password, role: "admin", isAdmin: true });
            console.log("✅ Created admin account: " + email);
        }

        console.log("");
        console.log("🥬 FreshMart admin is ready.");
        console.log("   Admin panel: http://localhost:5000/admin.html");
        console.log("   (Log in with the email above and the password you set.)");
        console.log("");

        mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error("❌ Seed admin error:", error.message);
        process.exit(1);
    }
}

seedAdmin();