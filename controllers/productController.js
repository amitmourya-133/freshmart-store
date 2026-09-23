// ===============================
// PRODUCT CONTROLLER
// ===============================

const Product = require("../models/Product");
const mongoose = require("mongoose");

function isBadObjectId(id) {
    return !mongoose.Types.ObjectId.isValid(String(id || ""));
}

// ===============================
// PRODUCT IMAGE VALIDATION
// ===============================

// An admin can provide an image either as a plain URL / project-relative file
// name (existing behavior) or as an uploaded file, which arrives to the server
// as a base64 data URI. Uploaded images are validated server-side: decoded
// byte length is capped and the file's actual bytes (magic numbers) are sniffed
// so a client-provided MIME type is never trusted. Only PNG/JPEG/WEBP pass.
const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 1.5 MiB decoded payload
const MAX_IMAGE_DATA_URI = 2.5 * 1024 * 1024; // ~2.5 MiB base64 string (1.875 MiB decoded bound)

function badImage(message) {
    const err = new Error(message);
    err.status = 400;
    return err;
}

// Return the authoritative type from the raw bytes (null = not an image we accept).
function sniffImageType(buf) {
    if (buf.length >= 8 &&
        buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && // 89 PNG 4E 47
        buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
        return "png";
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
    if (buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && // RIFF
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) { // WEBP
        return "webp";
    }
    return null;
}

// Validate + normalize an incoming product image value, or throw a 400-style error.
function normalizeProductImage(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return "";

    // Existing methods: absolute URL or project-relative file name (image/*.png).
    if (/^https?:\/\//i.test(v)) {
        if (v.length > 4096) throw badImage("Image URL is too long.");
        return v;
    }
    if (/^images\//i.test(v) || /^[A-Za-z0-9_\-.\/ ]+\.(png|jpe?g|webp|gif|jfif)$/i.test(v)) {
        if (v.length > 512) throw badImage("Image file name is too long.");
        return v;
    }

    // Uploaded image: data URI. Never trust the client-declared MIME type.
    const match = /^data:image\/(png|jpeg|webp|jpg);base64,([A-Za-z0-9+/=]+)$/i.exec(v);
    if (!match) throw badImage("Image must be a URL, an images/ file name, or a PNG/JPEG/WEBP upload.");
    if (v.length > MAX_IMAGE_DATA_URI) throw badImage("Image is too large (max 1.5 MB).");

    let buf;
    try {
        buf = Buffer.from(match[2], "base64");
    } catch (e) {
        throw badImage("Invalid image upload.");
    }
    if (!buf.length) throw badImage("Invalid image upload.");
    if (buf.length > MAX_IMAGE_BYTES) throw badImage("Image is too large (max 1.5 MB).");

    // Authoritative check: sniff the real bytes, ignore whatever the client said.
    const type = sniffImageType(buf);
    if (!type) throw badImage("Unsupported image format. Please use JPG, PNG or WEBP.");

    return "data:image/" + type + ";base64," + buf.toString("base64");
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
        if (body.image !== undefined) body.image = normalizeProductImage(body.image);
        const product = await Product.create(body);
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
        const allowed = ["name", "unit", "category", "emoji", "gradient", "description", "nutrition", "tips", "origin", "active", "rating", "ratingCount", "image"];
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
        const product = await Product.findByIdAndUpdate(req.params.id, updates, {
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
        product.stock = Math.floor(s);
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
