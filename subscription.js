// ===============================
// FRESHMART - SUBSCRIPTION LOGIC
// Uses the real backend API: /api/subscriptions (JWT in httpOnly cookie, so
// no Authorization header is needed for same-origin calls).
// ===============================

var selectedPlan = null;

function freqLabel(f) {
    var map = {
        weekly: "week",
        monthly: "month",
        quarterly: "quarter",
        "half-yearly": "6 months",
        yearly: "year"
    };
    return map[f] || "week";
}

function featureLabel(f) {
    var map = {
        free_delivery: "Free delivery",
        priority_slots: "Priority slots",
        customizable_box: "Customizable box",
        extra_kg: "Extra kilogram",
        extra_fruits: "Extra fruits",
        all_products: "All products",
        skip_any_week: "Skip any week",
        pause_subscription: "Pause anytime"
    };
    if (map[f]) return map[f];
    return String(f || "").replace(/_/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

function subToast(msg, type) {
    if (typeof showToast === "function") { showToast(msg, type); return; }
    alert(msg);
}

function subMoney(amount) {
    return "₹" + Number(amount || 0).toLocaleString("en-IN");
}

function subApi(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, getAuthHeaders(), opts.headers || {});
    return fetch(API.base + url, opts).then(function (res) { return res.json(); });
}

function renderPlans(plans) {
    var container = document.querySelector(".sub-plans");
    if (!container) return;

    if (!plans || !plans.length) {
        container.innerHTML = '<p class="sub-empty" style="padding:24px;text-align:center;color:#666;">No subscription plans are available right now. Please check back soon.</p>';
        return;
    }

    container.innerHTML = "";

    plans.forEach(function (plan) {
        var card = document.createElement("div");
        card.className = "sub-card" + (/standard/i.test(String(plan.name)) ? " popular" : "");

        var h = document.createElement("h3");
        h.textContent = plan.name;

        var desc = document.createElement("p");
        desc.className = "sub-desc";
        desc.textContent = plan.description || "";

        var price = document.createElement("div");
        price.className = "sub-price";
        var spanAmt = document.createElement("span");
        spanAmt.textContent = subMoney(plan.pricing && plan.pricing.amount);
        var spanPer = document.createElement("span");
        spanPer.textContent = "/" + freqLabel(plan.pricing && plan.pricing.frequency);
        price.appendChild(spanAmt);
        price.appendChild(spanPer);

        var ul = document.createElement("ul");
        (plan.features || []).forEach(function (f) {
            var li = document.createElement("li");
            li.textContent = featureLabel(f);
            ul.appendChild(li);
        });

        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sub-btn";
        btn.textContent = "Choose " + plan.name;
        btn.addEventListener("click", function () { selectPlan(plan); });

        card.appendChild(h);
        card.appendChild(desc);
        card.appendChild(price);
        card.appendChild(ul);
        card.appendChild(btn);
        container.appendChild(card);
    });
}

function selectPlan(plan) {
    selectedPlan = plan;
    var formWrap = document.getElementById("subFormWrap");
    var title = document.getElementById("subFormTitle");
    if (formWrap) formWrap.style.display = "block";
    if (title) title.innerText = "Subscribe to " + plan.name + " — " + subMoney(plan.pricing && plan.pricing.amount) + "/" + freqLabel(plan.pricing && plan.pricing.frequency);
    var success = document.getElementById("subSuccess");
    if (success) success.style.display = "none";
    if (formWrap && formWrap.scrollIntoView) formWrap.scrollIntoView({ behavior: "smooth", block: "center" });
}

function loadPlans() {
    subApi("/subscriptions/plans")
        .then(function (data) {
            if (data && data.success) renderPlans(data.plans || []);
            else renderPlans([]);
        })
        .catch(function () { renderPlans([]); });
}

// Subscribe using the real backend (POST /api/subscriptions/:planId, cookie auth)
async function confirmSubscription() {
    var name = document.getElementById("subName").value.trim();
    var phone = document.getElementById("subPhone").value.trim();
    var address = document.getElementById("subAddress").value.trim();
    var slot = document.getElementById("subSlot").value;

    if (!name || !phone || !address) {
        subToast("Please fill all subscription details.", "error");
        return;
    }
    if (!/^\d{10}$/.test(phone)) {
        subToast("Please enter a valid 10-digit mobile number.", "error");
        return;
    }
    if (!selectedPlan || !selectedPlan._id) {
        subToast("Please choose a subscription plan first.", "error");
        return;
    }

    try {
        var resp = await subApi("/subscriptions/" + selectedPlan._id, {
            method: "POST",
            body: JSON.stringify({
                name: name,
                phone: phone,
                address: address,
                deliverySlot: slot
            })
        });

        if (resp && resp.success) {
            var formWrap = document.getElementById("subFormWrap");
            if (formWrap) formWrap.style.display = "none";
            var success = document.getElementById("subSuccess");
            if (success) {
                success.style.display = "block";
                var msg = document.getElementById("subSuccessMsg");
                if (msg) msg.innerText = selectedPlan.name + " subscribed. Price " + subMoney(selectedPlan.pricing && selectedPlan.pricing.amount) + "/" + freqLabel(selectedPlan.pricing && selectedPlan.pricing.frequency) + ".";
            }
            loadMySubscription();
            loadPlans();
        } else {
            var message = (resp && resp.message) || "Subscription failed. Please try again.";
            if (resp && (resp.status === 401 || /not authorized|please login/i.test(message))) {
                subToast("Please login to subscribe to a plan.", "error");
                setTimeout(function () { window.location.href = "login.html"; }, 900);
                return;
            }
            subToast(message, "error");
        }
    } catch (error) {
        subToast("Error connecting to server. Please try again.", "error");
    }
}

// Load the customer's subscription (GET /api/subscriptions/my, cookie auth)
function loadMySubscription() {
    subApi("/subscriptions/my")
        .then(function (data) {
            var sub = data && data.success ? data.subscription : null;

            var current = document.getElementById("currentSubscription");
            if (!current) return;

            if (sub && sub.status === "active") {
                current.style.display = "block";
                document.getElementById("currPlanName").textContent = (sub.plan && sub.plan.name) || "—";
                document.getElementById("currStatus").textContent = "Active";
                if (sub.nextDeliveryDate) {
                    document.getElementById("currNextDelivery").textContent = new Date(sub.nextDeliveryDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
                } else {
                    document.getElementById("currNextDelivery").textContent = "—";
                }
                var cancelBtn = document.getElementById("btnCancelSubscription");
                if (cancelBtn) cancelBtn.dataset.subId = String(sub._id || "");
            } else {
                current.style.display = "none";
            }
        })
        .catch(function () {
            var current = document.getElementById("currentSubscription");
            if (current) current.style.display = "none";
        });
}

async function cancelSubscription() {
    var btn = document.getElementById("btnCancelSubscription");
    var subId = btn ? btn.dataset.subId : "";
    if (!subId) {
        subToast("No active subscription to cancel.", "error");
        return;
    }
    if (!confirm("Are you sure you want to cancel your subscription?")) return;

    try {
        var resp = await subApi("/subscriptions/" + subId + "/cancel", { method: "PUT" });
        if (resp && resp.success) {
            subToast("Subscription cancelled successfully.", "success");
            loadPlans();
            loadMySubscription();
        } else {
            subToast((resp && resp.message) || "Failed to cancel subscription.", "error");
        }
    } catch (error) {
        subToast("Error connecting to server. Please try again.", "error");
    }
}

function initSubscriptionPage() {
    var btn = document.getElementById("btnCancelSubscription");
    if (btn) btn.addEventListener("click", cancelSubscription);

    var confirmBtn = document.getElementById("btnConfirmSubscription");
    if (confirmBtn) confirmBtn.addEventListener("click", confirmSubscription);

    loadPlans();
    loadMySubscription();
}

document.addEventListener("DOMContentLoaded", initSubscriptionPage);