// ===============================
// DELIVERY OPERATIONS — PARTNER PANEL
// Adds the live layer on top of delivery.html: the incoming-offer feed
// (Phase 2), the OTP re-issue / COD cash / signature tools (Phase 5), the
// partner status + break controls (Phase 1) and the delivery history with a
// cash sheet (Phase 6).
//
// Design rules:
//  * Every decision is made by the server. The client only renders and asks.
//  * The offer feed is polled (and mirrored by Web Push), so a partner who
//    keeps this page open sees new work even with the phone in a pocket.
//  * Nothing here fabricates availability, money or distances.
// ===============================

(function () {
    "use strict";

    var POLL_OFFERS_MS = 15000;   // open offers (fast: the window is ~90s)
    var POLL_ACTIVE_MS = 20000;   // runs in progress
    var POLL_STATUS_MS = 60000;   // partner status / ops switches

    var state = {
        partner: null,
        ops: null,
        offers: [],
        active: [],
        pollTimers: [],
        claiming: false,
        promptSignatureFor: null
    };

    // ---------- tiny helpers ----------

    function base() {
        return (typeof API !== "undefined" && API && API.base) ? API.base : "";
    }

    function headers() {
        return (typeof getAuthHeaders === "function") ? getAuthHeaders() : { "Content-Type": "application/json" };
    }

    function toast(message, type) {
        if (typeof showToast === "function") {
            showToast(message, type || "info");
            return;
        }
        console.log("[delivery-ops] " + (type || "info") + ": " + message);
    }

    function money(n) {
        return "₹" + Number(n || 0).toLocaleString("en-IN");
    }

    function escapeHtml(value) {
        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
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
            }).then(function (data) {
                return { status: res.status, data: data };
            });
        });
    }

    function stopPolling() {
        state.pollTimers.forEach(function (t) { clearInterval(t); });
        state.pollTimers = [];
    }

    function schedule(fn, ms) {
        // Never stack requests: skip a tick if the previous one is still running.
        var running = false;
        return setInterval(function () {
            if (running) return;
            running = true;
            Promise.resolve(fn()).catch(function () { /* silent */ }).then(function () {
                running = false;
            });
        }, ms);
    }

    // ---------- partner status ----------

    function loadStatus() {
        return request("/delivery-ops/me").then(function (r) {
            if (!r.data || r.data.success !== true) return null;
            state.partner = r.data.partner || null;
            state.ops = r.data.ops || null;
            renderStatusBar(r.data);
            return r.data;
        }).catch(function () { return null; });
    }

    function renderStatusBar(payload) {
        var host = document.getElementById("opsStatusBar");
        if (!host) return;
        var p = payload.partner || {};
        var ops = payload.ops || {};

        if (p.partnerStatus !== "approved") {
            var text = p.partnerStatus === "pending"
                ? "Your delivery partner application is under review. You will get a notification the moment an admin approves it."
                : p.partnerStatus === "rejected"
                    ? "Your partner application was declined." + (p.rejectReason ? " Reason: " + p.rejectReason : "")
                    : "This account is not approved as a delivery partner yet.";
            host.className = "ops-status-bar ops-status-" + (p.partnerStatus || "none");
            host.innerHTML = '<span class="ops-status-dot"></span><span>' + escapeHtml(text) + "</span>";
            return;
        }

        var bits = [];
        bits.push('<span class="ops-status-dot"></span>');
        bits.push("<strong>" + escapeHtml(p.name || "Partner") + "</strong>");
        bits.push('<span class="ops-chip ' + (p.online ? "chip-ok" : "chip-off") + '">' +
            (p.online ? "Online" : "Offline") + "</span>");
        if (p.vehicleType) bits.push('<span class="ops-chip">' + escapeHtml(p.vehicleType) + "</span>");
        if (p.zone) bits.push('<span class="ops-chip">' + escapeHtml(p.zone) + "</span>");
        if (p.deliveryCount) bits.push('<span class="ops-chip">' + Number(p.deliveryCount) + " deliveries</span>");
        if (p.ratingCount) bits.push('<span class="ops-chip">★ ' + Number(p.rating).toFixed(1) + "</span>");
        if (payload.activeAssignments) bits.push('<span class="ops-chip chip-active">' + payload.activeAssignments + " active</span>");
        if (payload.openOffers) bits.push('<span class="ops-chip chip-offer">' + payload.openOffers + " offers</span>");
        if (!p.online && ops.broadcastEnabled) {
            bits.push('<span class="ops-hint">Go online to receive new orders.</span>');
        }
        host.className = "ops-status-bar ops-status-approved";
        host.innerHTML = bits.join(" ");
    }

    // ---------- Phase 2: the offer feed ----------

    function loadOffers() {
        if (!state.partner || state.partner.partnerStatus !== "approved") return Promise.resolve();
        return request("/delivery-ops/offers").then(function (r) {
            if (!r.data || r.data.success !== true) return;
            state.offers = Array.isArray(r.data.offers) ? r.data.offers : [];
            renderOffers();
        }).catch(function () { /* keep the last known list */ });
    }

    function renderOffers() {
        var host = document.getElementById("opsOfferList");
        if (!host) return;
        var wrap = document.getElementById("opsOfferSection");
        if (wrap) wrap.hidden = false;

        if (!state.offers.length) {
            host.innerHTML = '<p class="ops-empty">No new orders right now. Keep this page open — you will be alerted the moment one lands.</p>';
            return;
        }

        host.innerHTML = state.offers.map(function (o) {
            var secs = Number(o.expiresInSeconds) || 0;
            var urgent = secs <= 20 ? " ops-offer-urgent" : "";
            var dist = (o.distanceKm == null) ? "" : '<span class="ops-offer-meta">' + Number(o.distanceKm) + " km away</span>";
            return '' +
                '<article class="ops-offer' + urgent + '" data-offer-id="' + escapeHtml(o._id) + '">' +
                    '<div class="ops-offer-top">' +
                        '<strong>' + escapeHtml(o.orderNumber || "Order") + "</strong>" +
                        '<span class="ops-offer-amount">' + money(o.total) + "</span>" +
                    "</div>" +
                    '<div class="ops-offer-meta-row">' +
                        (o.area ? '<span class="ops-offer-meta">' + escapeHtml(o.area) + "</span>" : "") +
                        dist +
                        '<span class="ops-offer-meta">' + Number(o.itemCount || 0) + " item(s)</span>" +
                        (o.deliverySlot ? '<span class="ops-offer-meta">' + escapeHtml(o.deliverySlot) + "</span>" : "") +
                        '<span class="ops-offer-timer" data-expires-at="' + escapeHtml(o.expiresAt) + '">⏳ ' + secs + "s</span>" +
                    "</div>" +
                    '<div class="ops-offer-actions">' +
                        '<button type="button" class="ops-btn ops-btn-accept" data-claim="' + escapeHtml(o._id) + '">Accept order</button>' +
                        '<button type="button" class="ops-btn ops-btn-decline" data-decline="' + escapeHtml(o._id) + '">Not for me</button>' +
                    "</div>" +
                "</article>";
        }).join("");
    }

    function tickOfferTimers() {
        document.querySelectorAll(".ops-offer-timer").forEach(function (el) {
            var at = new Date(el.getAttribute("data-expires-at")).getTime();
            var secs = Math.max(0, Math.round((at - Date.now()) / 1000));
            el.textContent = "⏳ " + secs + "s";
            if (secs === 0) loadOffers();
        });
    }

    function claimOffer(offerId) {
        if (state.claiming) return;
        state.claiming = true;
        toast("Claiming order…", "info");
        request("/delivery/offers/" + encodeURIComponent(offerId) + "/accept", { method: "POST" })
            .then(function (r) {
                state.claiming = false;
                var d = r.data || {};
                if (d.success && d.assigned) {
                    toast(d.message || "Order accepted.", "success");
                    refreshAll();
                } else {
                    toast(d.message || "This order was already taken.", "error");
                    loadOffers();
                }
            })
            .catch(function (err) {
                state.claiming = false;
                try {
                    // Fallback to legacy claim endpoint for compatibility.
                    request("/delivery-ops/offers/" + encodeURIComponent(offerId) + "/claim", { method: "POST" })
                        .then(function (r2) {
                            var d2 = r2.data || {};
                            if (d2.success) {
                                toast(d2.message || "Order accepted.", "success");
                                refreshAll();
                            } else {
                                toast(d2.message || "This order was already taken.", "error");
                                loadOffers();
                            }
                        })
                        .catch(function () {
                            toast("Could not reach the server. Check your connection.", "error");
                        });
                } catch (e) {
                    toast("Could not reach the server. Check your connection.", "error");
                }
            });
    }

    function declineOffer(offerId) {
        request("/delivery-ops/offers/" + encodeURIComponent(offerId) + "/decline", { method: "POST" })
            .then(function (r) {
                var d = r.data || {};
                toast(d.message || (d.success ? "Offer skipped." : "Could not decline the offer."), d.success ? "info" : "error");
                loadOffers();
            })
            .catch(function () { /* silent */ });
    }

    // ---------- Phase 5 tools on the active runs ----------

    function loadActive() {
        if (!state.partner || state.partner.partnerStatus !== "approved") return Promise.resolve();
        return request("/delivery-ops/active").then(function (r) {
            if (!r.data || r.data.success !== true) return;
            state.active = Array.isArray(r.data.active) ? r.data.active : [];
            renderOpsTools();
        }).catch(function () { /* silent */ });
    }

    function renderOpsTools() {
        var host = document.getElementById("opsActiveTools");
        if (!host) return;
        var section = document.getElementById("opsActiveSection");
        if (section) section.hidden = false;
        if (!state.active.length) {
            host.innerHTML = '<p class="ops-empty">No delivery in progress.</p>';
            return;
        }

        host.innerHTML = state.active.map(function (a) {
            var rows = [];
            rows.push('<div class="ops-run"><div class="ops-run-head">' +
                "<strong>" + escapeHtml(a.orderNumber || "Order") + "</strong>" +
                '<span class="ops-chip">' + escapeHtml(a.status) + "</span>" +
                '<span class="ops-run-amount">' + money(a.total) + "</span></div>");

            var facts = [];
            if (a.distanceKm != null) facts.push(Number(a.distanceKm) + " km away");
            if (a.area) facts.push(a.area);
            if (a.customerName) facts.push(a.customerName);
            facts.push(a.isCod ? "Cash on delivery" : "Prepaid");
            rows.push('<div class="ops-run-meta">' + facts.map(escapeHtml).join(" · ") + "</div>");

            var buttons = [];

            var nxt = nextStatusFor(a.status);
            if (nxt) {
                var label = nxt === 'PICKED_UP' ? 'Start pickup' : (nxt === 'EN_ROUTE' ? 'Start delivery' : (nxt === 'DELIVERED' ? 'Mark delivered' : nxt));
                buttons.push('<button type="button" class="ops-btn ops-btn-accept status-btn" data-status="' + escapeHtml(nxt) + '" data-id="' + escapeHtml(a.assignmentId) + '">' + escapeHtml(label) + '</button>');
            }
            // OTP re-issue: the customer says the code never arrived.
            var reissueLeft = Math.max(0, Number(a.otpReissueMax || 0) - Number(a.otpReissueCount || 0));
            var waiting = Number(a.otpReissueReadyInSeconds) || 0;
            if (waiting > 0) {
                buttons.push('<button type="button" class="ops-btn" disabled data-hint="OTP re-issue available in ' + waiting + 's">Re-send OTP (' + waiting + "s)</button>");
            } else if (reissueLeft <= 0) {
                buttons.push('<button type="button" class="ops-btn" disabled>OTP re-issue used up</button>');
            } else {
                buttons.push('<button type="button" class="ops-btn ops-btn-otp" data-otp="' + escapeHtml(a.assignmentId) + '">Re-send OTP to customer (' + reissueLeft + " left)</button>");
            }

            if (a.isCod && a.cashCollected == null) {
                buttons.push('<button type="button" class="ops-btn ops-btn-cash" data-cash="' + escapeHtml(a.assignmentId) + '">Record cash collected</button>');
            } else if (a.isCod && a.cashCollected != null) {
                rows.push('<div class="ops-run-cash">Cash recorded: <strong>' + money(a.cashCollected) + "</strong> (order " + money(a.total) + ")" +
                    (a.cashVariance ? ', difference ' + money(a.cashVariance) : "") + "</div>");
            }

            if (!a.hasSignature) {
                buttons.push('<button type="button" class="ops-btn ops-btn-sign" data-sign="' + escapeHtml(a.assignmentId) + '">Capture recipient signature</button>');
            } else {
                rows.push('<div class="ops-run-cash">✓ Signature captured ' +
                    (a.signatureAt ? escapeHtml(new Date(a.signatureAt).toLocaleString()) : "") + "</div>");
            }

            rows.push('<div class="ops-run-actions">' + buttons.join("") + "</div></div>");
            return rows.join("");
        }).join("");
    }

    function reissueOtp(assignmentId) {
        const reason = window.prompt("Why are you re-sending the OTP?\n(e.g. customer did not receive it, code expired)", "Customer did not receive the OTP");
        if (reason === null) return;
        request("/delivery-ops/assignments/" + encodeURIComponent(assignmentId) + "/otp/reissue", {
            method: "POST",
            body: { reason: String(reason || "").slice(0, 160) }
        }).then(function (r) {
            var d = r.data || {};
            toast(d.message || (d.success ? "OTP re-issued." : "Could not re-issue the OTP."), d.success ? "success" : "error");
            loadActive();
            loadStatus();
        }).catch(function () { toast("Network error.", "error"); });
    }

    function recordCash(assignmentId) {
        var run = state.active.filter(function (a) { return a.assignmentId === assignmentId; })[0];
        var expected = run ? Number(run.total) : 0;
        var input = window.prompt(
            "How much cash did the customer hand you?\nOrder total is " + money(expected) + " (include any change given back).",
            String(expected)
        );
        if (input === null) return;
        var amount = Number(String(input).replace(/[^0-9.]/g, ""));
        if (!isFinite(amount) || amount < 0) {
            toast("Enter a valid amount.", "error");
            return;
        }
        request("/delivery-ops/assignments/" + encodeURIComponent(assignmentId) + "/cash", {
            method: "POST",
            body: { amount: amount }
        }).then(function (r) {
            var d = r.data || {};
            toast(d.message || (d.success ? "Cash recorded." : "Could not record the cash."), d.success ? "success" : "error");
            loadActive();
        }).catch(function () { toast("Network error.", "error"); });
    }

    // ---------- signature pad ----------

    function openSignaturePad(assignmentId) {
        state.promptSignatureFor = assignmentId;
        var modal = document.getElementById("opsSignatureModal");
        if (!modal) return;
        var canvas = document.getElementById("opsSignatureCanvas");
        var ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.lineWidth = 2.5;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#12281c";
        modal.hidden = false;
        var drawing = false;
        var last = null;

        function pos(e) {
            var r = canvas.getBoundingClientRect();
            var src = (e.touches && e.touches[0]) ? e.touches[0] : e;
            return {
                x: (src.clientX - r.left) * (canvas.width / r.width),
                y: (src.clientY - r.top) * (canvas.height / r.height)
            };
        }
        function down(e) {
            e.preventDefault();
            drawing = true;
            last = pos(e);
        }
        function move(e) {
            if (!drawing) return;
            e.preventDefault();
            var p = pos(e);
            ctx.beginPath();
            ctx.moveTo(last.x, last.y);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            last = p;
        }
        function up() { drawing = false; }

        canvas.onmousedown = down;
        canvas.onmousemove = move;
        window.addEventListener("mouseup", up);
        canvas.ontouchstart = down;
        canvas.ontouchmove = move;
        canvas.ontouchend = up;
    }

    function closeSignaturePad() {
        var modal = document.getElementById("opsSignatureModal");
        if (modal) modal.hidden = true;
        state.promptSignatureFor = null;
    }

    function saveSignature() {
        var canvas = document.getElementById("opsSignatureCanvas");
        if (!canvas || !state.promptSignatureFor) return closeSignaturePad();
        var dataUrl = canvas.toDataURL("image/png");
        if (dataUrl.length < 1200) {
            toast("Please ask the customer to sign before saving.", "error");
            return;
        }
        request("/delivery-ops/assignments/" + encodeURIComponent(state.promptSignatureFor) + "/signature", {
            method: "POST",
            body: { signature: dataUrl }
        }).then(function (r) {
            var d = r.data || {};
            toast(d.message || (d.success ? "Signature saved." : "Could not save the signature."), d.success ? "success" : "error");
            if (d.success) {
                closeSignaturePad();
                loadActive();
            }
        }).catch(function () { toast("Network error.", "error"); });
    }

    // ---------- Phase 6: history + cash sheet ----------

    function loadHistory() {
        if (!state.partner || state.partner.partnerStatus !== "approved") return Promise.resolve();
        return request("/delivery-ops/history?limit=25").then(function (r) {
            if (!r.data || r.data.success !== true) return;
            renderHistory(r.data);
        }).catch(function () { /* silent */ });
    }

    function renderHistory(payload) {
        var host = document.getElementById("opsHistoryBody");
        if (!host) return;
        var section = document.getElementById("opsHistorySection");
        if (section) section.hidden = false;
        var s = payload.summary || {};
        var rows = Array.isArray(payload.deliveries) ? payload.deliveries : [];

        var cards = [
            ["Delivered", Number(s.delivered || 0)],
            ["Earnings", money(s.earningsTotal)],
            ["COD expected", money(s.codExpected)],
            ["COD collected", money(s.codCollected)],
            ["Difference", money(s.codVariance)]
        ];
        document.getElementById("opsHistoryStats").innerHTML = cards.map(function (c) {
            return '<div class="earning-card"><div>' + escapeHtml(c[0]) + '</div><div class="amount">' + escapeHtml(c[1]) + "</div></div>";
        }).join("");

        if (Number(s.unconfirmedCash || 0) > 0) {
            document.getElementById("opsHistoryWarn").hidden = false;
            document.getElementById("opsHistoryWarn").textContent =
                Number(s.unconfirmedCash) + " COD delivery/deliveries have no cash recorded yet. Record the cash collected so the day-end sheet balances.";
        } else {
            document.getElementById("opsHistoryWarn").hidden = true;
        }

        if (!rows.length) {
            host.innerHTML = '<p class="ops-empty">No completed deliveries yet.</p>';
            return;
        }
        host.innerHTML = rows.map(function (d) {
            var cash = "";
            if (d.expectedCash != null) {
                cash = d.cashCollected == null
                    ? '<span class="ops-flag-missing">cash not recorded</span>'
                    : money(d.cashCollected) + (d.variance ? ' <span class="' + (d.variance < 0 ? "ops-flag-bad" : "ops-flag-ok") + '">' + money(d.variance) + "</span>" : "");
            }
            return '<tr><td>' + escapeHtml(d.orderNumber || "-") + "</td>" +
                "<td>" + escapeHtml(d.deliveredAt ? new Date(d.deliveredAt).toLocaleString() : "-") + "</td>" +
                "<td>" + escapeHtml(d.assignMode || "-") + "</td>" +
                "<td>" + money(d.earnings) + "</td>" +
                "<td>" + (cash || escapeHtml(d.paymentMethod || "-")) + "</td>" +
                "<td>" + (d.hasSignature ? "✓ signature" : (d.hasProof ? "photo" : "-")) + "</td></tr>";
        }).join("");
    }

    // ---------- push opt-in ----------

    function refreshPushButton() {
        var btn = document.getElementById("opsPushBtn");
        if (!btn) return;
        if (typeof PushNotifications === "undefined") { btn.hidden = true; return; }
        btn.hidden = false;
        function label() {
            if (!("Notification" in window)) { btn.textContent = "Alerts unavailable"; btn.disabled = true; return; }
            if (Notification.permission === "denied") { btn.textContent = "Alerts blocked in browser settings"; btn.disabled = true; return; }
            if (Notification.permission === "granted") { btn.textContent = "✓ Delivery alerts on"; btn.disabled = true; return; }
            btn.textContent = "🔔 Turn on delivery alerts";
            btn.disabled = false;
        }
        label();
    }

    function enablePush() {
        if (typeof PushNotifications === "undefined") return;
        PushNotifications.subscribe().then(function (r) {
            if (r && r.ok) {
                toast("Delivery alerts are on. Keep this page open or allow notifications.", "success");
            } else {
                var why = (r && r.error === "denied")
                    ? "Notifications are blocked for this site in your browser settings."
                    : "Could not enable alerts on this device.";
                toast(why, "error");
            }
            refreshPushButton();
        });
    }

    // ---------- availability override (break reason + location nudge) ----------

    // The inline dashboard script calls the global toggleAvailability(). We
    // replace it here (this file loads after it) so the break reason is captured
    // and a fresh GPS ping is requested when the partner comes online.
    window.toggleAvailability = function (isAvailable) {
        var checkbox = document.getElementById("availabilityInput");
        var body = { isAvailable: !!isAvailable };
        var proceed = true;

        if (!isAvailable) {
            var reason = window.prompt("Going offline. Add a short reason (optional):\n(e.g. on a break, vehicle issue, personal work)", "");
            if (reason === null) { proceed = false; }
            else { body.breakReason = String(reason || "").trim().slice(0, 80); }
        }
        if (!proceed) {
            if (checkbox) checkbox.checked = !isAvailable;
            return Promise.resolve();
        }

        return request("/delivery-ops/availability", { method: "PUT", body: body }).then(function (r) {
            var d = r.data || {};
            if (!d.success) {
                toast(d.message || "Could not update availability", "error");
                if (checkbox) checkbox.checked = !isAvailable;
                return;
            }
            toast(d.message || "Availability updated", "success");
            if (d.isAvailable && d.needsLocation) {
                shareLocationNow().then(function (ok) {
                    toast(ok
                        ? "You are online and your location is shared."
                        : "You are online. Please allow location access so orders can be ranked by distance.", ok ? "success" : "info");
                });
            }
            if (d.isAvailable) loadOffers();
            loadStatus();
        }).catch(function () {
            toast("Network error while updating availability", "error");
            if (checkbox) checkbox.checked = !isAvailable;
        });
    };

    function shareLocationNow() {
        if (typeof captureCurrentLocation !== "function" || typeof apiDeliveryShareLocation !== "function") {
            return Promise.resolve(false);
        }
        return captureCurrentLocation()
            .then(function (loc) { return apiDeliveryShareLocation(loc.latitude, loc.longitude); })
            .then(function () { return true; })
            .catch(function () { return false; });
    }

    // ---------- wiring ----------

    function refreshAll() {
        return Promise.all([loadStatus(), loadOffers(), loadActive(), loadHistory()]);
    }

    function init() {
        // `notifications.js` declares PushNotifications as a top-level const, so
        // it lives in the global lexical scope rather than on `window`.
        if (typeof PushNotifications !== "undefined") {
            try { PushNotifications.autoSubscribeIfPossible(); } catch (e) { /* silent */ }
        }
        refreshPushButton();

        loadStatus().then(function (data) {
            if (!data) return;
            if (!state.partner || state.partner.partnerStatus !== "approved") return;
            if (state.partner && state.partner.isAvailable && typeof captureCurrentLocation === "function") {
                // Refresh the GPS ping used to rank offers by distance.
                shareLocationNow();
            }
            refreshAll();
            stopPolling();
            state.pollTimers.push(schedule(loadOffers, POLL_OFFERS_MS));
            state.pollTimers.push(schedule(loadActive, POLL_ACTIVE_MS));
            state.pollTimers.push(schedule(loadStatus, POLL_STATUS_MS));
            state.pollTimers.push(schedule(tickOfferTimers, 1000));
        });

        // Offer accept / decline (delegated: the markup is re-rendered often).
        document.addEventListener("click", function (e) {
        var t = e.target;
        if (t.classList.contains("status-btn")) {
            var st = t.getAttribute("data-status");
            var aid = t.getAttribute("data-id");
            if (aid && st) {
                if (st === "DELIVERED") {
                    if (!window.confirm("Mark this delivery as DELIVERED?")) return;
                }
                advanceDeliveryStatus(aid, st);
            }
            return;
        }
            var t = e.target;
            if (!t || !t.getAttribute) return;
            var claimId = t.getAttribute("data-claim");
            if (claimId) { claimOffer(claimId); return; }
            var declineId = t.getAttribute("data-decline");
            if (declineId) { declineOffer(declineId); return; }
            var otpId = t.getAttribute("data-otp");
            if (otpId) { reissueOtp(otpId); return; }
            var cashId = t.getAttribute("data-cash");
            if (cashId) { recordCash(cashId); return; }
            var signId = t.getAttribute("data-sign");
            if (signId) { openSignaturePad(signId); return; }
        });

        var pushBtn = document.getElementById("opsPushBtn");
        if (pushBtn) pushBtn.addEventListener("click", enablePush);

        var saveBtn = document.getElementById("opsSignatureSave");
        if (saveBtn) saveBtn.addEventListener("click", saveSignature);
        var clearBtn = document.getElementById("opsSignatureClear");
        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                var canvas = document.getElementById("opsSignatureCanvas");
                if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
            });
        }
        var cancelBtn = document.getElementById("opsSignatureCancel");
        if (cancelBtn) cancelBtn.addEventListener("click", closeSignaturePad);

        var reloadBtn = document.getElementById("opsHistoryReload");
        if (reloadBtn) reloadBtn.addEventListener("click", loadHistory);

        // Coming back from the background must refresh immediately.
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "visible") refreshAll();
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    window.FreshMartDeliveryOps = {
        reload: refreshAll,
        loadOffers: loadOffers,
        loadActive: loadActive,
        loadHistory: loadHistory
    };
})();

function nextStatusFor(s) { if (s==='ACCEPTED') return 'PICKED_UP'; if (s==='PICKED_UP') return 'EN_ROUTE'; if (s==='EN_ROUTE') return 'DELIVERED'; return null; }

function advanceDeliveryStatus(assignmentId, toStatus) {
    if (!assignmentId || !toStatus) return;
    request('/delivery/status/' + encodeURIComponent(assignmentId), { method: 'PUT', body: { status: toStatus } })
        .then(function(r){ var d=r.data||{}; toast(d.message||(d.success?'Status updated.':'Could not update status.'), d.success?'success':'error'); if (d.success){ loadActive(); loadHistory(); } })
        .catch(function(){ toast('Network error.','error'); });
}


