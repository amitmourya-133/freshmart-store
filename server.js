// ===============================
// FRESHMART - BACKEND SERVER (local development)
// Connects to MongoDB and starts the Express app defined in app.js.
// ===============================

require("dotenv").config();
const mongoose = require("mongoose");
const app = require("./app");
const { seedDefaultSubscriptionPlans } = require("./utils/seedSubscriptionPlans");

const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/freshmart";

async function startServer() {
    try {
        await mongoose.connect(MONGODB_URI);
        console.log("✅ MongoDB connected successfully");

        // Additive bootstrap: creates default subscription plans only when the
        // collection is completely empty (never overwrites existing plans).
        seedDefaultSubscriptionPlans().then(function (result) {
            if (result && result.seeded) {
                console.log(`✅ Seeded ${result.count} default subscription plan(s) (collection was empty)`);
            }
        }).catch(function () { /* non-fatal */ });

        app.listen(PORT, () => {
            console.log("======================================");
            console.log("🥬 FreshMart Backend Server");
            console.log("======================================");
            console.log(`✅ Server running on http://localhost:${PORT}`);
            console.log(`🛒 Store:  http://localhost:${PORT}/index.html`);
            console.log(`🛠️  Admin:  http://localhost:${PORT}/admin.html`);
            console.log(`📡 API:    http://localhost:${PORT}/api/health`);
            console.log("======================================");
        });
    } catch (error) {
        console.error("❌ MongoDB connection error:", error.message);
        console.error("");
        console.error("Please make sure MongoDB is running, OR");
        console.error("Set MONGODB_URI in the .env file to your MongoDB Atlas URI");
        console.error("");
        process.exit(1);
    }
}

startServer();