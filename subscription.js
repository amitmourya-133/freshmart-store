// ===============================
// FRESHMART - SUBSCRIPTION LOGIC
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

function confirmSubscription() {
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
        startDate: new Date().toLocaleDateString()
    };

    // Save to localStorage
    var subs = [];
    try { subs = JSON.parse(localStorage.getItem("freshMartSubscriptions")) || []; } catch (e) {}
    subs.push(subscription);
    try { localStorage.setItem("freshMartSubscriptions", JSON.stringify(subs)); } catch (e) {}

    // Try to save to backend if available
    try {
        var subApiBase = (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1")
            ? "http://localhost:5000/api"
            : "/api";
        fetch(subApiBase + "/subscriptions", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(subscription)
        }).catch(function() {});
    } catch (e) {}

    // Show success
    var formWrap = document.getElementById("subFormWrap");
    if (formWrap) formWrap.style.display = "none";
    var success = document.getElementById("subSuccess");
    if (success) {
        success.style.display = "block";
        var msg = document.getElementById("subSuccessMsg");
        if (msg) msg.innerText = selectedPlan.name + " subscribed. Delivered weekly (" + slot + "). Price ₹" + selectedPlan.price + "/week.";
    }
}
