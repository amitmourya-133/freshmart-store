// ===============================
// EMAIL SERVICE
// SMTP delivery layer (env-configured). Never logs message bodies / OTPs.
// ===============================

const nodemailer = require("nodemailer");

// SMTP settings come ONLY from environment variables — never hardcoded.
function transporterFor() {
    if (process.env.SMTP_HOST) {
        const secure = /^true$/i.test(String(process.env.SMTP_SECURE || ""));
        return nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: Number(process.env.SMTP_PORT || (secure ? 465 : 587)),
            secure: secure,
            auth: process.env.SMTP_USER
                ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
                : undefined
        });
    }
    // Legacy Gmail configuration (EMAIL_USER / EMAIL_PASS)
    if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
        return nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
    }
    return null;
}

function isEmailConfigured() {
    return Boolean(process.env.SMTP_HOST || (process.env.EMAIL_USER && process.env.EMAIL_PASS));
}

function fromAddress() {
    if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
    return process.env.EMAIL_USER || process.env.SMTP_USER || "FreshMart <no-reply@freshmart.local>";
}

// Send an HTML email. Resolves { sent:true } on success, { sent:false } when no SMTP
// is configured (delivery silently skipped — the response never reveals secrets).
async function sendMail({ to, subject, html }) {
    const transporter = transporterFor();
    if (!transporter) return { sent: false };
    try {
        await transporter.sendMail({
            from: fromAddress(),
            to,
            subject,
            html
        });
        return { sent: true };
    } catch (error) {
        // SMTP failure is swallowed on purpose: we never leak OTP / credentials.
        // The OTP hash still exists server-side and verification stays possible
        // only for the owner of the mailbox who received it (or a test harness).
        return { sent: false };
    }
}

module.exports = { sendMail, isEmailConfigured };