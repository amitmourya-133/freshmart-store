// ===============================
// PRODUCT BULK IMPORT + IMAGE DISCOVERY (admin)
// ===============================
// Secure CSV bulk import and server-side image discovery/download.
// Reuses existing Product model, admin auth and image validation.

const Product = require("../models/Product");
const { safeErrorMessage } = require("../utils/safeError");
const imageDiscovery = require("../utils/imageDiscovery");
const { normalizeProductImage } = require("../utils/productImage");

const ALLOWED_CATEGORIES = new Set([
    "Vegetables", "Fruits", "Grocery", "Dairy", "Beverages", "Snacks",
    "Bakery", "Meat", "Seafood", "Frozen", "Household", "Personal Care",
    "Spices", "Pulses", "Oils", "Beverage"
]);
const ALLOWED_UNITS = new Set([
    "kg", "g", "pack", "bunch", "dozen", "piece", "box", "litre", "l", "ml", "gm"
]);
const MAX_ROWS = 500;
const MAX_CSV_BYTES = 500 * 1024; // 500 KiB
const MAX_FIELD_LEN = 500;

// ---------- CSV parser (RFC 4180-ish, handles quotes/commas/newlines/unicode) ----------
function parseCsv(text) {
    const rows = [];
    let i = 0;
    const n = text.length;
    let field = "";
    let row = [];
    let inQuotes = false;
    let atLineStart = true;
    let fieldStarted = false;

    // We parse char by char.
    while (i < n) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (i + 1 < n && text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += c;
            i++;
            continue;
        }
        if (c === '"') {
            if (fieldStarted && field !== "") {
                // quote in middle of unquoted field -> treat literally
                field += c;
                i++;
                continue;
            }
            inQuotes = true;
            fieldStarted = true;
            i++;
            continue;
        }
        if (c === ",") {
            row.push(field);
            field = "";
            fieldStarted = false;
            i++;
            continue;
        }
        if (c === "\n") {
            row.push(field);
            // Skip trailing empty row (final newline).
            if (row.length > 1 || row[0] !== "" || rows.length > 0) {
                rows.push(row);
            }
            row = [];
            field = "";
            fieldStarted = false;
            i++;
            continue;
        }
        if (c === "\r") {
            // handle \r\n
            if (i + 1 < n && text[i + 1] === "\n") { i++; continue; }
            // lone \r treated as line break
            row.push(field);
            if (row.length > 1 || row[0] !== "" || rows.length > 0) {
                rows.push(row);
            }
            row = [];
            field = "";
            fieldStarted = false;
            i++;
            continue;
        }
        field += c;
        fieldStarted = true;
        i++;
    }
    // trailing field/row
    if (fieldStarted || row.length > 0 || field !== "") {
        row.push(field);
        if (row.length > 1 || row[0] !== "") {
            rows.push(row);
        }
    }
    return rows;
}

function normalizeHeader(h) {
    return String(h || "").trim().toLowerCase().replace(/\s+/g, "");
}

const HEADER_MAP = {
    "name": "name",
    "productname": "name",
    "product": "name",
    "category": "category",
    "price": "price",
    "unit": "unit",
    "stock": "stock",
    "description": "description",
    "desc": "description",
    "emoji": "emoji",
    "image": "image",
    "imagepath": "image",
    "imageurl": "image",
};

function parseCsvToObjects(text) {
    const raw = parseCsv(text);
    if (!raw.length) return { header: [], rows: [] };
    const header = raw[0].map(normalizeHeader);
    const mapped = header.map((h) => HEADER_MAP[h] || h);
    const rows = [];
    for (let r = 1; r < raw.length; r++) {
        const cells = raw[r];
        // Pad/truncate to header length.
        const obj = {};
        for (let c = 0; c < mapped.length; c++) {
            const key = mapped[c];
            if (!key) continue;
            obj[key] = (cells[c] == null ? "" : String(cells[c])).trim();
        }
        // Skip completely empty rows.
        const allEmpty = Object.values(obj).every((v) => String(v).trim() === "");
        if (allEmpty) continue;
        rows.push({ rowNumber: r + 1, data: obj });
    }
    return { header: mapped, rows };
}

function validateRow(data, existingNames, seenInCsv) {
    const errors = [];
    const warnings = [];

    const name = String(data.name || "").trim();
    if (!name) errors.push("name is required");
    else if (name.length > MAX_FIELD_LEN) errors.push("name too long");

    const category = String(data.category || "").trim();
    if (!category) errors.push("category is required");
    else if (!ALLOWED_CATEGORIES.has(category)) errors.push("invalid category: " + category);

    const unit = String(data.unit || "").trim() || "kg";
    if (!ALLOWED_UNITS.has(unit)) errors.push("invalid unit: " + unit);

    const priceRaw = String(data.price || "").trim();
    const price = Number(priceRaw);
    if (priceRaw === "" || !Number.isFinite(price) || price < 0) errors.push("price must be a non-negative number");

    const stockRaw = String(data.stock || "").trim();
    let stock = 50;
    if (stockRaw !== "") {
        const s = Number(stockRaw);
        if (!Number.isFinite(s) || s < 0) errors.push("stock must be a non-negative number");
        else stock = Math.floor(s);
    }

    const description = String(data.description || "").trim().slice(0, 2000);
    const emoji = String(data.emoji || "").trim().slice(0, 8);
    const imageRaw = String(data.image || "").trim();

    // Duplicate detection
    const lowerName = name.toLowerCase();
    if (name && existingNames.has(lowerName)) {
        warnings.push("product with this name already exists");
    }
    if (name && seenInCsv.has(lowerName)) {
        warnings.push("duplicate name within CSV");
    }

    // Image validation
    let image = "";
    if (imageRaw) {
        try {
            image = normalizeProductImage(imageRaw);
        } catch (e) {
            errors.push("invalid image: " + (e && e.message ? e.message : "bad image"));
        }
    }

    const valid = errors.length === 0 && warnings.length === 0;
    return {
        valid,
        errors,
        warnings,
        normalized: {
            name,
            category,
            price: Number.isFinite(price) ? Math.round(price * 100) / 100 : 0,
            unit,
            stock,
            description,
            emoji: emoji || "\ud83e\udd6c",
            image,
        },
    };
}

