// ===============================
// OTP HELPERS (shared)
// The 4-digit delivery-completion OTP and the login/signup OTPs must behave
// identically everywhere, so the generation, hashing and constant-time
// comparison live in one place. Only the SHA-256 HASH is ever stored - the
// plain OTP exists solely in the email that carries it.
// ===============================

const crypto = require("crypto");

// 4-digit OTP, cryptographically random (no Math.random).
function generateOtp(digits) {
    const len = Number(digits) > 0 ? Number(digits) : 4;
    const min = Math.pow(10, len - 1);
    const max = Math.pow(10, len) - 1;
    return String(crypto.randomInt(min, max + 1)).padStart(len, "0");
}

function hashOtp(otp) {
    return crypto.createHash("sha256").update(String(otp)).digest("hex");
}

// Length-safe, timing-safe string comparison (never leaks the OTP by timing).
function otpSafeEqual(a, b) {
    const ba = Buffer.from(String(a), "utf8");
    const bb = Buffer.from(String(b), "utf8");
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

module.exports = { generateOtp, hashOtp, otpSafeEqual };
