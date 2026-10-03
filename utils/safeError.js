// ===============================
// SAFE ERROR SURFACING (SEC-04)
// Single authority for what an internal failure is allowed to tell a client.
//
// Before this module ~160 handlers answered with `error.message`, which for a
// Mongo/Mongoose failure is the DRIVER's text. Those messages leak collection
// names, index names, field paths and query shapes (for example
// "E11000 duplicate key error collection: freshmart.users index: email_1"),
// which turns any 500 into a schema/infra oracle for an attacker.
//
// Rules implemented here:
//   * A client-authored 4xx keeps its own message. Those are written by us on
//     purpose ("Product unavailable", "Insufficient wallet balance") and the UI
//     depends on them.
//   * EVERYTHING else becomes a generic sentence. A driver error, a cast error,
//     a validation error, a TypeError or any unexpected throw never reaches the
//     client.
//   * The real error is still logged server-side (utils/logger) with its stack,
//     so operators keep full diagnostics.
//
// This module never logs and never touches the database: it is a pure function
// of the error object.
// ===============================

const GENERIC_500 = "Something went wrong. Please try again.";

// Markers that identify an error raised by the database/driver layer rather
// than by our own validation code.
const DRIVER_NAMES = new Set([
    "MongoServerError",
    "MongoError",
    "MongoNetworkError",
    "MongoServerSelectionError",
    "MongoParseError",
    "MongoNotConnectedError",
    "MongooseError",
    "MongooseServerSelectionError",
    "ValidationError",
    "CastError",
    "StrictModeError",
    "DocumentNotFoundError",
    "AggregateError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
]);

// HTTP statuses we are willing to pass through from an app-thrown error.
function passthroughStatus(status) {
    const n = Number(status);
    return Number.isInteger(n) && n >= 400 && n <= 499;
}

// True when the error is (or wraps) a database/driver failure.
function isDriverError(err) {
    if (!err) return false;
    if (typeof err === "string") return true;
    if (DRIVER_NAMES.has(err.name)) return true;
    // Mongo server codes (duplicate key, validation, bad value, ...)
    if (typeof err.code === "number" && err.code >= 10000 && err.code <= 10999) return true;
    if (err.name === "MongoServerError" || err.name === "MongoBulkWriteError") return true;
    // Mongoose wraps driver errors one level down.
    if (err.error && typeof err.error === "object" && err.error.name && DRIVER_NAMES.has(err.error.name)) return true;
    return false;
}

// The client-visible message for an internal error.
// `fallback` lets a caller keep its own 500 wording when it has one.
function safeErrorMessage(err, fallback) {
    const generic = fallback || GENERIC_500;

    // Plain thrown literals such as { status: 400, message: "..." } (used by the
    // shared coupon/pricing helpers) carry no name and no stack.
    if (err && typeof err === "object" && passthroughStatus(err.status) && typeof err.message === "string" && err.message) {
        return err.message;
    }

    // A plain `throw { status, message }` literal has no stack; trust it.
    if (err && typeof err === "object" && passthroughStatus(err.status) && !err.stack) {
        return err.message || generic;
    }

    if (isDriverError(err)) return generic;

    // Our own Error with an explicit 4xx status: intentional customer wording.
    if (err instanceof Error && passthroughStatus(err.status)) return err.message;

    // Everything else is an unexpected failure: stay silent.
    return generic;
}

// The HTTP status to answer with.
function safeErrorStatus(err, fallbackStatus) {
    const fb = Number(fallbackStatus) || 500;
    if (err && passthroughStatus(err.status)) return Number(err.status);
    // A driver/dup-key failure is a genuine server-side conflict, not a 400:
    // reporting 400 would tell an attacker their probe changed server state.
    if (isDriverError(err)) return fb;
    return fb;
}

// Compact, secret-free log entry for an internal error. Never includes the
// request body, headers, cookies or authorization values.
function errorLogEntry(err, context) {
    const entry = {
        ev: "internal_error",
        where: context || null,
        kind: (err && err.name) || typeof err,
    };
    if (err && err.code != null) entry.code = err.code;
    if (err && err.message) entry.msg = String(err.message).slice(0, 300);
    return entry;
}

module.exports = {
    GENERIC_500,
    safeErrorMessage,
    safeErrorStatus,
    isDriverError,
    errorLogEntry,
};