// ---------- Controllers ----------

exports.bulkImport = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Admin access only" });
        }
        const csvText = req.body && req.body.csv;
        const dryRun = !!(req.body && req.body.dryRun);
        if (typeof csvText !== "string" || !csvText.trim()) {
            return res.status(400).json({ success: false, message: "CSV content is required" });
        }
        if (Buffer.byteLength(csvText, "utf8") > MAX_CSV_BYTES) {
            return res.status(413).json({ success: false, message: "CSV file too large (max 500 KB)" });
        }

        const { header, rows } = parseCsvToObjects(csvText);
        if (!header || !header.includes("name")) {
            return res.status(400).json({ success: false, message: "CSV must include a 'name' column" });
        }
        if (rows.length === 0) {
            return res.status(400).json({ success: false, message: "CSV has no data rows" });
        }
        if (rows.length > MAX_ROWS) {
            return res.status(413).json({ success: false, message: "Too many rows (max " + MAX_ROWS + ")" });
        }

        // Existing product names for duplicate detection.
        const existing = await Product.find().select("name").lean();
        const existingNames = new Set(existing.map((p) => String(p.name || "").trim().toLowerCase()));
        const seenInCsv = new Set();

        const results = [];
        const toInsert = [];
        for (const r of rows) {
            const v = validateRow(r.data, existingNames, seenInCsv);
            if (r.data.name) seenInCsv.add(String(r.data.name).trim().toLowerCase());

            if (v.errors.length > 0 || v.warnings.length > 0) {
                results.push({
                    row: r.rowNumber,
                    status: v.errors.length > 0 ? "failed" : "skipped",
                    reasons: v.errors.concat(v.warnings),
                    name: r.data.name || "",
                });
                continue;
            }
            // Mark name as now-existing for subsequent rows.
            existingNames.add(v.normalized.name.toLowerCase());
            toInsert.push({ row: r.rowNumber, data: v.normalized });
            results.push({ row: r.rowNumber, status: "pending", name: v.normalized.name });
        }

        // Insert valid rows (unless dry run). Not atomic across rows — report per-row outcome.
        let inserted = 0, skipped = 0, failed = 0;
        const insertedIds = [];
        if (dryRun) {
            for (const item of toInsert) {
                const r = results.find((x) => x.row === item.row);
                if (r) { r.status = "valid"; r.reasons = []; }
            }
        } else {
            for (const item of toInsert) {
                try {
                    const product = await Product.create(item.data);
                    inserted++;
                    insertedIds.push(product._id);
                    const r = results.find((x) => x.row === item.row);
                    if (r) { r.status = "inserted"; r.productId = product._id; r.reasons = []; }
                } catch (e) {
                    failed++;
                    const r = results.find((x) => x.row === item.row);
                    if (r) { r.status = "failed"; r.reasons = [safeErrorMessage(e) || "insert failed"]; }
                }
            }
        }
        for (const r of results) {
            if (r.status === "skipped") skipped++;
            else if (r.status === "failed") failed++;
            else if (r.status === "valid") { /* dry run: counted as would-be inserted */ }
            else if (r.status === "pending") { r.status = "failed"; r.reasons = ["not inserted"]; failed++; }
        }
        if (dryRun) {
            inserted = toInsert.length;
        }

        res.json({
            success: true,
            summary: { total: rows.length, inserted, skipped, failed },
            results,
        });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

exports.searchImages = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Admin access only" });
        }
        const query = String((req.body && req.body.query) || (req.query && req.query.q) || "").trim();
        if (!query) return res.status(400).json({ success: false, message: "Search query is required" });
        if (query.length > 100) return res.status(400).json({ success: false, message: "Query too long" });
        const result = await imageDiscovery.searchImages(query);
        res.json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, message: safeErrorMessage(error) });
    }
};

exports.downloadImage = async (req, res) => {
    try {
        const user = req.user;
        if (!user || user.role !== "admin") {
            return res.status(403).json({ success: false, message: "Admin access only" });
        }
        const candidate = req.body && req.body.candidate;
        if (!candidate || typeof candidate !== "object") {
            return res.status(400).json({ success: false, message: "Image candidate is required" });
        }
        const result = await imageDiscovery.downloadImage(candidate);
        res.json({ success: true, data: result });
    } catch (error) {
        const status = (error && error.status) || 400;
        res.status(status).json({ success: false, message: safeErrorMessage(error) });
    }
};

exports.getAllowedValues = (req, res) => {
    res.json({
        success: true,
        data: {
            categories: Array.from(ALLOWED_CATEGORIES),
            units: Array.from(ALLOWED_UNITS),
            maxRows: MAX_ROWS,
            maxCsvBytes: MAX_CSV_BYTES,
        },
    });
};

module.exports = {
    bulkImport: exports.bulkImport,
    searchImages: exports.searchImages,
    downloadImage: exports.downloadImage,
    getAllowedValues: exports.getAllowedValues,
    parseCsv: parseCsv,
    parseCsvToObjects: parseCsvToObjects,
    validateRow: validateRow,
    ALLOWED_CATEGORIES: ALLOWED_CATEGORIES,
    ALLOWED_UNITS: ALLOWED_UNITS,
};
