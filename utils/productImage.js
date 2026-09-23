// ===============================
// PRODUCT IMAGE VALIDATION (shared)
// ===============================

// An admin can provide a product image either as a plain URL / project-relative
// file name (existing behavior), as an uploaded file that arrives to the server
// as a base64 data URI, or as a Cloudinary HTTPS URL produced by the upload
// endpoint. Uploaded images are always validated server-side: decoded byte
// length is capped and the file's real bytes (magic numbers) are sniffed so a
// client-provided MIME type is never trusted. Only PNG/JPEG/WEBP uploads pass.

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

// Parse + validate a data-URI upload. Returns { buffer, type } or throws a
// 400-style error so garbage never reaches the image host.
function parseImageDataUri(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) throw badImage("No image data provided.");
    if (v.length > MAX_IMAGE_DATA_URI) throw badImage("Image is too large (max 1.5 MB).");

    // Only accept real base64 image data URIs — never arbitrary URLs or other schemes.
    const match = /^data:image\/(png|jpeg|webp|jpg);base64,([A-Za-z0-9+/=]+)$/i.exec(v);
    if (!match) throw badImage("Image upload must be a PNG, JPEG or WEBP file.");

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

    return { buffer: buf, type };
}

// Validate + normalize an incoming Product.image value, or throw a 400-style
// error. Backward-compatible: plain URLs, project-relative file names and
// existing data URIs all keep working.
function normalizeProductImage(value) {
    const v = String(value == null ? "" : value).trim();
    if (!v) return "";

    // Existing methods: absolute URL (incl. Cloudinary) or project-relative file name.
    if (/^https?:\/\//i.test(v)) {
        if (v.length > 4096) throw badImage("Image URL is too long.");
        return v;
    }
    if (/^images\//i.test(v) || /^[A-Za-z0-9_\-.\/ ]+\.(png|jpe?g|webp|gif|jfif)$/i.test(v)) {
        if (v.length > 512) throw badImage("Image file name is too long.");
        return v;
    }

    // Existing uploaded images inside documents: keep the data URI untouched.
    const parsed = parseImageDataUri(v);
    return "data:image/" + parsed.type + ";base64," + parsed.buffer.toString("base64");
}

module.exports = {
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DATA_URI,
    badImage,
    sniffImageType,
    parseImageDataUri,
    normalizeProductImage
};