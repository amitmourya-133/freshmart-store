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
        // Never log the SMTP password, username or any secret. A transport-level
        // error is intentionally swallowed (delivery failure is reported to the
        // caller alongside a SAFE diagnostic). Only a sanitized failure code
        // (e.g. EAUTH / 535 / ETIMEDOUT) and a non-secret hint are exposed -
        // never the underlying SMTP response text.
        const errCode = err ? (err.code || err.name) : "unknown";
        const responseCode = err ? (err.responseCode !== undefined && err.responseCode !== null ? err.responseCode : undefined) : undefined;
        const code = responseCode !== undefined ? String(responseCode) : errCode;
        return {
            sent: false,
            reason: "smtp_error",
            code: code,
            hint: smtpHint(code)
        };
    }
}

// Map a sanitized SMTP error code to a human, NON-SECRET hint so the log line
// tells the operator which failure class occurred without leaking credentials
// or the mail server's response body.
function smtpHint(code) {
    const c = String(code || "").toUpperCase();
    if (c === "EAUTH" || c === "535" || c.indexOf("535") === 0) return "credentials-rejected-by-server";
    if (c === "EENVELOPE") return "invalid-recipient-address";
    if (c === "EMESSAGE") return "invalid-email-message";
    if (c === "ETLS") return "tls-not-negotiated";
    if (c.indexOf("ECONN") === 0) return "cannot-connect-to-mail-server";
    if (c === "ETIMEDOUT" || c.indexOf("ESOCKET") === 0) return "connection-timed-out";
    if (c.indexOf("TLS") >= 0 || c.indexOf("CERT") >= 0 || c.indexOf("DEPTH") >= 0) return "tls-certificate-error";
    return "other-smtp-error";
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

// ===============================
// ORDER NOTIFICATION EMAILS
// Reuse the same SMTP/Gmail infrastructure as the OTP emails. Never includes
// OTPs, passwords, tokens or payment secrets. Delivery failures are swallowed
// and surfaced only as { sent: false } so an email problem never breaks an
// otherwise successful order.
// ===============================

function indianDate(d) {
    try {
        return new Date(d || Date.now()).toLocaleString("en-IN", {
            day: "2-digit", month: "short", year: "numeric",
            hour: "2-digit", minute: "2-digit"
        });
    } catch (e) {
        return "";
    }
}

function inr(n) {
    const v = Number(n) || 0;
    return "₹" + v.toLocaleString("en-IN");
}

// Compact, table-free order lines used inside every order email.
function orderItemsHtml(order) {
    const items = (order && order.items) || [];
    if (!items.length) return "<p>No items.</p>";
    let rows = "";
    items.forEach(function (i) {
        const qty = i.quantity || 1;
        const line = (i.name || "Item") + " × " + qty;
        rows += '<tr><td style="padding:6px 8px;border-bottom:1px solid #ececec;color:#333;">' + line + '</td>' +
            '<td style="padding:6px 8px;border-bottom:1px solid #ececec;color:#333;text-align:right;">' + inr((i.price || 0) * qty) + '</td></tr>';
    });
    return '<table style="width:100%;border-collapse:collapse;margin:12px 0;">' + rows + '</table>';
}

// Wrapper: shared email shell (subject + body builder). Returns the sendEmail result.
async function sendOrderEmail({ to, subject, title, bodyHtml, order }) {
    const recipient = String((to || "").trim());
    if (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
        return { sent: false, reason: "no_recipient" };
    }
    const totals = [
        ["Subtotal", inr(order.subtotal)],
        ["Delivery Charge", order.delivery > 0 ? inr(order.delivery) : "FREE"],
        ["Discount", (order.discount || 0) > 0 ? "− " + inr(order.discount) : "—"],
        ["Total", inr(order.total)]
    ];
    if (order.couponCode) totals.splice(totals.length - 1, 0, ["Coupon", order.couponCode]);
    let totalsRows = "";
    totals.forEach(function (row) {
        totalsRows += '<tr><td style="padding:4px 8px;color:#666;font-size:14px;">' + row[0] + '</td>' +
            '<td style="padding:4px 8px;color:' + (row[0] === "Total" ? "#0f6e33" : "#333") + ';font-size:' + (row[0] === "Total" ? "17px" : "14px") + ';font-weight:' + (row[0] === "Total" ? "bold" : "normal") + ';text-align:right;">' + row[1] + '</td></tr>';
    });
    const ref = order.trackingId || order.orderNumber || "";
    const html =
        '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;border:1px solid #e4e4e4;border-radius:12px;">' +
        '<h2 style="color:#159447;margin:0 0 4px;">🥬 FreshMart</h2>' +
        '<p style="color:#333;font-size:15px;font-weight:bold;margin:10px 0 2px;">' + title + '</p>' +
        '<p style="color:#777;font-size:13px;margin:0 0 12px;">Order ' + (order.orderNumber || "") +
        (ref ? ' • Tracking: <strong>' + ref + '</strong>' : '') +
        ' • ' + indianDate(order.createdAt) + '</p>' +
        '<p style="color:#333;font-size:14px;">Status: <strong>' + (order.status || "Placed") + '</strong> &nbsp;•&nbsp; Payment: ' +
        (order.payment || "Cash On Delivery") + ' (' + (order.paymentStatus || "PENDING") + ')</p>' +
        orderItemsHtml(order) +
        '<table style="width:100%;border-collapse:collapse;">' + totalsRows + '</table>' +
        bodyHtml +
        '<p style="color:#999;font-size:12px;margin-top:18px;">Need help? Reply to this email or visit the FreshMart store. Do not share your order reference with strangers.</p>' +
        '</div>';
    return sendEmail({ to: recipient, subject: subject, html: html });
}

// A. Order confirmation (sent after a successful order is persisted).
async function sendOrderConfirmation({ to, order }) {
    return sendOrderEmail({
        to: to,
        order: order,
        subject: "Order Confirmed - FreshMart #" + (order.orderNumber || ""),
        title: "✅ Your order has been confirmed!",
        bodyHtml: '<p style="color:#333;font-size:14px;">Thank you for shopping with FreshMart. We have received your order and will update its status as it moves towards delivery.</p>'
    });
}

// B. General status change notification (Placed/Confirmed/Packing→Preparing/Out for Delivery).
async function sendOrderStatusUpdate({ to, order, previousStatus }) {
    return sendOrderEmail({
        to: to,
        order: order,
        subject: "Order " + (order.status || "") + " - FreshMart #" + (order.orderNumber || ""),
        title: "🚚 Your order status has changed",
        bodyHtml: '<p style="color:#333;font-size:14px;">Your order status changed from <strong>' + (previousStatus || "") + '</strong> to <strong>' + (order.status || "") + '</strong>.</p>' +
            '<p style="color:#666;font-size:13px;">You can track the latest status anytime on the FreshMart Orders page and the order tracking section.</p>'
    });
}

// C. Dedicated delivery confirmation (sent only once when status becomes Delivered).
async function sendDeliveryConfirmation({ to, order }) {
    return sendOrderEmail({
        to: to,
        order: order,
        subject: "Delivered - FreshMart #" + (order.orderNumber || ""),
        title: "📦 Your order has been delivered!",
        bodyHtml: '<p style="color:#333;font-size:14px;">Your FreshMart order has been delivered to the provided address. Enjoy your fresh produce!</p>' +
            '<p style="color:#666;font-size:13px;">If everything looks good, a review helps other customers. If anything is wrong, please reach out and we will sort it out.</p>'
    });
}

module.exports = { sendOtpEmail, sendEmail, sendOrderConfirmation, sendOrderStatusUpdate, sendDeliveryConfirmation, smtpHint };