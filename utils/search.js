// ===============================
// SEARCH UTILITIES
// Shared, dependency-free helpers for search suggestions, input sanitization
// and the deterministic (non-AI) natural-language fallback used by AI search.
// No customer/order data is ever read here — only the Product catalog.
// ===============================

const Product = require("../models/Product");

const MAX_AI_QUERY_LENGTH = 100;
const MAX_SUGGEST_QUERY_LENGTH = 40;

// Keep the regex out of the raw user string: product names are matched
// literally, so regex metacharacters must not be interpreted.
function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns { ok:true, value } or { ok:false, message }. Strips control chars,
// HTML-ish tags (rendered as whitespace) and collapses whitespace. Length
// violations are rejected rather than silently truncated.
function validateSearchQuery(raw, max) {
    if (typeof raw !== "string") {
        return { ok: false, message: "A search query is required" };
    }
    let value = raw
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!value) {
        return { ok: false, message: "A search query is required" };
    }
    if (value.length > max) {
        return { ok: false, message: "Search query is too long" };
    }
    return { ok: true, value: value };
}

// Case-insensitive literal substring regex for name matching. Returns the
// escaped string — MongoDB's $regex/$options pair, NOT a RegExp object (a
// RegExp object would carry its own options and collide with $options).
function nameRegexFor(query) {
    return escapeRegex(query);
}

// ---------------------------------------------------------------
// Deterministic natural-language fallback ("AI search" without a provider).
// Maps plain-English and Hinglish intents to the real product catalog:
//   "cheap vegetables"  -> category Vegetables, price-ascending
//   "items for breakfast" -> Fruits + Grocery
//   "healthy fruits"    -> Fruits + Vegetables
//   "products under 200"-> price <= 200
//   "sabzi" / "sasta"   -> Hinglish aliases
// ---------------------------------------------------------------

const CATEGORY_INTENTS = [
    { key: "vegetables", cats: ["Vegetables", "vegetables"], aliases: ["vegetable", "vegetables", "veg", "veggies", "sabzi", "sabji", "sabz", "subzi", "tarkari", "bhaji", "sabziyan", "saag"] },
    { key: "fruits", cats: ["Fruits"], aliases: ["fruit", "fruits", "phal", "phaal", "fal", "phala", "phale", "meva", "fruitss", "froot"] },
    { key: "grocery", cats: ["Grocery"], aliases: ["grocery", "groceries", "kirana", "kiryana", "ration", "khan-paan"] },
    { key: "dairy", cats: ["Grocery", "Fruits"], aliases: ["dairy", "milk", "doodh", "duudh", "paneer", "cheese", "curd", "dahi", "makhan", "ghee", "butter"] },
    { key: "eggs", cats: ["Grocery", "Vegetables", "vegetables"], aliases: ["egg", "eggs", "anda", "ande", "andan", "omelet", "omelette"] },
    { key: "breakfast", cats: ["Fruits", "Grocery"], aliases: ["breakfast", "nashta", "naashta", "nasta", "shubh", "subah", "morning", "brunch"] },
    { key: "healthy", cats: ["Fruits", "Vegetables", "vegetables"], aliases: ["healthy", "health", "sehat", "swasth", "swasthya", "fit", "nutrition"] },
    { key: "juice", cats: ["Fruits"], aliases: ["juice", "juices", "smoothie", "smoothies"] }
];

// Budget phrases: "under 200", "less than 200", "200 rupaye se kam".
const PRICE_BELOW_RE = /(?:under|below|less\s+than|upto|up\s+to|\bkam\b|\bse\s+kam)\s*(?:rs\.?|inr|₹)?\s*(\d{1,6})/i;
const PRICE_MAX_RE = /(\d{1,6})\s*(?:rs\.?|inr|₹)?\s*(?:se\s+kam|\bkam\b|below|under)/i;
const CHEAP_RE = /(?:cheap|budget|sasta|sasti|affordable|economy|low\s*price|kam\s*price|kam\s*dam)/i;

// Words that carry intent (quality/category/pricing) and must never be
// treated as literal product-name tokens.
const IGNORED_TOKENS = new Set([
    "cheap", "budget", "sasta", "sasti", "affordable", "economy",
    "under", "below", "less", "than", "upto", "up", "to", "kam", "se", "rupees", "rupaye", "rupee", "rs", "inr",
    "items", "item", "products", "product", "goods",
    "for", "with", "and", "or", "the", "a", "an", "of", "in", "at",
    "show", "me", "give", "want", "need", "buy", "purchase", "get", "please", "list",
    "price", "prices", "rate", "rates", "sehat", "swasth", "healthy", "health", "fit", "breakfast", "nashta",
    "milk", "doodh", "dahi", "curd", "paneer", "ghee", "egg", "eggs", "anda", "dairy",
    "grocery", "groceries", "kirana", "veg", "veggies", "vegetable", "vegetables", "sabzi", "sabji",
    "fruit", "fruits", "phal", "phaal", "fal", "juice", "smoothie"
]);

