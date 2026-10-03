// ===============================
// PRODUCT CONTROLLER
// ===============================

const Product = require("../models/Product");
const Order = require("../models/Order");
const mongoose = require("mongoose");
const InventoryLog = require("../models/InventoryLog");
const { normalizeProductImage, parseImageDataUri } = require("../utils/productImage");
const { uploadImageBytes } = require("../utils/cloudinary");
const { normalizeVariants } = require("../utils/variants");
const searchUtils = require("../utils/search");
const { safeErrorMessage } = require("../utils/safeError");
const aiProvider = require("../utils/aiProvider");

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

// A product is "available" when its root stock > 0 OR any of its pack variants
// has stock > 0. Back-in-stock watchers are notified only on the true
// OUT_OF_STOCK -> IN_STOCK transition.
function productAvailable(p) {
    if (p && typeof p.stock === "number" && p.stock > 0) return true;
    if (p && Array.isArray(p.variants) && p.variants.some(function (v) { return Number(v && v.stock) > 0; })) return true;
    return false;
}

// Fire-and-forget restock notifications at the stock write sites.
function maybeNotifyRestock(product, wasAvailable) {
    if (wasAvailable) return;
    if (!productAvailable(product)) return;
    try {
        require("../utils/stockAlert").notifyBackInStock(product);
    } catch (e) { /* non-fatal */ }
}

// ===============================
// SEARCH SUGGESTIONS (public, rate-limited)
// Real autocomplete data straight from the product catalog: partial product
// names and matching categories. Only public catalog fields are returned.
// ===============================
exports.getSuggestions = async (req, res) => {
    try {
        if (!req.query.q || String(req.query.q).trim() === "") {
            // Blank query: nothing typed yet -> empty list (frontend never sends
            // these; avoids a wasted suggestion query per keystroke boundary).
            return res.json({ success: true, count: 0, suggestions: [] });
        }
        const v = searchUtils.validateSearchQuery(req.query.q, searchUtils.MAX_SUGGEST_QUERY_LENGTH);
        if (!v.ok) {
            // Overlong/sanitized-empty queries are simply rejected.
            return res.status(400).json({ success: false, message: v.message });
        }
        const q = v.value;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 10);

        const re = searchUtils.nameRegexFor(q);
        const [products, cats] = await Promise.all([
            Product.find({ active: true, stock: { $gt: 0 }, name: { $regex: re, $options: "i" } })
                .select("name price unit category emoji")
                .limit(limit * 2)
                .lean(),
            searchUtils.getCategories()
        ]);

        const lowerQ = q.toLowerCase();
        const productItems = products.map(function (p) {
            return {
                type: "product",
                _id: String(p._id),
                name: p.name,
                price: p.price,
                unit: p.unit,
                category: p.category,
                emoji: p.emoji
            };
        });
        // Prefix matches first, then alphabetical.
        productItems.sort(function (a, b) {
            const aPrefix = a.name.toLowerCase().indexOf(lowerQ) === 0 ? 0 : 1;
            const bPrefix = b.name.toLowerCase().indexOf(lowerQ) === 0 ? 0 : 1;
            return (aPrefix - bPrefix) || a.name.localeCompare(b.name);
        });

        const categoryItems = cats
            .filter(function (c) { return c.name.toLowerCase().indexOf(lowerQ) !== -1; })
            .map(function (c) { return { type: "category", name: c.name, count: c.count }; });

        const exactCategory = categoryItems.find(function (c) { return c.name.toLowerCase() === lowerQ; });

        const combined = [];
        if (exactCategory) combined.push(exactCategory);
        productItems.forEach(function (it) { if (combined.length < limit) combined.push(it); });
        categoryItems.forEach(function (it) {
            if (combined.length < limit && combined.indexOf(it) === -1) combined.push(it);
        });

        res.json({ success: true, count: combined.length, suggestions: combined });
    } catch (error) {
        res.status(500).json({ success: false, message: "Suggestion search failed" });
    }
};

