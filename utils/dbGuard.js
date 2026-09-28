// ===============================
// DB SAFETY GUARD (AUD-01)
// ===============================
// Standalone helper that stops seed / test scripts from ever connecting to
// the production database. It only inspects URIs; it never connects anywhere.
//
// Allowed by default:
//   - a LOCAL mongod (host = 127.0.0.1 / localhost / ::1) - the developer's
//     own machine is the intended sandbox, whatever the database name;
//   - a dedicated isolated database whose name matches the `fm_*_e2e_*`
//     pattern used by the part13/14/15 E2E suites.
//
// Refused by default (script is terminated before any write):
//   - the production database name "freshmart" (whatever the cluster);
//   - any other remote/unrecognised database.
//
// An operator who deliberately needs to write to prod must set FM_DB_FORCE=1,
// which prints a loud banner and lets the URI through. No silent fallback.
// ===============================

function classifyUri(uri) {
    if (!uri || typeof uri !== "string") return null;
    let parsed;
    try {
        parsed = new URL(String(uri).trim());
    } catch (e) {
        return null;
    }
    if (parsed.protocol !== "mongodb:" && parsed.protocol !== "mongodb+srv:") {
        return null;
    }
    const host = String(parsed.hostname || "").replace(/^\[|\]$/g, "");
    const db = (parsed.pathname || "").replace(/^\//, "").split("/")[0] || "";
    const creds = parsed.username || parsed.password
        ? (parsed.username || "user") + ":****@"
        : "";
    const masked = parsed.protocol + "//" + creds + host +
        (parsed.port ? ":" + parsed.port : "") + "/" + (db || "<no-db>");
    return {
        host: host,
        db: db,
        port: parsed.port ? Number(parsed.port) : null,
        protocol: parsed.protocol,
        masked: masked,
        isLocal: host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0",
    };
}

const BLOCKED_DATABASES = {
    freshmart: "this repository's production database",
    production: "generic production database",
    prod: "generic production database",
};

function refuse(code, info, extraLines) {
    console.error("");
    console.error("┌──────────────────────────────────────────────────────────────────────────┐");
    console.error("│  DB SAFETY GUARD — run refused (" + code + ")                              │");
    try {
        console.error("│  target : " + (info.masked || String(info)));
    } catch (e) {
        console.error("│  target : (unusable URI)");
    }
    console.error("──────────────────────────────────────────────────────────────────────────");
    if (extraLines) {
        extraLines.forEach(function (line) { console.error("  " + line); });
    }
    console.error("  Fix: run against a LOCAL mongod (mongodb://127.0.0.1:27017/<db>) or a");
    console.error("       dedicated isolated DB named fm_<purpose>_e2e_<random>, which the");
    console.error("       part13/14/15 E2E suites use and drop when they exit.");
    console.error("  Deliberate prod write?  set FM_DB_FORCE=1 (prints a banner, then allows).");
    console.error("└──────────────────────────────────────────────────────────────────────────┘");
    console.error("");
    process.exit(1);
}

// Returns `uri` when it is safe to connect to, otherwise prints the refusal
// banner and terminates the process. `opts` is { purpose } (or a plain string).
function assertSafeDbUri(uri, opts) {
    const purpose = opts && typeof opts === "object" ? opts.purpose : opts;
    const label = purpose ? String(purpose) : "script";
    const info = classifyUri(uri);
    if (!info) {
        refuse("BAD_URI", uri, ["Script: " + label + ". Could not parse the MongoDB URI."]);
    }

    if (info.isLocal) {
        return uri;
    }

    const forced = process.env.FM_DB_FORCE === "1" || process.env.FM_DB_FORCE === "true";
    if (forced) {
        console.error("");
        console.error("════ PRODUCTION / FORCED DB WRITE ENABLED (FM_DB_FORCE=1) ════");
        console.error("  " + label + " is about to write " + info.masked);
        console.error("  This is an explicit operator override. Accept full responsibility.");
        console.error("══════════════════════════════════════════════════════════════════");
        console.error("");
        return uri;
    }

    if (Object.prototype.hasOwnProperty.call(BLOCKED_DATABASES, info.db)) {
        refuse("PROD_DB", info, [
            "Script: " + label + ".",
            "Database '" + info.db + "' is " + BLOCKED_DATABASES[info.db] + ". A helper",
            "script must never open it; this is exactly the AUD-01 hazard.",
        ]);
    }

    if (/^fm_.*_e2e_[0-9]+$/.test(info.db)) {
        return uri;
    }

    refuse("UNKNOWN_DB", info, [
        "Script: " + label + ".",
        "Remote database '" + info.db + "' is not recognised as a dedicated isolated",
        "test DB (fm_<purpose>_e2e_<random>). Refusing to write data there.",
    ]);
    return uri;
}

module.exports = { classifyUri: classifyUri, assertSafeDbUri: assertSafeDbUri };