// ===============================
// PRODUCT IMAGE DISCOVERY (server-side)
// Searches Wikimedia Commons for candidate product photographs and downloads
// a selected candidate into the approved local image directory.
//
// Security:
//  - Search queries are sanitized; only Wikimedia Commons API is contacted.
//  - Downloads accept a *candidate reference* returned by searchImages(), not
//    an arbitrary client-supplied URL. The download URL is re-validated against
//    an allowlist of hosts and re-checked on every redirect.
//  - SSRF protection: only https://upload.wikimedia.org (and the Commons API
//    host for metadata) is reachable; localhost/private/metadata hosts are
//    rejected.
//  - Size, MIME, magic bytes and dimensions are validated before saving.
// ===============================

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { sniffImageType } = require("./productImage");

const REPO_ROOT = path.join(__dirname, "..");
const IMAGE_DIR = path.join(REPO_ROOT, "images");

const ALLOWED_DOWNLOAD_HOSTS = new Set(["upload.wikimedia.org"]);
const COMMONS_API_HOST = "commons.wikimedia.org";
const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024; // 5 MiB
const MAX_IMAGE_PIXELS = 16 * 1024 * 1024; // 16 MP (decompression-bomb guard)
const MAX_DIMENSION = 4096;
const REQUEST_TIMEOUT_MS = 15000;

// Hindi / alias hints for common produce. Used to improve search recall.
const ALIASES = {
    "aloo": "potato", "aaloo": "potato", "\u0906\u0932\u0942": "potato",
    "pyaj": "onion", "pyaaz": "onion", "\u092a\u094d\u092f\u093e\u091c": "onion",
    "tamatar": "tomato", "\u091f\u092e\u093e\u091f\u0930": "tomato",
    "phoolgobhi": "cauliflower", "gobhi": "cauliflower", "\u092b\u0942\u0932\u0917\u094b\u092d\u0940": "cauliflower",
    "palak": "spinach", "\u092a\u093e\u0932\u0915": "spinach",
    "baingan": "eggplant brinjal", "\u092c\u0948\u0902\u0917\u0928": "eggplant brinjal",
    "bhindi": "okra", "\u092d\u093f\u0902\u0921\u0940": "okra",
    "lauki": "bottle gourd", "\u0932\u094c\u0915\u0940": "bottle gourd",
    "gajar": "carrot", "\u0917\u093e\u091c\u0930": "carrot",
    "matar": "peas", "\u092e\u091f\u0930": "peas green peas",
    "kheera": "cucumber", "\u0916\u0940\u0930\u093e": "cucumber",
    "shimla mirch": "bell pepper capsicum",
};

function normalizeQuery(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return "";
    // Apply alias if the whole name matches.
    if (ALIASES[n]) return ALIASES[n];
    // Apply alias per-token for mixed input.
    const tokens = n.split(/\s+/);
    const mapped = tokens.map((t) => ALIASES[t] || t).join(" ");
    return mapped;
}

function safeFetch(url, opts) {
    opts = opts || {};
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || REQUEST_TIMEOUT_MS);
    const fetchOpts = {
        method: opts.method || "GET",
        headers: opts.headers || {},
        signal: controller.signal,
        redirect: "manual", // we handle redirects ourselves
    };
    if (opts.body) fetchOpts.body = opts.body;
    return fetch(url, fetchOpts).finally(() => clearTimeout(timer));
}

function isAllowedDownloadUrl(u) {
    let parsed;
    try { parsed = new URL(u); } catch (e) { return false; }
    if (parsed.protocol !== "https:") return false;
    if (!ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname)) return false;
    // Block obvious SSRF-ish path patterns (not strictly needed with allowlist,
    // but defence in depth).
    if (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1") return false;
    return true;
}

