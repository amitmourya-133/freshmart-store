// ===============================
// PRODUCT CONTROLLER
// ===============================

const Product = require("../models/Product");
const mongoose = require("mongoose");

function isBadObjectId(id) {
    return !mongoose.Types.ObjectId.isValid(String(id || ""));
}

// GET ALL PRODUCTS (public, only active)
exports.getProducts = async (req, res) => {
    try {
        const { category, search } = req.query;
        let filter = { active: true };

        if (category && category !== "All") {
            filter.category = category;
        }

        if (search) {
            filter.name = { $regex: search, $options: "i" };
        }

        const products = await Product.find(filter).sort({ category: 1, createdAt: -1 });
        res.json({ success: true, count: products.length, data: products });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET SINGLE PRODUCT
exports.getProduct = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET ALL PRODUCTS INCLUDING INACTIVE (admin)
exports.getAdminProducts = async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        res.json({ success: true, count: products.length, data: products });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// CREATE PRODUCT (admin)
exports.createProduct = async (req, res) => {
    try {
        const product = await Product.create(req.body);
        res.status(201).json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// UPDATE PRODUCT (admin)
exports.updateProduct = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const product = await Product.findByIdAndUpdate(req.params.id, req.body, {
            new: true,
            runValidators: true
        });
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// UPDATE STOCK ONLY (admin)
exports.updateStock = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const { stock } = req.body;
        if (stock === undefined || stock < 0) {
            return res.status(400).json({ success: false, message: "Valid stock value required" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        product.stock = stock;
        await product.save();
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// DELETE PRODUCT (admin)
exports.deleteProduct = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        // Soft delete - mark inactive
        product.active = false;
        await product.save();
        res.json({ success: true, message: "Product removed" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// SET RATING (admin) - set the displayed rating / count directly
exports.setRating = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const { rating, ratingCount } = req.body;
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        if (rating !== undefined) {
            const r = Number(rating);
            if (isNaN(r) || r < 0 || r > 5) {
                return res.status(400).json({ success: false, message: "Rating must be 0-5" });
            }
            product.rating = r;
        }
        if (ratingCount !== undefined) {
            const c = Number(ratingCount);
            if (isNaN(c) || c < 0) {
                return res.status(400).json({ success: false, message: "Rating count must be >= 0" });
            }
            product.ratingCount = c;
        }
        await product.save();
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// ADD RATING
exports.addRating = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const { rating } = req.body;
        if (rating < 1 || rating > 5) {
            return res.status(400).json({ success: false, message: "Rating must be 1-5" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        // Update running average
        const newCount = product.ratingCount + 1;
        product.rating = (product.rating * product.ratingCount + rating) / newCount;
        product.ratingCount = newCount;
        await product.save();
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
