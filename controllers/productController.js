// ===============================
// PRODUCT CONTROLLER
// ===============================

const Product = require("../models/Product");
const mongoose = require("mongoose");
const InventoryLog = require("../models/InventoryLog");
const { normalizeProductImage, parseImageDataUri } = require("../utils/productImage");
const { uploadImageBytes } = require("../utils/cloudinary");
const { normalizeVariants } = require("../utils/variants");

// Audit helper: record a stock movement (root or variant) and keep the trail
// queryable from the admin inventory panel.
async function logStockChange(entry) {
    try {
        await InventoryLog.create(entry);
    } catch (e) {
        // Logging must never break the business operation that triggered it.
        console.error("InventoryLog write failed:", e.message);
    }
}

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

// UPLOAD PRODUCT IMAGE TO CLOUDINARY (admin)
// The frontend sends the camera/file data URI; the server re-validates the
// actual bytes, uploads to Cloudinary and returns ONLY a secure delivery URL.
// The base64 payload itself is never stored in MongoDB.
exports.uploadImage = async (req, res) => {
    try {
        const parsed = parseImageDataUri(req.body && req.body.image);
        const imageUrl = await uploadImageBytes(parsed.buffer, parsed.type);
        res.json({ success: true, imageUrl });
    } catch (error) {
        const status = (error && error.status) || 502;
        let message = "Image upload failed. Please try again.";
        if (status === 400 || status === 503) message = error.message;
        res.status(status).json({ success: false, message });
    }
};

// CREATE PRODUCT (admin)
exports.createProduct = async (req, res) => {
    try {
        const body = Object.assign({}, req.body);
        if (body.price !== undefined) {
            const p = Number(body.price);
            if (typeof p !== "number" || isNaN(p) || !isFinite(p) || p < 0) {
                return res.status(400).json({ success: false, message: "Price must be a valid positive number" });
            }
            body.price = Math.round(p * 100) / 100;
        }
        if (body.stock !== undefined) {
            const s = Number(body.stock);
            if (typeof s !== "number" || isNaN(s) || !isFinite(s) || s < 0) {
                return res.status(400).json({ success: false, message: "Stock must be a valid positive number" });
            }
            body.stock = Math.floor(s);
        }
        if (body.variants !== undefined) {
            const { variants } = normalizeVariants(body.variants);
            body.variants = variants;
        }
        if (body.image !== undefined) body.image = normalizeProductImage(body.image);
        const product = await Product.create(body);
        // Audit the starting stock levels of any created variants.
        if (product.variants && product.variants.length) {
            for (const v of product.variants) {
                await logStockChange({
                    product: product._id, variantId: v._id, scope: "variant", change: v.stock,
                    previousStock: 0, newStock: v.stock, reason: "variant_created", changedByType: "admin", changedBy: req.user ? req.user._id : null, note: product.name
                });
            }
        }
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
        const updates = {};
        const allowed = ["name", "unit", "category", "emoji", "gradient", "description", "nutrition", "tips", "origin", "active", "rating", "ratingCount", "image", "variants"];
        allowed.forEach((k) => {
            if (req.body[k] !== undefined) updates[k] = req.body[k];
        });
        if (updates.image !== undefined) updates.image = normalizeProductImage(updates.image);
        if (req.body.price !== undefined) {
            const p = Number(req.body.price);
            if (typeof p !== "number" || isNaN(p) || !isFinite(p) || p < 0) {
                return res.status(400).json({ success: false, message: "Price must be a valid positive number" });
            }
            updates.price = Math.round(p * 100) / 100;
        }
        if (req.body.stock !== undefined) {
            const s = Number(req.body.stock);
            if (typeof s !== "number" || isNaN(s) || !isFinite(s) || s < 0) {
                return res.status(400).json({ success: false, message: "Stock must be a valid positive number" });
            }
            updates.stock = Math.floor(s);
        }
        let previousProduct = null;
        if (updates.variants !== undefined) {
            const { variants } = normalizeVariants(updates.variants);
            previousProduct = await Product.findById(req.params.id);
            if (!previousProduct) {
                return res.status(404).json({ success: false, message: "Product not found" });
            }
            updates.variants = variants;
        }
        const product = await Product.findByIdAndUpdate(req.params.id, updates, {
            new: true,
            runValidators: true
        });
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        // Audit variant stock deltas caused by this admin edit. New variants log
        // their full starting stock; changed ones log previous -> new.
        if (updates.variants && product.variants) {
            const beforeMap = new Map((previousProduct && previousProduct.variants || []).map(function (v) { return [String(v._id), v]; }));
            for (const v of product.variants) {
                const before = beforeMap.get(String(v._id));
                if (!before) {
                    await logStockChange({
                        product: product._id, variantId: v._id, scope: "variant", change: v.stock,
                        previousStock: 0, newStock: v.stock, reason: "variant_created", changedByType: "admin", changedBy: req.user ? req.user._id : null, note: product.name
                    });
                } else if (before.stock !== v.stock) {
                    const delta = v.stock - before.stock;
                    await logStockChange({
                        product: product._id, variantId: v._id, scope: "variant", change: delta,
                        previousStock: before.stock, newStock: v.stock, reason: "variant_updated", changedByType: "admin", changedBy: req.user ? req.user._id : null, note: product.name
                    });
                }
            }
        }
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// UPDATE PRICE ONLY (admin) - validated, up or down
exports.updatePrice = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const price = Number(req.body.price);
        if (req.body.price === undefined || typeof price !== "number" || isNaN(price) || !isFinite(price) || price < 0) {
            return res.status(400).json({ success: false, message: "Price must be a valid positive number" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        product.price = Math.round(price * 100) / 100;
        await product.save();
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
        const s = Number(stock);
        if (stock === undefined || s === undefined || isNaN(s) || !isFinite(s) || s < 0) {
            return res.status(400).json({ success: false, message: "Valid stock value required" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const previousStock = product.stock;
        product.stock = Math.floor(s);
        await product.save();
        if (product.stock !== previousStock) {
            await logStockChange({
                product: product._id, variantId: null, scope: "stock", change: product.stock - previousStock,
                previousStock: previousStock, newStock: product.stock, reason: "admin_update", changedByType: "admin", changedBy: req.user ? req.user._id : null, note: product.name
            });
        }
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
        const r = Number(rating);
        if (!Number.isFinite(r) || r < 1 || r > 5) {
            return res.status(400).json({ success: false, message: "Rating must be 1-5" });
        }
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        // Update running average
        const newCount = product.ratingCount + 1;
        product.rating = (product.rating * product.ratingCount + r) / newCount;
        product.ratingCount = newCount;
        await product.save();
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
