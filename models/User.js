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
        role: { type: String, enum: ["customer", "admin", "delivery", "b2b_customer"], default: "customer" },
        // Preferred interface language (customer-facing UI). Stored server-side
        // so the preference is real and persists across devices, with a
        // localStorage mirror for guests. Never includes private data.
        language: { type: String, enum: ["en", "hi"], default: "en" },
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
        // AUD-19: timestamp of the last password change. The auth middleware
        // rejects any JWT minted before this moment (credential pinning), so a
        // leaked/old token stops working the instant the password is changed.
        // null for accounts that have never set a password - no pin applies.
        pwdChangedAt: { type: Date, default: null },
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
        // Partner onboarding (Phase 1). A customer applies, an admin approves,
        // and ONLY an approved partner can receive broadcast offers. role stays
        // "customer" until approval, so an unapproved applicant can never reach
        // any delivery-only endpoint.
        partnerStatus: {
            type: String,
            enum: ["none", "pending", "approved", "rejected"],
            default: "none",
        },
        partnerAppliedAt: { type: Date },
        partnerReviewedAt: { type: Date },
        partnerReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        partnerRejectReason: { type: String, trim: true, maxlength: 160 },
        vehicleType: { type: String, trim: true, maxlength: 40 },
        // Optional delivery zone the partner prefers (used to rank offers).
        zone: { type: String, trim: true, maxlength: 60 },
        // Set while the partner is on a break; cleared when they go back online.
        breakReason: { type: String, trim: true, maxlength: 80 },
        // Reputation counters kept server-side (never client-asserted).
        rating: { type: Number, default: 0, min: 0, max: 5 },
        ratingCount: { type: Number, default: 0, min: 0 },
        deliveryCount: { type: Number, default: 0, min: 0 },
        // Referral program: the account's own shareable code (FM-plus-characters,
        // generated on demand) and the referrer who brought this account in.
        // referredBy is immutable once set (see referralController validation).
        // The unique index is partial: only documents that actually carry a code
        // are constrained, so the many nulls on accounts without a code coexist.
        referralCode: {
            type: String,
            trim: true,
            uppercase: true,
            default: null,
            index: { unique: true, partialFilterExpression: { referralCode: { $type: "string" } } }
        },
        referredBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
        referredAt: { type: Date, default: null },
        // Customer preference: never send repeat-order reminder notifications.
        reminderOptOut: { type: Boolean, default: false },
        // WhatsApp order-update opt-in (Phase 2.5). Opt-in is explicit and
        // revocable; updates are only sent when this is true AND a provider is
        // configured (utils/whatsapp.js). Never implied by signup.
        whatsappOptIn: { type: Boolean, default: false },
        whatsappPhone: { type: String, trim: true, match: [/^[6-9]\d{9}$/, "WhatsApp number must be a valid 10-digit Indian mobile"] },
        whatsappOptInAt: { type: Date, default: null },
        // B2B supply account (Phase 3.7). Only present for role "b2b_customer".
        // Credit is a deliberate, admin-controlled facility - it is never
        // auto-granted and its limit/terms are set via the admin tools only.
        b2bProfile: {
            bool: { type: Boolean, default: false },
            businessName: { type: String, trim: true, maxlength: 120 },
            gstin: { type: String, trim: true, uppercase: true, match: [/^[0-9A-Z]{15}$/, "GSTIN must be 15 characters"] },
            purchaseOfficer: { type: String, trim: true, maxlength: 120 },
        },
        creditLimit: { type: Number, default: 0, min: 0 },
        creditTermsDays: { type: Number, default: 0, min: 0, max: 180 },
        b2bApproved: { type: Boolean, default: false },
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

// Hash password before saving; record the time it changed so auth middleware
// can pin JWTs to the credential version (AUD-19).
userSchema.pre("save", async function (next) {
    if (this.isModified("password") && this.password) {
        this.pwdChangedAt = new Date();
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
    }
    next();
});

// Compare password method
userSchema.methods.matchPassword = async function (enteredPassword) {
    if (!this.password) return false;
    return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model("User", userSchema);