// ===============================
// AI SEARCH (public, rate-limited)
// Frontend -> backend -> (optional) AI provider -> backend re-validates names
// -> results come ONLY from the FreshMart database. With no provider key the
// same endpoint answers deterministically from the real catalog.
// The AI can never invent products or touch private data: it only picks names
// from a server-side catalog list, and every name is re-validated here.
// ===============================
exports.aiSearch = async (req, res) => {
    try {
        const v = searchUtils.validateSearchQuery(
            req.body && req.body.query,
            searchUtils.MAX_AI_QUERY_LENGTH
        );
        if (!v.ok) {
            return res.status(400).json({ success: false, message: v.message });
        }
        const query = v.value;
        const limit = Math.min(Math.max(parseInt((req.body && req.body.limit), 10) || 8, 1), 12);

        if (aiProvider.isConfigured()) {
            const catalog = await Product.find({ active: true, stock: { $gt: 0 } })
                .select("name")
                .limit(300)
                .lean();
            const names = catalog.map(function (p) { return p.name; });

            let picked = null;
            try {
                picked = await aiProvider.searchProductNames(query, names);
            } catch (err) {
                // Provider down/misconfigured/slow -> deterministic fallback.
                picked = null;
            }

            if (Array.isArray(picked)) {
                const items = await Product.find({
                    active: true,
                    stock: { $gt: 0 },
                    name: { $in: picked }
                })
                    .select("name price unit category emoji gradient rating ratingCount image")
                    .lean();
                const order = {};
                picked.forEach(function (n, i) { order[n] = i; });
                items.sort(function (a, b) { return (order[a.name] || 0) - (order[b.name] || 0); });
                return res.json({
                    success: true,
                    source: "ai",
                    query: query,
                    count: items.length,
                    items: items
                });
            }
        }

        const items = await searchUtils.findProductsByIntent(query, limit);
        res.json({ success: true, source: "local", query: query, count: items.length, items: items });
    } catch (error) {
        res.status(500).json({ success: false, message: "Search failed" });
    }
};

// ===============================
// GET ALL PRODUCTS (public, only active)
// ===============================
// PUBLIC PROJECTION (SEC-10). The public catalogue used to return whole
// Product documents, which handed anonymous visitors our internal B2B tier
// (`b2bPrice`/`b2bMinQty`), the `active` moderation flag and the mongoose
// `__v` version counter. The Product model itself documents that b2b prices
// are "server-authoritative - the retail client never sees them unless the
// caller is an approved b2b_customer"; these two endpoints were breaking that
// promise.
//
// `stock` deliberately stays public: the storefront caps the quantity picker
// with it and refuses to add an out-of-stock item. Hiding an exact count would
// be nicer in theory but breaks ordering UX; wholesale pricing and moderation
// flags are the actual commercial leak.
const PUBLIC_PRODUCT_FIELDS = "name price unit category emoji gradient description nutrition tips origin stock rating ratingCount image variants.unit variants.price variants.stock variants._id createdAt";

