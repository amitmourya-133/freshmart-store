// ===============================
// OTP UTILITIES
// 6-digit cryptographically secure OTP with hashed storage only.
// ===============================

const crypto = require("crypto");

const OTP_TTL_MS = 5 * 60 * 1000;                 // 5 minute validity
const OTP_MAX_ATTEMPTS = 5;                       // max failed verifications
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;         // 60s resend cooldown

// Cryptographically secure 6-digit OTP (crypto.randomInt, no Math.random).
function generateOtp() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

// Only the SHA-256 hash is ever persisted. The plain OTP never touches the DB.
function hashOtp(otp) {
    return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

// Constant-time comparison against the stored hash.
function otpMatches(otp, storedHash) {
    const candidate = Buffer.from(hashOtp(String(otp)), "hex");
    const stored = Buffer.from(String(storedHash || ""), "hex");
    if (candidate.length !== stored.length) return false;
    return crypto.timingSafeEqual(candidate, stored);
}

function isOtpExpired(expiry) {
    if (!expiry) return true;
    return new Date(expiry).getTime() <= Date.now();
}

module.exports = {
    OTP_TTL_MS,
    OTP_MAX_ATTEMPTS,
    OTP_RESEND_COOLDOWN_MS,
    generateOtp,
    hashOtp,
    otpMatches,
    isOtpExpired
};