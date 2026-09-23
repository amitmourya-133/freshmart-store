// ===============================
// CART ROUTES (persistent DB cart)
// ===============================

const express = require("express");
const router = express.Router();
const {
    getCart,
    setCart,
    mergeCart,
    clearCart
} = require("../controllers/cartController");
const { protect } = require("../middleware/auth");
const { rateLimit } = require("../utils/rateLimit");

// Authenticated write limiter: caps cart churn without hurting normal use.
const cartActionLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });

// All cart routes require a logged-in user
router.get("/", protect, getCart);
router.put("/", protect, cartActionLimiter, setCart);
router.post("/merge", protect, cartActionLimiter, mergeCart);
router.delete("/", protect, cartActionLimiter, clearCart);

module.exports = router;