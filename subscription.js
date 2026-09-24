// ===============================
// FRESHMART - SUBSCRIPTION LOGIC
// Uses real backend API: /api/subscriptions
// ===============================

var selectedPlan = { name: "", price: 0 };

function selectPlan(name, price) {
    selectedPlan.name = name;
    selectedPlan.price = price;

    var formWrap = document.getElementById("subFormWrap");
    var title = document.getElementById("subFormTitle");
    if (formWrap) formWrap.style.display = "block";
    if (title) title.innerText = "Subscribe to " + name + " — ₹" + price + "/week";

    var success = document.getElementById("subSuccess");
    if (success) success.style.display = "none";
}

// Subscribe using backend API
async function submitSubscription() {
    var name = document.getElementById("subName").value.trim();
    var phone = document.getElementById("subPhone").value.trim();
    var address = document.getElementById("subAddress").value.trim();
    var slot = document.getElementById("subSlot").value;

    if (!name || !phone || !address) {
        showToast("Please fill all subscription details.", "error");
        return;
    }
    if (phone.length !== 10 || isNaN(phone)) {
        showToast("Please enter a valid 10-digit mobile number.", "error");
        return;
    }
    if (!selectedPlan.name) {
        showToast("Please choose a subscription plan first.", "error");
        return;
    }

    var subscription = {
        plan: selectedPlan.name,
        price: selectedPlan.price,
        name: name,
        phone: phone,
        address: address,
        slot: slot,
        status: "Active",
    };

    try {
        var subApiBase = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "http://localhost:5000/api"
            : "/api";

        const response = await fetch(subApiBase + "/subscriptions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": "Bearer " + (window.freshmartToken || "")
            },
            body: JSON.stringify(subscription)
        });

        const data = await response.json();

        if (!response.ok) {
            showToast(data.message || "Subscription failed. Please try again.", "error");
            return;
        }

        // Show success and hide form
        var formWrap = document.getElementById("subFormWrap");
        if (formWrap) formWrap.style.display = "none";
        var success = document.getElementById("subSuccess");
        if (success) {
            success.style.display = "block";
            var msg = document.getElementById("subSuccessMsg");
            if (msg) msg.innerText = selectedPlan.name + " subscribed. Delivered weekly (" + slot + "). Price ₹" + selectedPlan.price + "/week.";
        }

        // Refresh subscription UI
        loadMySubscription();

    } catch (error) {
        showToast("Error connecting to server. Please try again.", "error");
    }
}

// Load customer's active subscription
async function loadMySubscription() {
    try {
        var subApiBase = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "http://localhost:5000/api"
            : "/api";

        const response = await fetch(subApiBase + "/subscriptions/my", {
            headers: {
                "Authorization": "Bearer " + (window.freshmartToken || "")
            }
        });

        const data = await response.json();

        if (data.success && data.subscription) {
            // Update UI to show active subscription
            var subSuccess = document.getElementById("subSuccess");
            var subFormWrap = document.getElementById("subFormWrap");
            var subPlans = document.querySelectorAll(".sub-card");

            if (subSuccess) {
                subSuccess.style.display = "block";
            }
            if (subFormWrap) subFormWrap.style.display = "none";
        }
    } catch (error) {
        console.error("Failed to load subscription:", error);
    }
}

// Initialize subscription on page load
document.addEventListener("DOMContentLoaded", function() {
    // Check if user already has a subscription
    loadMySubscription();
});