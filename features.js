// ===============================
// FRESHMART - PHASE 6 ADVANCED FEATURES
// Multi-language, Voice Search, AI Recommendations,
// Subscription, Delivery Slots
// ===============================

// ===============================
// 1. MULTI-LANGUAGE (Hindi / English)
// ===============================

function featuresImageStyle(name, gradient) {
    return "background:" + (gradient || "#eaffef");
}

var LANGS = {
    en: {
        "search.placeholder": "Search vegetables, fruits, grocery...",
        "nav.myorders": "My Orders",
        "nav.login": "Login",
        "nav.wishlist": "Wishlist",
        "nav.cart": "Cart",
        "hero.title": "Freshness Delivered To Your Door",
        "hero.subtitle": "Fresh vegetables, fruits and groceries at the best prices.",
        "hero.cta": "SHOP NOW",
        "categories.title": "Shop By Category",
        "cat.vegetables": "Vegetables",
        "cat.fruits": "Fruits",
        "cat.grocery": "Grocery",
        "products.title": "Fresh Products",
        "filter.all": "All",
        "filter.vegetables": "Vegetables",
        "filter.fruits": "Fruits",
        "filter.grocery": "Grocery",
        "recommended.title": "You may also like",
        "recent.title": "Recently Viewed",
        "features.fast.title": "Fast Delivery",
        "features.fast.desc": "Quick delivery to your doorstep.",
        "features.fresh.title": "Fresh Products",
        "features.fresh.desc": "Fresh vegetables and fruits.",
        "features.price.title": "Best Prices",
        "features.price.desc": "Affordable prices for everyone.",
        "sub.banner.title": "Weekly Veggie Box",
        "sub.banner.desc": "Fresh vegetables delivered every week. Save up to 20%!",
        "sub.banner.cta": "Subscribe Now",
        "cart.add": "Add To Cart",
        "checkout.proceed": "Proceed To Checkout",
        "lang.name": "हिं EN"
    },
    hi: {
        "search.placeholder": "सब्ज़ियाँ, फल, किराना खोजें...",
        "nav.myorders": "मेरे ऑर्डर",
        "nav.login": "लॉगिन",
        "nav.wishlist": "पसंदीदा",
        "nav.cart": "कार्ट",
        "hero.title": "ताज़गी अब आपके दरवाज़े पर",
        "hero.subtitle": "ताज़ी सब्ज़ियाँ, फल और किराना सबसे अच्छे दाम पर।",
        "hero.cta": "अभी खरीदें",
        "categories.title": "श्रेणी के अनुसार खरीदें",
        "cat.vegetables": "सब्ज़ियाँ",
        "cat.fruits": "फल",
        "cat.grocery": "किराना",
        "products.title": "ताज़े उत्पाद",
        "filter.all": "सभी",
        "filter.vegetables": "सब्ज़ियाँ",
        "filter.fruits": "फल",
        "filter.grocery": "किराना",
        "recommended.title": "आपको ये भी पसंद आ सकता है",
        "recent.title": "हाल ही में देखे गए",
        "features.fast.title": "तेज़ डिलीवरी",
        "features.fast.desc": "आपके दरवाज़े तक तेज़ डिलीवरी।",
        "features.fresh.title": "ताज़े उत्पाद",
        "features.fresh.desc": "ताज़ी सब्ज़ियाँ और फल।",
        "features.price.title": "सबसे अच्छे दाम",
        "features.price.desc": "सभी के लिए सस्ते दाम।",
        "sub.banner.title": "साप्ताहिक वेजी बॉक्स",
        "sub.banner.desc": "हर हफ़्ते ताज़ी सब्ज़ियाँ घर पर। 20% तक बचाएँ!",
        "sub.banner.cta": "अभी सब्सक्राइब करें",
        "cart.add": "कार्ट में जोड़ें",
        "checkout.proceed": "चेकआउट करें",
        "lang.name": "EN हिं"
    }
};

var currentLang = "en";

function getCurrentLang() {
    var saved = null;
    try { saved = localStorage.getItem("freshMartLang"); } catch (e) {}
    if (saved === "hi" || saved === "en") return saved;
    return "en";
}

function setLanguage(lang) {
    currentLang = lang;
    try { localStorage.setItem("freshMartLang", lang); } catch (e) {}
    applyLanguage();
}

function toggleLanguage(btn) {
    var next = currentLang === "en" ? "hi" : "en";
    setLanguage(next);
}

