// ===============================
// HELP CENTER (simple WhatsApp support)
// - No ticket/request system
// - No database storage
// - Just direct WhatsApp support link
// ===============================

// When the customer arrives from the Orders page (?order=FM...), include the
// selected order reference in the pre-filled WhatsApp message.
function initHelpPage() {
    var btn = document.getElementById("helpWhatsappBtn");
    if (!btn) return;

    var orderRef = getHelpQueryParam("order");
    var message = orderRef
        ? "Hello FreshMart Support, I need help regarding my order. Order ID: " + orderRef
        : "Hello FreshMart Support, I need help regarding my order/purchased product.";

    btn.href = "https://wa.me/919068424873?text=" + encodeURIComponent(message);

    var note = document.getElementById("helpOrderNote");
    if (note) {
        note.textContent = orderRef ? "Support chat will reference your order: " + orderRef : "";
    }
}

// Read a single query-string parameter and decode it safely.
function getHelpQueryParam(name) {
    try {
        var match = new RegExp("[?&]" + name + "=([^&]*)").exec(window.location.search);
        return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
    } catch (e) {
        return "";
    }
}