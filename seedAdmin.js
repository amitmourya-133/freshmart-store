// ===============================
// SEED ADMIN - Create default admin account
// ===============================

require("dotenv").config();
const mongoose = require("mongoose");
const User = require("./models/User");

async function seedAdmin() {
    try {
        const URI = process.env.MONGODB_URI || "mongodb://localhost:27017/freshmart";
        await mongoose.connect(URI);
        console.log("✅ MongoDB connected");

        const email = process.env.ADMIN_EMAIL || "admin@freshmart.com";
        const password = process.env.ADMIN_PASSWORD || "admin123";
        const name = "FreshMart Admin";

        let user = await User.findOne({ email });
        if (user) {
            user.role = "admin";
            user.isAdmin = true;
            user.password = password;
            await user.save();
            console.log("✅ Updated existing admin: " + email);
        } else {
            await User.create({ name, email, password, role: "admin", isAdmin: true });
            console.log("✅ Created admin: " + email);
        }

        console.log("");
        console.log("=====================================");
        console.log("🥬 FRESHMART ADMIN LOGIN");
        console.log("=====================================");
        console.log("Email:    " + email);
        console.log("Password: " + password);
        console.log("Panel:    http://localhost:5000/admin.html");
        console.log("=====================================");

        mongoose.disconnect();
        process.exit(0);
    } catch (error) {
        console.error("❌ Seed admin error:", error.message);
        process.exit(1);
    }
}

seedAdmin();
