// ===============================
// FRESHMART - VERCEL SERVERLESS ENTRY
// Serves the whole FreshMart API from a single Vercel function.
// All requests to /api/* are rewritten here by vercel.json.
// The frontend HTML/CSS/JS/images are served statically by Vercel.
// ===============================

require("dotenv").config();
const mongoose = require("mongoose");
const app = require("../app");

// Cache the MongoDB connection across warm invocations.
// On Vercel the same lambda container may serve many requests, so we only
// connect once per container instead of once per request.
let cachedDb = null;

function connectToDb() {
    if (cachedDb) return cachedDb;
    cachedDb = mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/freshmart")
        .then(() => mongoose.connection)
        .catch((err) => {
            cachedDb = null;
            throw err;
        });
    return cachedDb;
}

module.exports = async (req, res) => {
    if (!process.env.MONGODB_URI) {
        return res.status(500).json({
            success: false,
            message: "MONGODB_URI is not set. Add it in the Vercel project environment variables."
        });
    }

    try {
        await connectToDb();
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: "Could not connect to MongoDB: " + error.message
        });
    }

    // Hand the request to the Express app.
    // Note: req/res are Node-style, which Express 4 accepts directly.
    return app(req, res);
};