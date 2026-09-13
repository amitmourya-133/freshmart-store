// ===============================
// EMAIL SERVICE (SMTP/Gmail)
// Used to deliver OTP emails for email verification and password reset.
// Credentials come ONLY from environment variables - never hardcoded.
// ===============================

const nodemailer = require("nodemailer");

let transporter = null;
let transportInitAttempted = false;

// Build a Nodemailer transport from the project's existing environment
// configuration. Supports two setups:
//   A) Generic SMTP:  SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS
//   B) Legacy Gmail:  EMAIL_USER, EMAIL_PASS   (app password)
// Returns null when no credentials are configured (email sending disabled).
function buildTransport() {
    const host = process.env.SMTP_HOST;
    const user = process.env.SMTP_USER || process.env.EMAIL_USER;
    const pass = process.env.SMTP_PASS || process.env.EMAIL_PASS;

    if ((!host && !user) || !pass) return null;

    if (host) {
        return nodemailer.createTransport({
            host: host,
            port: Number(process.env.SMTP_PORT) || 587,
            secure: String(process.env.SMTP_SECURE).toLowerCase() === "true",
            auth: { user: user, pass: pass }
        });
    }

    // Legacy Gmail App-Password transport (Gmail SMTP).
    return nodemailer.createTransport({
        service: "gmail",
        auth: { user: user, pass: pass }
    });
}

function getTransport() {
    if (!transportInitAttempted) {
        transport = buildTransport();
        transportInitAttempted = true;
    }
    return transport;
}

// Minimal runtime guard so an invalid/misconfigured SMTP transport never
// crashes the request handler - email delivery problems are surfaced via the
// returned { sent: false } flag, never as unhandled exceptions.
async function sendEmail({ to, subject, html }) {
    const tr = getTransport();
    if (!tr) return { sent: false, reason: "email_not_configured" };

    const fromName = process.env.EMAIL_FROM_NAME || "FreshMart";
    const fromAddr = process.env.EMAIL_FROM || process.env.SMTP_USER || process.env.EMAIL_USER || "";
    const from = fromAddr ? `"${fromName}" <${fromAddr}>` : fromName;

    try {
        const info = await tr.sendMail({
            from: from,
            to: String(to || "").trim(),
            subject: subject,
            html: html
        });
        return { sent: true, messageId: info ? info.messageId : "" };
    } catch (err) {
        // Never log the SMTP password or any secret. A transport-level error
        // is intentionally swallowed (delivery failure is reported to the caller).
        return { sent: false, reason: "smtp_error" };
    }
}

// Send a 6-digit OTP email to the user. The OTP is only used to build the
// message body - it is never logged or returned by any API.
async function sendOtpEmail({ to, otp, purpose }) {
    const label = purpose === "reset" ? "reset your FreshMart password" : "verify your FreshMart account";
    const subject = purpose === "reset"
        ? "FreshMart Password Reset OTP"
        : "FreshMart Account Verification OTP";

    const html =
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;padding:24px;border:1px solid #e4e4e4;border-radius:12px;">' +
        '<h2 style="color:#159447;margin:0 0 6px;">🥬 FreshMart</h2>' +
        '<p style="color:#333;font-size:15px;">Your One-Time Password (OTP) to ' + label + ':</p>' +
        '<p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#0f6e33;margin:14px 0;background:#f2fbf4;padding:10px 14px;border-radius:8px;text-align:center;">' + otp + '</p>' +
        '<p style="color:#666;font-size:13px;">This OTP is valid for <strong>5 minutes</strong>. Do not share it with anyone.</p>' +
        '<p style="color:#999;font-size:12px;margin-top:16px;">If you did not request this, you can safely ignore this email.</p>' +
        '</div>';

    return sendEmail({ to: to, subject: subject, html: html });
}

module.exports = { sendOtpEmail, sendEmail };