// Resolve redirects manually, re-validating each hop.
async function fetchWithRedirects(url, opts) {
    opts = opts || {};
    let current = url;
    for (let hop = 0; hop < 5; hop++) {
        if (!isAllowedDownloadUrl(current)) {
            throw new Error("Download URL is not from an approved provider.");
        }
        const res = await safeFetch(current, opts);
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get("location");
            if (!loc) throw new Error("Redirect without Location header.");
            current = new URL(loc, current).toString();
            continue;
        }
        return { response: res, finalUrl: current };
    }
    throw new Error("Too many redirects.");
}

function parseDimensions(type, buf) {
    try {
        if (type === "png") {
            // IHDR: width/height at offset 16, 4 bytes each big-endian
            if (buf.length < 24) return null;
            const w = buf.readUInt32BE(16);
            const h = buf.readUInt32BE(20);
            return { width: w, height: h };
        }
        if (type === "jpeg") {
            // Scan for SOF markers
            let i = 2;
            while (i < buf.length - 9) {
                if (buf[i] !== 0xff) { i++; continue; }
                const marker = buf[i + 1];
                // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15
                if ((marker >= 0xc0 && marker <= 0xc3) ||
                    (marker >= 0xc5 && marker <= 0xc7) ||
                    (marker >= 0xc9 && marker <= 0xcb) ||
                    (marker >= 0xcd && marker <= 0xcf)) {
                    const h = buf.readUInt16BE(i + 5);
                    const w = buf.readUInt16BE(i + 7);
                    return { width: w, height: h };
                }
                if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
                const segLen = buf.readUInt16BE(i + 2);
                i += 2 + segLen;
            }
            return null;
        }
        if (type === "webp") {
            // RIFF....WEBP then VP8/VP8L/VP8X
            if (buf.length < 30) return null;
            const fourcc = buf.toString("ascii", 12, 16);
            if (fourcc === "VP8 ") {
                const w = buf.readUInt16LE(26) & 0x3fff;
                const h = buf.readUInt16LE(28) & 0x3fff;
                return { width: w, height: h };
            }
            if (fourcc === "VP8L") {
                const bits = buf.readUInt32LE(21);
                const w = (bits & 0x3fff) + 1;
                const h = ((bits >> 14) & 0x3fff) + 1;
                return { width: w, height: h };
            }
            if (fourcc === "VP8X") {
                const w = (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1;
                const h = (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1;
                return { width: w, height: h };
            }
            return null;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function searchImages(rawQuery) {
    const q = normalizeQuery(rawQuery);
    if (!q) throw new Error("Search query is required.");
    // Append a hint to bias toward photographs of the raw product.
    const search = q + " fruit vegetable";
    const params = new URLSearchParams({
        action: "query",
        generator: "search",
        gsrsearch: search,
        gsrnamespace: "6",
        gsrlimit: "12",
        prop: "imageinfo",
        iiprop: "url|size|mime|extmetadata",
        iiurlwidth: "300",
        format: "json",
        origin: "*",
    });
    const url = "https://" + COMMONS_API_HOST + "/w/api.php?" + params.toString();
    const { response } = await fetchWithRedirects(url, {
        headers: { "User-Agent": "FreshMartImageFinder/1.0 (https://freshmartstore.in)" },
    });
    if (!response.ok) throw new Error("Image search failed (" + response.status + ").");
    const data = await response.json();
    const pages = (data && data.query && data.query.pages) || {};
    const candidates = [];
    for (const key of Object.keys(pages)) {
        const p = pages[key];
        const info = (p.imageinfo && p.imageinfo[0]) || null;
        if (!info) continue;
        const mime = String(info.mime || "").toLowerCase();
        if (!/^image\/(jpeg|png|webp|gif)$/.test(mime)) continue;
        if (!info.url) continue;
        const ext = (info.extmetadata || {});
        const license = (ext.LicenseShortName && ext.LicenseShortName.value) || (ext.License && ext.License.value) || "";
        const artist = (ext.Artist && ext.Artist.value) || "";
        const credit = (ext.Credit && ext.Credit.value) || "";
        const desc = (ext.ImageDescription && ext.ImageDescription.value) || "";
        // Strip HTML tags from metadata fields.
        const strip = (s) => String(s || "").replace(/<[^>]*>/g, "").trim();
        candidates.push({
            id: String(p.pageid || p.title),
            title: String(p.title || "").replace(/^File:/i, ""),
            thumbUrl: info.thumburl || info.url,
            downloadUrl: info.url,
            width: info.width || null,
            height: info.height || null,
            mime: mime,
            license: strip(license),
            artist: strip(artist),
            credit: strip(credit),
            description: strip(desc).slice(0, 240),
            sourcePage: "https://" + COMMONS_API_HOST + "/wiki/" + encodeURIComponent(String(p.title || "").replace(/ /g, "_")),
        });
    }
    // De-duplicate by downloadUrl.
    const seen = new Set();
    const unique = [];
    for (const c of candidates) {
        if (seen.has(c.downloadUrl)) continue;
        seen.add(c.downloadUrl);
        unique.push(c);
    }
    return { query: q, normalizedQuery: q, candidates: unique.slice(0, 8) };
}

async function downloadImage(candidate) {
    if (!candidate || typeof candidate !== "object") throw new Error("Invalid image candidate.");
    const url = String(candidate.downloadUrl || "").trim();
    if (!isAllowedDownloadUrl(url)) throw new Error("Image URL is not from an approved provider.");

    const { response, finalUrl } = await fetchWithRedirects(url, {
        headers: { "User-Agent": "FreshMartImageFinder/1.0 (https://freshmartstore.in)" },
    });
    if (!response.ok) throw new Error("Image download failed (" + response.status + ").");

    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!/^image\/(jpeg|png|webp|gif)$/.test(contentType.split(";")[0].trim())) {
        throw new Error("Downloaded file is not an allowed image type.");
    }

    // Read body with size cap.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_DOWNLOAD_BYTES) {
            reader.cancel();
            throw new Error("Image is too large (max 5 MB).");
        }
        chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    if (!buf.length) throw new Error("Downloaded image is empty.");

    const type = sniffImageType(buf);
    if (!type) throw new Error("Downloaded file is not a valid PNG/JPEG/WEBP image.");

    const dims = parseDimensions(type, buf);
    if (!dims) throw new Error("Could not read image dimensions.");
    if (dims.width < 1 || dims.height < 1) throw new Error("Invalid image dimensions.");
    if (dims.width > MAX_DIMENSION || dims.height > MAX_DIMENSION) throw new Error("Image dimensions too large.");
    if (dims.width * dims.height > MAX_IMAGE_PIXELS) throw new Error("Image has too many pixels.");

    // Generate a safe filename.
    const ext = type === "jpeg" ? "jpg" : type;
    const slug = String(candidate.title || "product")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40) || "product";
    const rand = crypto.randomBytes(4).toString("hex");
    let filename = slug + "-" + rand + "." + ext;
    // Avoid overwriting an existing file.
    let fullPath = path.join(IMAGE_DIR, filename);
    let i = 1;
    while (fs.existsSync(fullPath)) {
        filename = slug + "-" + rand + "-" + i + "." + ext;
        fullPath = path.join(IMAGE_DIR, filename);
        i++;
    }

    if (!fs.existsSync(IMAGE_DIR)) fs.mkdirSync(IMAGE_DIR, { recursive: true });
    fs.writeFileSync(fullPath, buf);

    return {
        imagePath: "images/" + filename,
        filename: filename,
        type: type,
        width: dims.width,
        height: dims.height,
        bytes: buf.length,
        metadata: {
            provider: "wikimedia-commons",
            sourcePage: candidate.sourcePage || null,
            title: candidate.title || null,
            license: candidate.license || null,
            artist: candidate.artist || null,
            credit: candidate.credit || null,
            downloadUrl: finalUrl,
            downloadDate: new Date().toISOString(),
        },
    };
}

module.exports = {
    searchImages,
    downloadImage,
    normalizeQuery,
    isAllowedDownloadUrl,
    parseDimensions,
    ALIASES,
};
