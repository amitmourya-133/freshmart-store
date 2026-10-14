// ===============================
// LOCAL SMTP SINK (test support)
//
// Captures outbound mail on 127.0.0.1 so a test can read the OTP the
// application really sends. It exists because the app builds its Nodemailer
// transport from SMTP_HOST / SMTP_PORT at startup, so a test that wants to
// observe a real email must be running BEFORE the server starts.
//
// Guarantees:
//   - binds 127.0.0.1 only, so nothing can reach the internet;
//   - accepts any AUTH (there is nothing to authenticate against);
//   - persists each message to disk so a separate test process can read it;
//   - never logs message bodies (they can contain OTPs).
// ===============================

"use strict";

const net = require("net");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Start the sink.
 * @param {{port?: number, dir?: string}} [opts]
 * @returns {Promise<{port:number, dir:string, count:()=>number, close:()=>Promise<void>}>}
 */
function startSmtpSink(opts) {
    const options = opts || {};
    const dir = options.dir || fs.mkdtempSync(path.join(os.tmpdir(), "freshmart-smtp-"));
    fs.mkdirSync(dir, { recursive: true });

    let received = 0;
    let sockets = new Set();

    const server = net.createServer(function (sock) {
        sockets.add(sock);
        let inData = false;
        let data = "";
        let authStep = 0;
        let buf = "";

        const reply = function (line) { sock.write(line + "\r\n"); };
        reply("220 localhost ESMTP FreshMartTestSink");

        sock.on("error", function () { /* client hung up */ });
        sock.on("close", function () { sockets.delete(sock); });

        sock.on("data", function (chunk) {
            buf += chunk.toString("binary");
            let nl;
            while ((nl = buf.indexOf("\r\n")) !== -1) {
                const line = buf.slice(0, nl);
                buf = buf.slice(nl + 2);

                if (inData) {
                    if (line === ".") {
                        inData = false;
                        received += 1;
                        // Persist so another process can read it. No console output.
                        fs.writeFileSync(path.join(dir, received + ".eml"), data, "binary");
                        data = "";
                        reply("250 2.0.0 Ok: queued");
                    } else {
                        data += (line.startsWith("..") ? line.slice(1) : line) + "\n";
                    }
                    continue;
                }

                const cmd = line.toUpperCase();
                if (cmd.startsWith("EHLO")) {
                    // No STARTTLS advertised: the test transport stays plaintext.
                    reply("250-localhost");
                    reply("250-AUTH PLAIN LOGIN");
                    reply("250-8BITMIME");
                    reply("250 SIZE 10485760");
                } else if (cmd.startsWith("HELO")) {
                    reply("250 localhost");
                } else if (cmd.startsWith("AUTH PLAIN")) {
                    reply("235 2.7.0 Authentication successful");
                } else if (cmd === "AUTH LOGIN") {
                    authStep = 1;
                    reply("334 " + Buffer.from("Username:").toString("base64"));
                } else if (authStep === 1) {
                    authStep = 2;
                    reply("334 " + Buffer.from("Password:").toString("base64"));
                } else if (authStep === 2) {
                    authStep = 0;
                    reply("235 2.7.0 Authentication successful");
                } else if (cmd.startsWith("MAIL FROM")) {
                    reply("250 2.1.0 Ok");
                } else if (cmd.startsWith("RCPT TO")) {
                    reply("250 2.1.5 Ok");
                } else if (cmd === "DATA") {
                    inData = true;
                    data = "";
                    reply("354 End data with <CR><LF>.<CR><LF>");
                } else if (cmd === "RSET" || cmd === "NOOP") {
                    reply("250 2.0.0 Ok");
                } else if (cmd === "QUIT") {
                    reply("221 2.0.0 Bye");
                    sock.end();
                } else {
                    reply("250 2.0.0 Ok");
                }
            }
        });
    });

    return new Promise(function (resolve, reject) {
        server.once("error", reject);
        server.listen(options.port || 0, "127.0.0.1", function () {
            resolve({
                port: server.address().port,
                dir: dir,
                count: function () { return received; },
                close: function () {
                    return new Promise(function (done) {
                        sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
                        server.close(function () { done(); });
                    });
                }
            });
        });
    });
}

/**
 * Pull the 6-digit OTP out of a delivered message.
 * Tries the raw body, then a quoted-printable-cleaned copy, then a
 * base64-decoded copy, then falls back to the HTML-stripped text.
 * @param {string} raw
 * @returns {string|null}
 */
function extractOtp(raw) {
    if (!raw) return null;
    const candidates = [raw, raw.replace(/=\r\n/g, "")];
    const b64 = raw.match(/Content-Transfer-Encoding:\s*base64\r?\n\r?\n([\s\S]+)$/i);
    if (b64) {
        try { candidates.push(Buffer.from(b64[1].replace(/\s+/g, ""), "base64").toString("binary")); }
        catch (e) { /* ignore */ }
    }
    for (const text of candidates) {
        const plain = text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");
        const m = plain.match(/\b\d{6}\b/);
        if (m) return m[0];
    }
    return null;
}

/**
 * Wait for an OTP addressed to `recipient`, reading messages the sink wrote.
 * @param {string} dir
 * @param {string} recipient
 * @param {{timeoutMs?: number, afterSeq?: number}} [opts]
 * @returns {Promise<string|null>}
 */
async function waitForOtp(dir, recipient, opts) {
    const options = opts || {};
    const timeoutMs = options.timeoutMs || 20000;
    const afterSeq = options.afterSeq || 0;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        let files = [];
        try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".eml")); } catch (e) { files = []; }
        files.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        for (const f of files) {
            const seq = parseInt(f, 10);
            if (seq <= afterSeq) continue;
            let raw = "";
            try { raw = fs.readFileSync(path.join(dir, f), "binary"); } catch (e) { continue; }
            if (recipient && raw.toLowerCase().indexOf(String(recipient).toLowerCase()) === -1) continue;
            const otp = extractOtp(raw);
            if (otp) return otp;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    return null;
}

module.exports = { startSmtpSink: startSmtpSink, extractOtp: extractOtp, waitForOtp: waitForOtp };