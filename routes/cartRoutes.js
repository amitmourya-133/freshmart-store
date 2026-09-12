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

// All cart routes require a logged-in user
router.get("/", protect, getCart);
router.put("/", protect, setCart);
router.post("/merge", protect, mergeCart);
router.delete("/", protect, clearCart);

module.exports = router;