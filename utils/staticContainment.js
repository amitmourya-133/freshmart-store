// ===============================
// STATIC ROOT CONTAINMENT HELPER
// ===============================
// Version-independent backstop for symlink/junction escapes in the static
// file guard. `send`/`serve-static` follow reparse points by default and
// expose no disable option in the installed versions, so the guard resolves
// the candidate's real path and rejects anything that lands outside the
// serving root. Exported so the DB-free regression suite can exercise the
// real production logic against a temporary fixture root.

const path = require("path");
const fs = require("fs");

function isWithinStaticRoot(root, decoded) {
    const candidate = path.resolve(root, "." + decoded);
    let resolved;
    try {
        resolved = fs.realpathSync(candidate);
    } catch (e) {
        // Missing file or any filesystem error: never allow through merely
        // because realpath failed.
        return false;
    }
    const rel = path.relative(root, resolved);
    if (rel === "") return true;
    if (rel.startsWith("..")) return false;
    if (path.isAbsolute(rel)) return false;
    return true;
}

module.exports = { isWithinStaticRoot };