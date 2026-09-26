// ===============================
// REVIEW CONTROLLER
// Public: submit + list reviews for a product.
// Customer: edit / delete their OWN review (ownership enforced server-side).
// Admin: list all, moderate (approve/reject/hide), delete.
// The product rating is only derived from reviewed-and-approved reviews, so a
// single moderator action immediately re-fixes the public aggregate.
// ===============================

const Review = require("../models/Review");
const Product = require("../models/Product");
const mongoose = require("mongoose");

function isBadObjectId(id) {
    return !mongoose.Types.ObjectId.isValid(String(id || ""));
}

// Match "currently public" reviews: approved, plus legacy reviews that predate
// moderation (they have no moderationStatus at all). Rejected/hidden/pending
// reviews are never shown to shoppers.
function approvedFilter(extra) {
    const base = {
        $or: [
            { moderationStatus: "APPROVED" },
            { moderationStatus: { $exists: false } }
        ]
    };
    return Object.assign({}, extra, base);
}

// Re-derive a product's public rating from its APPROVED (or legacy) reviews.
// When no approved reviews exist the legacy rating is left untouched so a
// moderation sweep can never zero out a seeded rating.
async function recomputeProductRating(productId) {
    const row = await Review.aggregate([
        { $match: approvedFilter({ product: productId }) },
        { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } }
    ]);
    const stat = row[0];
    if (stat && stat.count > 0) {
        await Product.updateOne(
            { _id: productId },
            { $set: { rating: Math.round(stat.avg * 10) / 10, ratingCount: stat.count } }
        );
    }
}

// GET reviews for one product (public — approved only)
exports.getProductReviews = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "No reviews" });
        }
        const reviews = await Review.find(approvedFilter({ product: req.params.id }))
            .sort({ createdAt: -1 })
            .limit(50);
        res.json({ success: true, count: reviews.length, data: reviews });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// POST a review for one product (public, optionally authenticated; one review
// per product per account so a single user cannot inflate a rating repeatedly).
// New reviews are PENDING — they leave the displayed rating untouched until a
// moderator approves them.
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
            comment: String(comment).trim(),
            moderationStatus: "PENDING"
        });

        res.status(201).json({ success: true, data: review, message: "Review submitted for approval" });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// PUT reviews/:id — customer edits their OWN review. The edited review returns
// to PENDING (re-moderation) so changed text cannot silently re-enter the
// public rating.
exports.updateOwnReview = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        if (!req.user || !review.user || String(review.user) !== String(req.user._id)) {
            return res.status(403).json({ success: false, message: "You can only edit your own review" });
        }
        const { rating, comment } = req.body;
        if (rating !== undefined) {
            const r = Number(rating);
            if (!Number.isFinite(r) || r < 1 || r > 5) {
                return res.status(400).json({ success: false, message: "Rating must be 1-5" });
            }
            review.rating = r;
        }
        if (comment !== undefined) {
            if (!comment || !String(comment).trim()) {
                return res.status(400).json({ success: false, message: "Review comment required" });
            }
            review.comment = String(comment).trim();
        }
        review.moderationStatus = "PENDING";
        review.moderationNote = null;
        review.edited = true;
        review.editedAt = new Date();
        await review.save();

        await recomputeProductRating(review.product);
        res.json({ success: true, data: review, message: "Review updated and queued for approval" });
    } catch (error) {
        if (error && error.name === "ValidationError") {
            return res.status(400).json({ success: false, message: error.message });
        }
        res.status(500).json({ success: false, message: error.message });
    }
};

// DELETE reviews/:id — owner (customer) or admin. Admins may delete any review;
// a customer may only delete their own (403 otherwise / IDOR protection).
exports.deleteReview = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        const isAdmin = req.user && req.user.role === "admin";
        if (!isAdmin && (!req.user || !review.user || String(review.user) !== String(req.user._id))) {
            return res.status(403).json({ success: false, message: "You can only delete your own review" });
        }
        const productId = review.product;
        await Review.findByIdAndDelete(review._id);
        await recomputeProductRating(productId);
        res.json({ success: true, message: "Review deleted" });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET all reviews for admin management (protected: admin only)
exports.adminListReviews = async (req, res) => {
    try {
        const { search, status } = req.query;
        let filter = {};
        if (search && String(search).trim()) {
            filter.$or = [
                { productName: { $regex: String(search).trim(), $options: "i" } },
                { userName: { $regex: String(search).trim(), $options: "i" } }
            ];
        }
        if (status === "PENDING" || status === "APPROVED" || status === "REJECTED" || status === "HIDDEN") {
            filter.moderationStatus = status;
        }
        const reviews = await Review.find(filter)
            .sort({ createdAt: -1 })
            .limit(500)
            .populate("user", "name email");
        res.json({ success: true, count: reviews.length, data: reviews });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// PATCH reviews/:id/moderation — admin approve/reject/hide a review.
exports.adminModerateReview = async (req, res) => {
    try {
        if (isBadObjectId(req.params.id)) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        const { moderationStatus, moderationNote } = req.body;
        if (!["APPROVED", "REJECTED", "HIDDEN"].includes(moderationStatus)) {
            return res.status(400).json({ success: false, message: "Invalid moderation status" });
        }
        const review = await Review.findById(req.params.id);
        if (!review) {
            return res.status(404).json({ success: false, message: "Review not found" });
        }
        review.moderationStatus = moderationStatus;
        review.moderatedBy = req.user._id;
        review.moderatedAt = new Date();
        review.moderationNote = moderationNote && String(moderationNote).trim() ? String(moderationNote).trim().slice(0, 200) : null;
        await review.save();
        await recomputeProductRating(review.product);
        res.json({ success: true, data: review });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};