exports.getProducts = async (req, res) => {
    try {
        // SEC-02: `search` and `category` arrive as attacker-controlled input
        // and Express's default query parser turns `?category[$ne]=x` into an
        // OBJECT, which used to be dropped straight into the Mongo filter
        // (live-confirmed: it matched every product). Two defences:
        //   1. only a plain string is ever accepted, so `[$ne]`, `[$gt]`, `[$regex]`
        //      and friends can never reach the query;
        //   2. the string that DOES reach the name filter is regex-escaped, so
        //      `search=.*` matches a literal dot-star and cannot turn into a
        //      "match everything" (or a catastrophic-backtracking) regex.
        const rawSearch = req.query.search;
        const rawCategory = req.query.category;
        if (rawSearch !== undefined && typeof rawSearch !== "string") {
            return res.status(400).json({ success: false, message: "Invalid search query" });
        }
        if (rawCategory !== undefined && typeof rawCategory !== "string") {
            return res.status(400).json({ success: false, message: "Invalid category" });
        }

        let filter = { active: true };

        if (rawCategory && rawCategory !== "All") {
            filter.category = rawCategory;
        }

        if (rawSearch) {
            const checked = searchUtils.validateSearchQuery(rawSearch, 100);
            if (!checked.ok) {
                return res.status(400).json({ success: false, message: checked.message });
            }
            filter.name = { $regex: searchUtils.nameRegexFor(checked.value), $options: "i" };
        }

        const products = await Product.find(filter)
            .select(PUBLIC_PRODUCT_FIELDS)
            .sort({ category: 1, createdAt: -1 });
        res.json({ success: true, count: products.length, data: products });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// ===============================
// TRENDING PRODUCTS (real order data)
// Ranked by actual recent sales: quantity sold (weighted) + order frequency,
// restricted to active, in-stock products. When there is not enough sales
// history, falls back to the top-rated active products so the section never
// renders empty. No customer/PII data is ever included.
// ===============================
exports.getTrendingProducts = async (req, res) => {
    try {
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 8, 1), 20);
        const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const agg = await Order.aggregate([
            { $match: { status: { $ne: "Cancelled" }, createdAt: { $gte: since } } },
            { $unwind: "$items" },
            { $match: { "items.productId": { $exists: true, $ne: null } } },
            { $group: {
                _id: "$items.productId",
                soldQty: { $sum: "$items.quantity" },
                orderCount: { $sum: 1 },
                lastOrder: { $max: "$createdAt" }
            } },
            { $lookup: { from: "products", localField: "_id", foreignField: "_id", as: "p" } },
            { $unwind: { path: "$p", preserveNullAndEmptyArrays: false } },
            { $match: { "p.active": true, "p.stock": { $gt: 0 } } },
            { $addFields: { score: { $add: [{ $multiply: ["$soldQty", 2] }, "$orderCount"] } } },
            { $sort: { score: -1, lastOrder: -1 } },
            { $limit: limit },
            { $project: {
                _id: 1,
                soldQty: 1,
                orderCount: 1,
                score: 1,
                name: "$p.name",
                price: "$p.price",
                unit: "$p.unit",
                category: "$p.category",
                emoji: "$p.emoji",
                gradient: "$p.gradient",
                image: "$p.image",
                rating: "$p.rating",
                ratingCount: "$p.ratingCount"
            } }
        ]);

        let data = agg.map((d) => ({ ...d, fromSales: true }));
        if (data.length === 0) {
            const fallback = await Product.find({ active: true, stock: { $gt: 0 } })
                .sort({ rating: -1, ratingCount: -1 })
                .limit(limit)
                .lean();
            data = fallback.map((p) => ({
                _id: p._id,
                name: p.name,
                price: p.price,
                unit: p.unit,
                category: p.category,
                emoji: p.emoji,
                gradient: p.gradient,
                image: p.image,
                rating: p.rating,
                ratingCount: p.ratingCount,
                soldQty: 0,
                orderCount: 0,
                fromSales: false
            }));
        }

        res.json({ success: true, count: data.length, data: data, fromSales: agg.length > 0 });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// ===============================
// GET SINGLE PRODUCT
// ===============================
exports.getProduct = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const product = await Product.findById(req.params.id).select(PUBLIC_PRODUCT_FIELDS);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

// GET ALL PRODUCTS INCLUDING INACTIVE (admin)
exports.getAdminProducts = async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        res.json({ success: true, count: products.length, data: products });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
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
        let previousProduct = await Product.findById(req.params.id);
        if (!previousProduct) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const wasAvailable = productAvailable(previousProduct);
        if (updates.variants !== undefined) {
            const { variants } = normalizeVariants(updates.variants);
            updates.variants = variants;
        }
        const product = await Product.findByIdAndUpdate(req.params.id, updates, {
            new: true,
            runValidators: true
        });
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        maybeNotifyRestock(product, wasAvailable);
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
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
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
        const wasAvailable = productAvailable(product);
        const previousStock = product.stock;
        product.stock = Math.floor(s);
        await product.save();
        if (product.stock !== previousStock) {
            await logStockChange({
                product: product._id, variantId: null, scope: "stock", change: product.stock - previousStock,
                previousStock: previousStock, newStock: product.stock, reason: "admin_update", changedByType: "admin", changedBy: req.user ? req.user._id : null, note: product.name
            });
        }
        maybeNotifyRestock(product, wasAvailable);
        res.json({ success: true, data: product });
    } catch (error) {
        res.status(400).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
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
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};