function resolveIntent(query) {
    const lower = query.toLowerCase();
    const intent = { categories: null, maxPrice: null, sortCheap: false, tokens: [] };

    const below = lower.match(PRICE_BELOW_RE);
    const above = lower.match(PRICE_MAX_RE);
    const budget = below || above;
    if (budget) {
        const n = parseInt(budget[1], 10);
        if (Number.isFinite(n) && n > 0) intent.maxPrice = n;
    }
    if (CHEAP_RE.test(lower)) intent.sortCheap = true;

    const words = lower.split(/\s+/).filter(Boolean);
    const matchedWords = new Set();
    let matchedCats = null;

    for (const it of CATEGORY_INTENTS) {
        let hit = false;
        for (const a of it.aliases) {
            const idx = lower.indexOf(a);
            if (idx !== -1) {
                hit = true;
                matchedWords.add(a);
            }
        }
        if (hit) {
            matchedCats = matchedCats || [];
            for (const c of it.cats) {
                if (matchedCats.indexOf(c) === -1) matchedCats.push(c);
            }
        }
    }
    if (matchedCats) intent.categories = matchedCats;

    // Anything left over is treated as a plain partial-name token.
    words.forEach(function (w) {
        let covered = false;
        for (const mw of matchedWords) {
            if (w.indexOf(mw) !== -1 || mw.indexOf(w) !== -1) { covered = true; break; }
        }
        if (!covered && !IGNORED_TOKENS.has(w) && !/^\d+$/.test(w)) {
            intent.tokens.push(w);
        }
    });

    return intent;
}

async function findProductsByIntent(query, limit) {
    const intent = resolveIntent(query);
    const filter = { active: true, stock: { $gt: 0 } };

    if (intent.categories && intent.categories.length) {
        filter.category = { $in: intent.categories };
    }
    if (intent.tokens.length) {
        filter.name = { $regex: nameRegexFor(intent.tokens.join(" ")), $options: "i" };
    }
    if (intent.maxPrice != null) {
        filter.price = { $lte: intent.maxPrice };
    }

    let sort = { name: 1 };
    if (intent.sortCheap || intent.maxPrice != null) sort = { price: 1 };

    let items = await Product.find(filter)
        .select("name price unit category emoji gradient rating ratingCount image")
        .sort(sort)
        .limit(limit)
        .lean();

    // A multi-word phrase rarely matches a real product name verbatim (e.g.
    // "tomato fresh" -> Fresh Tomato). Retry with the tokens matched anywhere
    // in the name before giving up.
    if (items.length === 0 && intent.tokens.length > 1) {
        const retryFilter = {};
        Object.keys(filter).forEach(function (k) {
            if (k !== "name") retryFilter[k] = filter[k];
        });
        retryFilter.$and = intent.tokens.map(function (t) {
            return { name: { $regex: nameRegexFor(t), $options: "i" } };
        });
        const retry = await Product.find(retryFilter)
            .select("name price unit category emoji gradient rating ratingCount image")
            .sort(sort)
            .limit(limit)
            .lean();
        return retry;
    }

    return items;
}

// ---------------------------------------------------------------
// Category list used by suggestions. Cached in memory for 60s so a typing
// session never fires one aggregation per keystroke.
// ---------------------------------------------------------------
let categoryCache = null;
let categoryCacheAt = 0;

async function getCategories() {
    const now = Date.now();
    if (!categoryCache || now - categoryCacheAt > 60000) {
        const raw = await Product.aggregate([
            { $match: { active: true } },
            { $group: { _id: "$category", count: { $sum: 1 } } },
            { $sort: { _id: 1 } }
        ]);
        categoryCache = raw.map(function (r) { return { name: String(r._id), count: r.count }; });
        categoryCacheAt = now;
    }
    return categoryCache;
}

module.exports = {
    MAX_AI_QUERY_LENGTH: MAX_AI_QUERY_LENGTH,
    MAX_SUGGEST_QUERY_LENGTH: MAX_SUGGEST_QUERY_LENGTH,
    validateSearchQuery: validateSearchQuery,
    nameRegexFor: nameRegexFor,
    resolveIntent: resolveIntent,
    findProductsByIntent: findProductsByIntent,
    getCategories: getCategories
};