function applyLanguage() {
    var dict = LANGS[currentLang] || LANGS.en;

    // Update elements with data-i18n attributes
    document.querySelectorAll("[data-i18n]").forEach(function(el) {
        var key = el.getAttribute("data-i18n");
        if (dict[key]) el.innerHTML = dict[key];
    });

    // Update placeholders
    document.querySelectorAll("[data-i18n-placeholder]").forEach(function(el) {
        var key = el.getAttribute("data-i18n-placeholder");
        if (dict[key]) el.setAttribute("placeholder", dict[key]);
    });

    // Update lang toggle button text
    var langToggle = document.getElementById("langToggle");
    if (langToggle) langToggle.innerText = dict["lang.name"] || "हिं EN";

    document.documentElement.lang = currentLang === "hi" ? "hi" : "en";

    // Re-render dynamic product buttons (Add To Cart text) if available
    if (typeof updateAllCartControls === "function") {
        updateAllCartControls();
    }

    // Re-render subscription banner if present
    renderSubscriptionContent();
}

// Fallback dark mode for pages that don't load script.js
if (typeof toggleDarkMode === "undefined") {
    function toggleDarkMode() {
        document.body.classList.toggle("dark-mode");
        var btn = document.getElementById("darkModeToggle");
        if (btn) {
            var isDark = document.body.classList.contains("dark-mode");
            btn.innerText = isDark ? "Light mode" : "Dark mode";
            try { localStorage.setItem("freshMartTheme", isDark ? "dark" : "light"); } catch (e) {}
        }
    }
}
if (typeof initDarkMode === "undefined") {
    function initDarkMode() {
        var theme = null;
        try { theme = localStorage.getItem("freshMartTheme"); } catch (e) {}
        if (theme === "dark") document.body.classList.add("dark-mode");
    }
}
if (typeof showToast === "undefined") {
    function showToast(msg) {
        alert(msg);
    }
}

function i18n(key) {
    return (LANGS[currentLang] || LANGS.en)[key] || key;
}

// ===============================
// 2. VOICE SEARCH (Web Speech API)
// ===============================

var voiceRecognition = null;
var voiceListening = false;

function startVoiceSearch() {
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        showToast("Voice search not supported in this browser. Try Chrome.", "error");
        return;
    }

    var btn = document.getElementById("voiceSearchBtn");
    if (voiceListening) {
        stopVoiceSearch();
        return;
    }

    if (!voiceRecognition) {
        voiceRecognition = new SpeechRecognition();
        voiceRecognition.lang = currentLang === "hi" ? "hi-IN" : "en-IN";
        voiceRecognition.interimResults = false;
        voiceRecognition.maxAlternatives = 1;

        voiceRecognition.onresult = function(event) {
            var transcript = event.results[0][0].transcript;
            var searchInput = document.getElementById("searchInput");
            if (searchInput) {
                searchInput.value = transcript;
                searchProducts();
            }
            stopVoiceSearch();
        };

        voiceRecognition.onerror = function(event) {
            showToast("Voice not recognized. Please try again.", "error");
            stopVoiceSearch();
        };

        voiceRecognition.onend = function() {
            stopVoiceSearch();
        };
    }

    try {
        voiceRecognition.lang = currentLang === "hi" ? "hi-IN" : "en-IN";
        voiceRecognition.start();
        voiceListening = true;
        if (btn) {
            btn.classList.add("listening");
            btn.innerHTML = "🔴";
        }
        showToast("Listening... speak now", "success");
    } catch (e) {}
}

function stopVoiceSearch() {
    voiceListening = false;
    var btn = document.getElementById("voiceSearchBtn");
    if (btn) {
        btn.classList.remove("listening");
        btn.innerHTML = "Voice";
    }
    if (voiceRecognition) {
        try { voiceRecognition.stop(); } catch (e) {}
    }
}

// ===============================
// 3. AI RECOMMENDATIONS
// ===============================

