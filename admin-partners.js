// ===============================
// DELIVERY OPERATIONS — ADMIN PANEL
// Adds the operations console to the Delivery tab: partner applications and
// approvals, the live broadcast offer log, the delivery-operations switches,
// and the day-end COD cash reconciliation sheet (Phase 6).
//
// Design rules:
//  * The server decides who may deliver. Approving here is the ONLY way a
//    customer becomes a partner.
//  * Nothing here is destructive by accident: revoking a partner or pruning
//    dead push endpoints always asks first.
// ===============================

(function () {
    "use strict";

    var state = { ops: null, partners: [], applicants: [], offers: [], timers: [] };

    function base() {
        return (typeof API !== "undefined" && API && API.base) ? API.base : "";
    }

    function headers() {
        return (typeof getAuthHeaders === "function") ? getAuthHeaders() : { "Content-Type": "application/json" };
    }

    function money(n) {
        return "₹" + Number(n || 0).toLocaleString("en-IN");
    }

    function esc(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function request(path, options) {
        var opts = options || {};
        return fetch(base() + path, {
            method: opts.method || "GET",
            headers: headers(),
            body: opts.body ? JSON.stringify(opts.body) : undefined
        }).then(function (res) {
            return res.json().catch(function () {
                return { success: false, message: "Unexpected server response." };
            });
        });
    }

    function notify(message, type) {
        if (typeof showToast === "function") return showToast(message, type || "info");
        if (typeof alert === "function") alert(message);
    }

    function stopTimers() {
        state.timers.forEach(function (t) { clearInterval(t); });
        state.timers = [];
    }

    // ---------- ops switches ----------

    function renderOps(payload) {
        var ops = payload.ops || state.ops || {};
        state.ops = ops;

        var summary = document.getElementById("opsSwitchSummary");
        if (summary) {
            summary.textContent =
                "Broadcast is " + (ops.broadcastEnabled ? "ON" : "OFF") +
                " · claim window " + (Number(ops.offerTtlSeconds) || 0) + "s" +
                " · auto-assign after " + (Number(ops.autoAssignDelaySeconds) || 0) + "s is " + (ops.autoAssign ? "ON" : "OFF") +
                " · OTP re-issue cap " + (Number(ops.maxOtpReissue) || 0) +
                " · partner location considered stale after " + (Number(ops.staleMinutes) || 0) + "m";
        }

        var host = document.getElementById("opsSettingsForm");
        if (!host) return;
        host.innerHTML = '' +
            '<label class="ops-switch"><input type="checkbox" id="opsBroadcastEnabled"' +
                (ops.broadcastEnabled ? " checked" : "") + "> <span>Broadcast new orders to online partners</span></label>" +
            '<label class="ops-field">Claim window (s) <input type="number" id="opsOfferTtl" min="15" max="900" value="' +
                (Number(ops.offerTtlSeconds) || 90) + '"></label>' +
            '<label class="ops-switch"><input type="checkbox" id="opsAutoAssign"' +
                (ops.autoAssign ? " checked" : "") + "> <span>Auto-assign the nearest partner when nobody claims</span></label>" +
            '<label class="ops-field">Auto-assign after (s) <input type="number" id="opsAutoAssignDelay" min="10" max="1800" value="' +
                (Number(ops.autoAssignDelaySeconds) || 90) + '"></label>' +
            '<label class="ops-field">OTP re-issue cap <input type="number" id="opsMaxOtpReissue" min="0" max="5" value="' +
                (Number(ops.maxOtpReissue) || 0) + '"></label>' +
            '<label class="ops-field">Stale location (min) <input type="number" id="opsStaleMinutes" min="1" max="240" value="' +
                (Number(ops.staleMinutes) || 15) + '"></label>' +
            '<button type="button" class="ops-btn ops-btn-accept" id="opsSaveSettings">Save settings</button>';

        var save = document.getElementById("opsSaveSettings");
        if (save) save.addEventListener("click", saveSettings);
    }

    function saveSettings() {
        var payload = {
            broadcastEnabled: document.getElementById("opsBroadcastEnabled").checked,
            autoAssign: document.getElementById("opsAutoAssign").checked,
            offerTtlSeconds: Number(document.getElementById("opsOfferTtl").value),
            autoAssignDelaySeconds: Number(document.getElementById("opsAutoAssignDelay").value),
            maxOtpReissue: Number(document.getElementById("opsMaxOtpReissue").value),
            staleMinutes: Number(document.getElementById("opsStaleMinutes").value)
        };
        request("/delivery-ops/admin/settings", { method: "PUT", body: payload }).then(function (d) {
            if (d && d.success) {
                renderOps(d);
                notify(d.message || "Delivery settings saved.", "success");
            } else {
                notify((d && d.message) || "Could not save the settings.", "error");
            }
        }).catch(function () { notify("Network error while saving.", "error"); });
    }

    // ---------- partners + applicants ----------

    function renderPartners(payload) {
        state.partners = Array.isArray(payload.partners) ? payload.partners : [];
        state.applicants = Array.isArray(payload.applicants) ? payload.applicants : [];
        state.offers = Array.isArray(payload.offersToday) ? payload.offersToday : [];

        var applicantHost = document.getElementById("opsApplicantList");
        if (applicantHost) {
            applicantHost.innerHTML = state.applicants.length
                ? state.applicants.map(function (a) {
                    return '<div class="ops-applicant">' +
                        '<div class="ops-applicant-info">' +
                            "<strong>" + esc(a.name || "Unnamed") + "</strong>" +
                            "<span>" + esc(a.email) + "</span>" +
                            "<span>Phone: " + esc(a.phone || "missing") + "</span>" +
                            (a.vehicleType ? "<span>Vehicle: " + esc(a.vehicleType) + "</span>" : "") +
                            (a.zone ? "<span>Zone: " + esc(a.zone) + "</span>" : "") +
                            "<span>Applied: " + esc(a.appliedAt ? new Date(a.appliedAt).toLocaleString() : "-") + "</span>" +
                            (a.rejectReason ? "<span>Last reason: " + esc(a.rejectReason) + "</span>" : "") +
                        "</div>" +
                        '<div class="ops-applicant-actions">' +
                            '<button type="button" class="ops-btn ops-btn-accept" data-review="approve" data-id="' + esc(a._id) + '">Approve</button>' +
                            '<button type="button" class="ops-btn ops-btn-decline" data-review="reject" data-id="' + esc(a._id) + '">Reject</button>' +
                        "</div></div>";
                    }).join("")
                : '<p class="ops-empty">No pending applications.</p>';
        }

        renderPartnerRoster();
        renderOffers();
    }

    function renderPartnerRoster() {
        var host = document.getElementById("opsPartnerRows");
        if (!host) return;
        if (!state.partners.length) {
            host.innerHTML = '<tr><td colspan="10" class="ops-empty">No approved delivery partners yet. Approve an application above to get started.</td></tr>';
            return;
        }
        host.innerHTML = state.partners.map(function (p) {
            var stateLabel = p.online ? '<span class="ops-chip chip-ok">Online</span>'
                : p.isAvailable ? '<span class="ops-chip chip-warn">Available, no GPS</span>'
                    : '<span class="ops-chip chip-off">' + (p.breakReason ? "Break: " + esc(p.breakReason) : "Offline") + "</span>";
            return "<tr>" +
                "<td>" + esc(p.name || "Unnamed") + "<br><small>" + esc(p.email) + "</small></td>" +
                "<td>" + (p.phone ? '<a href="tel:' + esc(p.phone) + '">' + esc(p.phone) + "</a>" : "-") + "</td>" +
                "<td>" + stateLabel + "</td>" +
                "<td>" + esc(p.active) + "</td>" +
                "<td>" + esc(p.delivered) + "</td>" +
                "<td>" + esc(p.deliveredToday) + "</td>" +
                "<td>" + money(p.earnings) + "</td>" +
                "<td>" + money(p.codExpected) + (p.cashMissing ? ' <span class="ops-flag-missing">' + p.cashMissing + " missing</span>" : "") + "</td>" +
                "<td>" + money(p.codCollected) + "</td>" +
                '<td><button type="button" class="ops-btn ops-btn-accept" data-force-assign="' + esc(p._id) + '">Assign order</button> ' +
                '<button type="button" class="ops-btn ops-btn-decline" data-review="revoke" data-id="' + esc(p._id) + '">Revoke</button></td>' +
                "</tr>";
        }).join("");
    }

    function review(id, action) {
        var body = { action: action };
        if (action === "reject") {
            var reason = window.prompt("Reason for rejecting this partner application?");
            if (reason === null) return;
            body.reason = String(reason || "").slice(0, 160);
        }
        if (action === "revoke" && !window.confirm("Remove this partner's delivery access? They will stop receiving orders immediately.")) return;

        request("/delivery-ops/admin/partners/" + encodeURIComponent(id) + "/review", { method: "POST", body: body })
            .then(function (d) {
                if (d && d.success) {
                    notify(d.message || "Partner updated.", "success");
                    refresh();
                } else {
                    notify((d && d.message) || "Could not update the partner.", "error");
                }
            })
            .catch(function () { notify("Network error.", "error"); });
    }

    function forceAssign(partnerId) {
        var orderId = window.prompt(
            "Order id to assign (leave empty to take the oldest unassigned order):",
            ""
        );
        if (orderId === null) return;
        var body = {};
        if (String(orderId).trim()) body.orderId = String(orderId).trim();
        request("/delivery-ops/admin/partners/" + encodeURIComponent(partnerId) + "/force-assign", { method: "POST", body: body })
            .then(function (d) {
                if (d && d.success) {
                    notify(d.message || "Order assigned.", "success");
                    refresh();
                } else {
                    notify((d && d.message) || "Could not assign the order.", "error");
                }
            })
            .catch(function () { notify("Network error.", "error"); });
    }

    // ---------- offer log ----------

    function renderOffers() {
        var host = document.getElementById("opsOfferRows");
        if (!host) return;
        if (!state.offers.length) {
            host.innerHTML = '<tr><td colspan="8" class="ops-empty">No broadcasts in the last 24 hours.</td></tr>';
            return;
        }
        host.innerHTML = state.offers.map(function (o) {
            var re = o.status !== "ASSIGNED" && o.status !== "CLAIMED"
                ? '<button type="button" class="ops-btn ops-btn-ghost" data-rebroadcast="' + esc(o.orderId) + '">Re-alert partners</button>'
                : "";
            return "<tr><td>" + esc(o.orderId) + "</td><td>" + esc(o.round) + "</td><td>" + esc(o.status) +
                "</td><td>" + esc(o.notified) + "</td><td>" + esc(o.declined) + "</td><td>" +
                esc(o.claimSource || "-") + (o.claimedBy ? " (" + esc(String(o.claimedBy).slice(-6)) + ")" : "") +
                "</td><td>" + esc(o.createdAt ? new Date(o.createdAt).toLocaleString() : "-") + "</td><td>" + re + "</td></tr>";
        }).join("");
    }

    function rebroadcast(orderId) {
        request("/delivery-ops/admin/broadcast/" + encodeURIComponent(orderId), { method: "POST" })
            .then(function (d) {
                if (d && d.success && d.broadcast && d.broadcast.broadcast) {
                    notify("Re-alerted " + d.broadcast.partners + " partner(s) (new offer " + String(d.broadcast.offerId).slice(-6) + ").", "success");
                } else {
                    notify("Nothing to broadcast: " + ((d && d.broadcast && d.broadcast.reason) || "already assigned"), "info");
                }
                refresh();
            })
            .catch(function () { notify("Network error.", "error"); });
    }

    // ---------- reconciliation ----------

    function renderRecon(payload) {
        var totals = payload.totals || {};
        var stats = document.getElementById("opsReconTotals");
        if (stats) {
            var cards = [
                ["Deliveries", Number(totals.deliveries || 0)],
                ["COD orders", Number(totals.codOrders || 0)],
                ["Expected", money(totals.codExpected)],
                ["Collected", money(totals.codCollected)],
                ["Missing confirmations", Number(totals.cashMissing || 0)]
            ];
            stats.innerHTML = cards.map(function (c) {
                return '<div class="stat-card"><div class="stat-label">' + esc(c[0]) + '</div><div class="stat-value">' + esc(c[1]) + "</div></div>";
            }).join("");
        }

        var host = document.getElementById("opsReconRows");
        if (!host) return;
        var rows = Array.isArray(payload.partners) ? payload.partners : [];
        if (!rows.length) {
            host.innerHTML = '<tr><td colspan="8" class="ops-empty">No deliveries completed on this date.</td></tr>';
            return;
        }
        host.innerHTML = rows.map(function (r) {
            var diff = Number(r.variance || 0);
            var cls = Math.abs(diff) < 0.01 ? "ops-flag-ok" : "ops-flag-bad";
            return "<tr><td>" + esc(r.partnerName) + "</td><td>" +
                (r.partnerPhone ? '<a href="tel:' + esc(r.partnerPhone) + '">' + esc(r.partnerPhone) + "</a>" : "-") +
                "</td><td>" + esc(r.delivered) + "</td><td>" + esc(r.codOrders) +
                "</td><td>" + money(r.codExpected) + "</td><td>" + money(r.codCollected) +
                "</td><td>" + (r.cashMissing ? '<span class="ops-flag-missing">' + esc(r.cashMissing) + "</span>" : "0") +
                '</td><td class="' + cls + '">' + money(diff) + "</td></tr>";
        }).join("");
    }

    function loadRecon() {
        var dateInput = document.getElementById("opsReconDate");
        var date = dateInput && dateInput.value ? dateInput.value : "";
        request("/delivery-ops/admin/reconciliation" + (date ? "?date=" + encodeURIComponent(date) : ""))
            .then(function (d) {
                if (d && d.success) renderRecon(d);
                else notify((d && d.message) || "Could not load the reconciliation sheet.", "error");
            })
            .catch(function () { notify("Network error.", "error"); });
    }

    // ---------- lifecycle ----------

    function refresh() {
        return request("/delivery-ops/admin/partners").then(function (d) {
            if (!d || d.success !== true) {
                notify((d && d.message) || "Could not load delivery operations.", "error");
                return null;
            }
            renderPartners(d);
            renderOps(d);
            return d;
        }).catch(function () { return null; });
    }

    function start() {
        var host = document.getElementById("adminDeliveryOpsHost");
        if (!host) return;
        stopTimers();
        refresh().then(function (d) { if (d) loadRecon(); });

        // Keep the roster honest while the tab stays open.
        state.timers.push(setInterval(function () {
            var section = document.getElementById("adminDeliverySection");
            if (section && section.style.display !== "none") refresh();
        }, 30000));
    }

    function init() {
        document.addEventListener("click", function (e) {
            var t = e.target;
            if (!t || !t.getAttribute) return;
            var reviewId = t.getAttribute("data-review");
            if (reviewId) { review(t.getAttribute("data-id"), reviewId); return; }
            var assignId = t.getAttribute("data-force-assign");
            if (assignId) { forceAssign(assignId); return; }
            var reId = t.getAttribute("data-rebroadcast");
            if (reId) { rebroadcast(reId); return; }
        });

        var reloadBtn = document.getElementById("opsReloadBtn");
        if (reloadBtn) reloadBtn.addEventListener("click", function () { refresh(); loadRecon(); });

        var sweepBtn = document.getElementById("opsSweepBtn");
        if (sweepBtn) {
            sweepBtn.addEventListener("click", function () {
                request("/delivery-ops/admin/offers/sweep", { method: "POST", body: { limit: 50 } }).then(function (d) {
                    if (d && d.success) {
                        notify("Swept " + d.swept + " offer(s): " + d.autoAssigned + " auto-assigned, " + d.escalated + " escalated to admin.", "success");
                        refresh();
                    } else {
                        notify((d && d.message) || "Sweep failed.", "error");
                    }
                }).catch(function () { notify("Network error.", "error"); });
            });
        }

        var pruneBtn = document.getElementById("opsPrunePushBtn");
        if (pruneBtn) {
            pruneBtn.addEventListener("click", function () {
                if (!window.confirm("Deactivate browser subscriptions that keep failing? Affected partners will need to re-enable alerts.")) return;
                request("/delivery-ops/admin/push/prune", { method: "POST", body: { maxFailures: 25 } }).then(function (d) {
                    if (d && d.success) notify(d.message || "Nothing to prune.", "success");
                    else notify((d && d.message) || "Prune failed.", "error");
                }).catch(function () { notify("Network error.", "error"); });
            });
        }

        var reconBtn = document.getElementById("opsReconLoad");
        if (reconBtn) reconBtn.addEventListener("click", loadRecon);

        var dateInput = document.getElementById("opsReconDate");
        if (dateInput && !dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);

        // Load as soon as the admin opens the Delivery tab.
        var originalSwitch = window.switchTab;
        window.switchTab = function (tab) {
            if (typeof originalSwitch === "function") originalSwitch(tab);
            if (tab === "delivery") start();
        };

        // Also handle the case where the tab is already active on load.
        if (document.getElementById("adminDeliverySection") &&
            document.getElementById("adminDeliverySection").style.display !== "none") {
            start();
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    window.FreshMartAdminDeliveryOps = { refresh: refresh, loadRecon: loadRecon, start: start };
})();
