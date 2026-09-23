// ===============================
// CLOUDINARY UPLOAD HELPER (server-side only)
// ===============================

// Cloudinary credentials live in server-side environment variables only:
//   CLOUDINARY_CLOUD_NAME
//   CLOUDINARY_API_KEY
//   CLOUDINARY_API_SECRET
// They are never exposed to the browser, HTML, or public JS bundles. This
// module is lazy: the server starts fine without them and the upload endpoint
// reports 503 until they are configured.

const crypto = require("crypto");
const cloudinary = require("cloudinary").v2;

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

// Uploads land in this folder so they never collide with other project assets.
const PRODUCTS_FOLDER = "freshmart/products";
// Large camera photos are downscaled on delivery, keeping small images untouched.
const MAX_DELIVERY_WIDTH = 1400;

function isCloudinaryConfigured() {
    return !!(CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET);
}

function getCloudinary() {
    if (!isCloudinaryConfigured()) {
        const err = new Error("Image uploads are unavailable right now (storage not configured).");
        err.status = 503;
        throw err;
    }
    cloudinary.config({
        cloud_name: CLOUDINARY_CLOUD_NAME,
        api_key: CLOUDINARY_API_KEY,
        api_secret: CLOUDINARY_API_SECRET,
        secure: true
    });
    return cloudinary;
}

// Upload validated image bytes to Cloudinary and return an optimized delivery
// URL. `buffer` must already be validated (magic bytes + size) by the caller;
// `type` is one of  png | jpeg | webp  (sniffed server-side).
async function uploadImageBytes(buffer, type) {
    const c = getCloudinary();
    const dataUri = "data:image/" + type + ";base64," + buffer.toString("base64");

    // Safe, unique public id — never derived from the user-supplied filename,
    // so one product's image can never overwrite another's.
    const publicId = "p_" + crypto.randomBytes(12).toString("hex");

    let result;
    try {
        result = await c.uploader.upload(dataUri, {
            folder: PRODUCTS_FOLDER,
            public_id: publicId,
            resource_type: "image",
            overwrite: false
        });
    } catch (err) {
        // Never leak SDK/account details to the client; propagate a generic error.
        const up = new Error("Image upload failed. Please try again.");
        up.status = 502;
        throw up;
    }

    // Deterministic optimized delivery URL: automatic format + quality, and a
    // width cap (crop "limit" only shrinks, never upscales or crops visibly).
    return c.url(PRODUCTS_FOLDER + "/" + publicId, {
        resource_type: "image",
        secure: true,
        version: result.version,
        fetch_format: "auto",
        quality: "auto",
        transformation: [{ width: MAX_DELIVERY_WIDTH, crop: "limit" }]
    });
}

module.exports = { isCloudinaryConfigured, uploadImageBytes, PRODUCTS_FOLDER };