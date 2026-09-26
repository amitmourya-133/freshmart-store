// ===============================
// REVIEW CONTROLLER
// Public: submit + list reviews for a product.
// Admin: list all reviews, delete a review.
// ===============================

const Review = require("../models/Review");
const Product = require("../models/Product");
const mongoose = require("mongoose");

function isBadObjectId(id) {
    return !mongoose.Types.ObjectId.isValid(String(id || ""));
}

// GET reviews for one product (public)
exports.getProductReviews = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "No reviews" });
        }
        const reviews = await Review.find({ product: req.params.id })
            .sort({ createdAt: -1 })
            .limit(50);
        res.json({ success: true, count: reviews.length, data: reviews });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST a review for one product (public, optionally authenticated; one review
// per product per account so a single user cannot inflate a rating repeatedly).
exports.addProductReview = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }
        const { rating, comment, userName } = req.body;
        const r = Number(rating);
        if (!Number.isFinite(r) || r < 1 || r > 5) {
            return res.status(400).json({ success: false, message: "Rating must be 1-5" });
        }
        if (!comment || !String(comment).trim()) {
            return res.status(400).json({ success: false, message: "Review comment required" });
        }

        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, message: "Product not found" });
        }

        // Tie the review to the authenticated user when present. The client may
        // not forge the identity; 'user' from the body is always ignored.
        const authorId = req.user ? req.user._id : undefined;
        if (authorId) {
            const dup = await Review.findOne({ product: product._id, user: authorId });
            if (dup) {
                return res.status(409).json({
                    success: false,
                    message: "You have already reviewed this product",
                });
            }
        }

        const review = await Review.create({
            product: product._id,
            productName: product.name,
            user: authorId,
            userName: (req.user && req.user.name) || String(userName || "").trim().slice(0, 30) || "Anonymous",
            rating: r,
            comment: String(comment).trim()
        });

        // Update running average (same math as productController.addRating)
        const newCount = product.ratingCount + 1;
        product.rating = (product.rating * product.ratingCount + r) / newCount;
        product.ratingCount = newCount;
        await product.save();

        res.status(201).json({ success: true, data: review });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET all reviews for admin management (protected: admin only)
exports.adminListReviews = async (req, res) => {
    try {
        const { search } = req.query;
        let filter = {};
        if (search) {
            filter.$or = [
                { productName: { $regex: search, $options: "i" } },
                { userName: { $regex: search, $options: "i" } }
            ];
        }
        const reviews = await Review.find(filter)
            .sort({ createdAt: -1 })
            .limit(500);
        res.json({ success: true, count: reviews.length, data: reviews });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE a review (protected: admin only)
exports.adminDeleteReview = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        const review = await Review.findByIdAndDelete(req.params.id);
        if (!review) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        res.json({ success: true, message: "Review deleted" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};