// Content-based recommendation: score each product based on
// cart items, wishlist, recently viewed, and same category.
function getRecommendations(limit) {
    limit = limit || 6;
    if (typeof products === "undefined" || products.length === 0) return [];

    var cartNames = {};
    (window.cart || []).forEach(function(c) {
        cartNames[c.name] = c.quantity || 1;
    });

    var likedNames = {};
    (window.wishlist || []).forEach(function(n) {
        likedNames[String(n).trim()] = 1;
    });

    var categoryWeights = {};

    products.forEach(function(p) {
        if (cartNames[p.name]) {
            categoryWeights[p.category] = (categoryWeights[p.category] || 0) + (cartNames[p.name] || 1);
        }
        if (likedNames[p.name]) {
            categoryWeights[p.category] = (categoryWeights[p.category] || 0) + 1;
        }
    });

    // Boost categories of recently viewed products
    try {
        var recent = JSON.parse(localStorage.getItem("freshMartRecent") || "[]");
        recent.forEach(function(idx) {
            if (products[idx]) {
                categoryWeights[products[idx].category] = (categoryWeights[products[idx].category] || 0) + 0.5;
            }
        });
    } catch (e) {}

    var scored = [];
    products.forEach(function(p, i) {
        var weight = categoryWeights[p.category];
        if (!weight) return;
        // Don't recommend products already in cart or wishlist
        if (cartNames[p.name] || likedNames[p.name]) return;
        scored.push({ index: i, score: weight });
    });

    scored.sort(function(a, b) { return b.score - a.score; });

    var result = scored.slice(0, limit);
    if (result.length === 0) {
        // Fallback: pick items, skipping cart/wishlist
        var fallback = [];
        products.forEach(function(p, i) {
            if (fallback.length >= limit) return;
            if (cartNames[p.name] || (window.wishlist || []).indexOf(p.name) !== -1) return;
            fallback.push(i);
        });
        return fallback;
    }
    return result.map(function(r) { return r.index; });
}

function renderRecommendations() {
    var section = document.getElementById("recommendedSection");
    var container = document.getElementById("recommendedContainer");
    if (!section || !container) return;

    var recIndexes = getRecommendations(6);
    if (!recIndexes || recIndexes.length === 0) return;

    var html = "";
    recIndexes.forEach(function(index) {
        var product = products[index];
        if (!product) return;
        var r = getProductRating(product.name);
        var inCart = (window.cart || []).find(function(c) { return c.name === product.name; });
        var qty = inCart ? inCart.quantity : 0;
        var wishClass = isWishlisted(product.name) ? "wishlist-active" : "";
        var safeName = product.name.replace(/'/g, "\\'");

        html +=
            '<div class="product" data-category="' + product.category + '" onclick="openProductDetail(' + index + ')">' +
                '<button type="button" class="wishlist-heart ' + wishClass + '" data-name="' + product.name.replace(/"/g, "&quot;") + '" onclick="event.stopPropagation(); toggleWishlist(\'' + safeName + '\')">♥</button>' +
                '<div class="product-image" style="' + featuresImageStyle(product.name, product.gradient) + '">' + productImgHTML(product.name) + '</div>' +
                '<h3>' + product.name + '</h3>' +
                starHTML(r.rating) +
                '<span class="rating-count">(' + r.count + ')</span>' +
                '<p class="product-price">₹' + product.price + ' / ' + product.unit + '</p>' +
                '<span class="product-badge">' + product.category + '</span>' +
                cartControlsHTML(safeName, product.price, qty) +
            '</div>';
    });

    if (html) {
        container.innerHTML = html;
        section.style.display = "block";
    }
}

// ===============================
// 4. DELIVERY SLOT
// ===============================

function getDeliverySlot() {
    var radios = document.querySelectorAll('input[name="deliverySlot"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) return radios[i].value;
    }
    return "Morning (8-11 AM)";
}

// Also attach to order build: add deliverySlot to order object
// buildOrderObject is defined in script.js; we augment it here by
// patching after load is not possible cleanly, so we read it directly in placeOrder.
function getSubtotal() {
    if (typeof getCartSubtotal === "function") return getCartSubtotal();
    return 0;
}

// ===============================
// 5. SUBSCRIPTION CONTENT
// ===============================

function renderSubscriptionContent() {
    var banner = document.querySelector(".subscription-banner");
    if (!banner) return;
    var h3 = banner.querySelector("h3");
    var p = banner.querySelector("p");
    if (currentLang === "hi") {
        if (h3)         h3.innerText = "साप्ताहिक वेजी बॉक्स";
        if (p) p.innerText = "हर हफ़्ते ताज़ी सब्ज़ियाँ घर पर। 20% तक बचाएँ!";
    }
}

// ===============================
// INIT
// ===============================

function initAdvancedFeatures() {
    if (typeof initDarkMode === "function") initDarkMode();
    currentLang = getCurrentLang();
    setLanguage(currentLang);

    // Recommendations on home page
    if (document.body.dataset.page === "home") {
        setTimeout(function() {
            renderRecommendations();
        }, 1400);
    }
}

document.addEventListener("DOMContentLoaded", initAdvancedFeatures);
