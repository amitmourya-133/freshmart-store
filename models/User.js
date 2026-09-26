// ===============================
// USER MODEL
// ===============================

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
    {
        name: { type: String, trim: true },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        phone: { type: String, trim: true },
        password: { type: String },
        role: { type: String, enum: ["customer", "admin", "delivery"], default: "customer" },
        // OTP email-verification state. Only the SHA-256 hash is stored,
        // never the plain OTP.
        otpHash: { type: String },
        otpExpiry: { type: Date },
        otpAttempts: { type: Number, default: 0 },
        otpResendAt: { type: Date },
        // Password-reset OTP (same hashed-only storage discipline as login OTP)
        resetOtpHash: { type: String },
        resetOtpExpiry: { type: Date },
        resetOtpAttempts: { type: Number, default: 0 },
        resetOtpResendAt: { type: Date },
        // Short-lived single-use authorization granted AFTER a successful reset OTP verify
        resetTokenHash: { type: String },
        resetTokenExpiry: { type: Date },
        googleId: { type: String },
        // Email verification status. Defaults to true so pre-existing accounts
        // (which have no field at all) keep logging in as before. Only newly
        // created signup accounts start as emailVerified: false until their
        // signup OTP is confirmed.
        emailVerified: { type: Boolean, default: true },
        isAdmin: { type: Boolean, default: false },
        // Delivery-partner availability + last known location (opt-in sharing)
        isAvailable: { type: Boolean, default: false },
        lastLat: { type: Number },
        lastLng: { type: Number },
        lastLocationAt: { type: Date },
        // Saved addresses for checkout and profile
        addresses: [{
            name: { type: String, trim: true },
            phone: { type: String, trim: true },
            house: { type: String, trim: true },
            street: { type: String, trim: true },
            landmark: { type: String, trim: true },
            city: { type: String, trim: true },
            state: { type: String, trim: true },
            pincode: { type: String, match: [/^\d{6}$/, "Pincode must be 6 digits"] },
            deliveryInstructions: { type: String, trim: true },
            isDefault: { type: Boolean, default: false }
        }],
    },
    { timestamps: true }
);

// Hash password before saving
userSchema.pre("save", async function (next) {
    if (!this.isModified("password") || !this.password) return next();
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
});

// Compare password method
userSchema.methods.matchPassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
