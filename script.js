// ===============================
// PRODUCTS DATA
// ===============================

const products = [
    // VEGETABLES
    { name: "Fresh Tomato", price: 60, unit: "kg", category: "Vegetables", emoji: "🍅", gradient: "linear-gradient(135deg, #ff6b6b, #ee5a24)", description: "Fresh farm-picked tomatoes, juicy and ripe. Perfect for curries, salads, chutneys and sauces.", nutrition: "Rich in Vitamin C, Potassium, Folate and Vitamin K. Low in calories.", tips: "Store at room temperature until ripe. Refrigerate after ripening to last longer.", origin: "Nashik, Maharashtra" },
    { name: "Potato", price: 30, unit: "kg", category: "Vegetables", emoji: "🥔", gradient: "linear-gradient(135deg, #d4a574, #c0956c)", description: "Premium quality potatoes, perfect for boiling, frying, baking or making delicious aloo dishes.", nutrition: "Good source of Carbohydrates, Vitamin B6, Potassium and Fiber.", tips: "Store in a cool, dark and dry place. Keep away from onions as they release gases.", origin: "Agra, UP" },
    { name: "Onion", price: 60, unit: "kg", category: "Vegetables", emoji: "🧅", gradient: "linear-gradient(135deg, #f0c27f, #d4a056)", description: "Fresh onions with strong flavor. Essential for Indian cooking, salads and pickles.", nutrition: "Rich in Vitamin C, B6, Potassium and antioxidants like Quercetin.", tips: "Store in a cool, dry and ventilated place. Can last several weeks.", origin: "Nashik, Maharashtra" },
    { name: "Carrot", price: 40, unit: "kg", category: "Vegetables", emoji: "🥕", gradient: "linear-gradient(135deg, #ff9a44, #fc6076)", description: "Sweet and crunchy carrots, ideal for salads, juices, halwa and curries.", nutrition: "Excellent source of Beta-carotene, Vitamin A, Fiber and Potassium.", tips: "Remove green tops before storing. Keep in refrigerator in a plastic bag.", origin: "Bangalore, Karnataka" },
    { name: "Cauliflower", price: 100, unit: "kg", category: "Vegetables", emoji: "🥦", gradient: "linear-gradient(135deg, #a8e063, #56ab2f)", description: "Fresh white cauliflower with tight florets. Great for gobi manchurian, paratha and curry.", nutrition: "High in Vitamin C, Vitamin K, Fiber and Folate.", tips: "Store unwashed in refrigerator. Use within a week for best freshness.", origin: "Pune, Maharashtra" },
    { name: "Cabbage", price: 40, unit: "kg", category: "Vegetables", emoji: "🥬", gradient: "linear-gradient(135deg, #56ab2f, #a8e063)", description: "Crisp green cabbage, perfect for salads, sabzi, chowmein and coleslaw.", nutrition: "Rich in Vitamin C, Vitamin K, Fiber and antioxidants.", tips: "Store in refrigerator crisper drawer. Stays fresh for up to 2 weeks.", origin: "Indore, MP" },
    { name: "Capsicum", price: 80, unit: "kg", category: "Vegetables", emoji: "🫑", gradient: "linear-gradient(135deg, #11998e, #38ef7d)", description: "Colorful capsicum with sweet flavor. Perfect for stir-fry, pizza, salads and stuffed dishes.", nutrition: "Excellent source of Vitamin C, Vitamin A and antioxidants.", tips: "Store in refrigerator crisper. Use within 5 days for best taste.", origin: "Hyderabad, Telangana" },
    { name: "Green Peas", price: 200, unit: "kg", category: "Vegetables", emoji: "🫛", gradient: "linear-gradient(135deg, #56ab2f, #2d8f2d)", description: "Fresh sweet green peas, perfect for matar paneer, pulao, samosa filling and snacks.", nutrition: "High in Protein, Fiber, Vitamin K and antioxidants.", tips: "Shell and store in airtight container. Refrigerate and use within 2-3 days.", origin: "Satara, Maharashtra" },
    { name: "Cucumber", price: 30, unit: "kg", category: "Vegetables", emoji: "🥒", gradient: "linear-gradient(135deg, #56ab2f, #11998e)", description: "Cool and refreshing cucumber, ideal for salads, raita, sandwiches and detox water.", nutrition: "96% water content. Good source of Vitamin K and Potassium.", tips: "Store in refrigerator. Wrap in paper towel to absorb excess moisture.", origin: "Rajasthan" },
    { name: "Spinach (Palak)", price: 30, unit: "kg", category: "Vegetables", emoji: "🥬", gradient: "linear-gradient(135deg, #11998e, #56ab2f)", description: "Fresh green spinach leaves. Perfect for palak paneer, soup, paratha and smoothies.", nutrition: "Rich in Iron, Vitamin A, Vitamin C, Calcium and Folate.", tips: "Wash thoroughly before use. Store wrapped in damp paper towel in fridge.", origin: "Pune, Maharashtra" },
    { name: "Brinjal", price: 40, unit: "kg", category: "Vegetables", emoji: "🍆", gradient: "linear-gradient(135deg, #7b4397, #dc2430)", description: "Fresh purple brinjal, perfect for baingan bharta, curries, grill and curd brinjal.", nutrition: "Low in calories. Rich in Fiber, Vitamin B1 and antioxidants.", tips: "Store at room temperature. Use within 2-3 days. Do not cut until ready to use.", origin: "Varanasi, UP" },
    { name: "Bottle Gourd (Lauki)", price: 30, unit: "kg", category: "Vegetables", emoji: "🥒", gradient: "linear-gradient(135deg, #a8e063, #11998e)", description: "Fresh bottle gourd, light and healthy. Great for dal, sabzi, juice and kofta.", nutrition: "Low in calories. High in water content, Vitamin C and Zinc.", tips: "Store in refrigerator. Cut pieces can be wrapped and refrigerated for 2 days.", origin: "Lucknow, UP" },
    { name: "Bitter Gourd (Karela)", price: 40, unit: "kg", category: "Vegetables", emoji: "🥬", gradient: "linear-gradient(135deg, #56ab2f, #2d8f2d)", description: "Fresh bitter gourd with natural bitterness. Great for karela sabzi, chips and juice.", nutrition: "Rich in Vitamin C, Iron, Potassium and insulin-like compounds.", tips: "Soak in salt water for 30 minutes to reduce bitterness before cooking.", origin: "Indore, MP" },
    { name: "Radish (Mooli)", price: 30, unit: "kg", category: "Vegetables", emoji: "🥬", gradient: "linear-gradient(135deg, #f5f5f5, #dc2430)", description: "Crisp white radish, ideal for paratha, salad, pickle and mooli ki sabzi.", nutrition: "Low in calories. Rich in Vitamin C, Fiber and Potassium.", tips: "Remove greens before storing. Keep in refrigerator for up to a week.", origin: "Delhi NCR" },
    { name: "Beetroot", price: 40, unit: "kg", category: "Vegetables", emoji: "🫒", gradient: "linear-gradient(135deg, #8b0000, #dc143c)", description: "Deep red beetroot, perfect for salad, juice, halwa and healthy cooking.", nutrition: "Rich in Iron, Folate, Manganese and nitrates for blood flow.", tips: "Store in refrigerator. Wrap individually in foil to keep fresh longer.", origin: "Pune, Maharashtra" },
    { name: "Garlic", price: 200, unit: "kg", category: "Vegetables", emoji: "🧄", gradient: "linear-gradient(135deg, #f5f5dc, #d4a574)", description: "Fresh aromatic garlic cloves, essential for Indian and global cuisines.", nutrition: "Contains Allicin. Rich in Manganese, Vitamin B6 and Vitamin C.", tips: "Store in a cool, dry place with good ventilation. Do not refrigerate.", origin: "Guntur, Andhra Pradesh" },
    { name: "Ginger", price: 150, unit: "kg", category: "Vegetables", emoji: "🫚", gradient: "linear-gradient(135deg, #d4a574, #c0956c)", description: "Fresh ginger root with warm, spicy flavor. Essential for chai, curries and remedies.", nutrition: "Contains Gingerol. Helps with digestion, nausea and inflammation.", tips: "Store in refrigerator in paper bag. Can also be frozen for longer storage.", origin: "Meghalaya" },
    { name: "Green Chilli", price: 80, unit: "kg", category: "Vegetables", emoji: "🌶️", gradient: "linear-gradient(135deg, #56ab2f, #ff6347)", description: "Fresh hot green chillies for that perfect spicy kick in every dish.", nutrition: "Rich in Capsaicin, Vitamin C and Vitamin A. Boosts metabolism.", tips: "Store in refrigerator. Remove stems before storing to last longer.", origin: "Guntur, Andhra Pradesh" },
    { name: "Coriander (Dhaniya)", price: 50, unit: "kg", category: "Vegetables", emoji: "🌿", gradient: "linear-gradient(135deg, #56ab2f, #a8e063)", description: "Fresh coriander leaves with citrusy aroma. Perfect garnish for every Indian dish.", nutrition: "Rich in Vitamin K, Vitamin A and antioxidants.", tips: "Store stems-down in a glass of water. Cover with plastic bag in fridge.", origin: "Nashik, Maharashtra" },
    { name: "Mint (Pudina)", price: 40, unit: "kg", category: "Vegetables", emoji: "🌿", gradient: "linear-gradient(135deg, #11998e, #38ef7d)", description: "Fresh mint leaves, cooling and aromatic. Great for chutney, raita, drinks and biryani.", nutrition: "Rich in Vitamin A, Vitamin C and antioxidants. Aids digestion.", tips: "Store stems-down in water in fridge. Can also be dried for later use.", origin: "Nagpur, Maharashtra" },
    { name: "Lemon", price: 80, unit: "kg", category: "Vegetables", emoji: "🍋", gradient: "linear-gradient(135deg, #fff44f, #ffd700)", description: "Fresh juicy lemons, perfect for lemonade, cooking, dressings and garnishing.", nutrition: "Excellent source of Vitamin C. Aids in digestion and immunity.", tips: "Store at room temperature for a week or refrigerate for up to a month.", origin: "Nagpur, Maharashtra" },
    { name: "Mushroom", price: 50, unit: "pack", category: "Vegetables", emoji: "🍄", gradient: "linear-gradient(135deg, #d4a574, #8b7355)", description: "Fresh button mushrooms, rich in umami flavor. Perfect for curry, stir-fry and soup.", nutrition: "Low in calories. Rich in Protein, B Vitamins, Selenium and antioxidants.", tips: "Store in paper bag in refrigerator. Do not wash until ready to use.", origin: "Himachal Pradesh" },
    { name: "Sweet Corn", price: 30, unit: "kg", category: "Vegetables", emoji: "🌽", gradient: "linear-gradient(135deg, #ffd700, #ff9a44)", description: "Sweet and juicy corn on the cob. Great for boiling, grilling, soup and chaat.", nutrition: "Rich in Fiber, Vitamin B, antioxidants and essential minerals.", tips: "Refrigerate immediately. Best consumed within 1-2 days for sweetness.", origin: "Karnataka" },
    { name: "Broccoli", price: 120, unit: "kg", category: "Vegetables", emoji: "🥦", gradient: "linear-gradient(135deg, #2d8f2d, #56ab2f)", description: "Fresh green broccoli florets, a superfood. Great for stir-fry, pasta and healthy eating.", nutrition: "High in Vitamin C, Vitamin K, Fiber and Sulforaphane (anti-cancer).", tips: "Store in refrigerator crisper. Do not wash until ready to use.", origin: "Ooty, Tamil Nadu" },
    { name: "Pumpkin (Kaddu)", price: 30, unit: "kg", category: "Vegetables", emoji: "🎃", gradient: "linear-gradient(135deg, #ff9a44, #ff6b6b)", description: "Fresh sweet pumpkin, perfect for kaddu sabzi, pie, soup and curries.", nutrition: "Low in calories. Rich in Vitamin A, Vitamin C, Potassium and Fiber.", tips: "Whole pumpkin can last weeks at room temperature. Refrigerate cut pieces.", origin: "Rajasthan" },
    { name: "Curry Leaves", price: 25, unit: "bunch", category: "Vegetables", emoji: "🌿", gradient: "linear-gradient(135deg, #2d8f2d, #11998e)", description: "Fresh curry leaves with authentic South Indian aroma. Essential for tempering.", nutrition: "Rich in Iron, Calcium, Vitamin A and antioxidants.", tips: "Store in refrigerator wrapped in paper. Can be dried or frozen for longer use.", origin: "Chennai, Tamil Nadu" },

    // FRUITS
    { name: "Apple", price: 150, unit: "kg", category: "Fruits", emoji: "🍎", gradient: "linear-gradient(135deg, #ff6b6b, #ee5a24)", description: "Crisp and juicy apples, the king of fruits. Perfect for snacking, juice and desserts.", nutrition: "Rich in Fiber, Vitamin C and antioxidants. Aids heart health and digestion.", tips: "Store in refrigerator to keep crisp. Keep away from other fruits (releases ethylene).", origin: "Shimla, Himachal Pradesh" },
    { name: "Banana", price: 50, unit: "dozen", category: "Fruits", emoji: "🍌", gradient: "linear-gradient(135deg, #ffd700, #ff9a44)", description: "Fresh ripe bananas, energy-packed snack. Great for smoothies, desserts and baking.", nutrition: "Rich in Potassium, Vitamin B6, Vitamin C and Fiber.", tips: "Store at room temperature. Separate from bunch to slow ripening. Refrigerate to stop ripening.", origin: "Jalgaon, Maharashtra" },
    { name: "Orange", price: 80, unit: "kg", category: "Fruits", emoji: "🍊", gradient: "linear-gradient(135deg, #ff9a44, #ff6b6b)", description: "Sweet and tangy oranges, loaded with Vitamin C. Perfect for juicing and snacking.", nutrition: "Excellent source of Vitamin C, Thiamine, Folate and antioxidants.", tips: "Store at room temperature or refrigerate for up to 2 weeks. Squeeze fresh for best taste.", origin: "Nagpur, Maharashtra" },
    { name: "Mango", price: 120, unit: "kg", category: "Fruits", emoji: "🥭", gradient: "linear-gradient(135deg, #ffd700, #ff9a44)", description: "The king of fruits! Sweet, pulpy Alphonso mangoes. Perfect for dessert, shake and aamras.", nutrition: "Rich in Vitamin C, Vitamin A, Folate and antioxidants.", tips: "Ripen at room temperature. Refrigerate ripe mangoes for up to a week.", origin: "Ratnagiri, Maharashtra" },
    { name: "Grapes", price: 100, unit: "kg", category: "Fruits", emoji: "🍇", gradient: "linear-gradient(135deg, #7b4397, #dc2430)", description: "Fresh seedless grapes, sweet and juicy. Perfect for snacking, juice and fruit salads.", nutrition: "Rich in Vitamin C, Vitamin K and antioxidants like Resveratrol.", tips: "Wash before eating. Store in refrigerator in perforated bag for up to a week.", origin: "Nashik, Maharashtra" },
    { name: "Watermelon", price: 80, unit: "kg", category: "Fruits", emoji: "🍉", gradient: "linear-gradient(135deg, #ff6b6b, #ee5a24)", description: "Refreshing summer watermelon, hydrating and sweet. Perfect for juice and fruit chaat.", nutrition: "92% water content. Rich in Lycopene, Vitamin A and Vitamin C.", tips: "Store whole at room temperature. Refrigerate cut pieces wrapped in plastic.", origin: "Kurnool, Andhra Pradesh" },
    { name: "Papaya", price: 40, unit: "kg", category: "Fruits", emoji: "🍈", gradient: "linear-gradient(135deg, #ff9a44, #ffcc02)", description: "Ripe sweet papaya with soft flesh. Great for breakfast, smoothies and digestive health.", nutrition: "Rich in Vitamin C, Vitamin A, Folate and the enzyme Papain.", tips: "Ripen at room temperature. Refrigerate ripe papaya for 3-4 days.", origin: "Thiruvananthapuram, Kerala" },
    { name: "Pomegranate (Anar)", price: 150, unit: "kg", category: "Fruits", emoji: "🫐", gradient: "linear-gradient(135deg, #dc143c, #8b0000)", description: "Fresh ruby-red pomegranate seeds, sweet and tangy. Perfect for salads, juice and snacking.", nutrition: "Rich in antioxidants, Vitamin C, Vitamin K and Potassium.", tips: "Store in refrigerator for up to 2 months. Extract seeds and refrigerate in airtight container.", origin: "Nashik, Maharashtra" },
    { name: "Guava (Amrood)", price: 50, unit: "kg", category: "Fruits", emoji: "🍐", gradient: "linear-gradient(135deg, #56ab2f, #a8e063)", description: "Fresh fragrant guava, loaded with Vitamin C. Great for eating raw, juice and chaat.", nutrition: "Highest Vitamin C content among fruits. Rich in Fiber and antioxidants.", tips: "Store at room temperature until ripe. Refrigerate for up to a week.", origin: "Allahabad, UP" },
    { name: "Kiwi", price: 30, unit: "piece", category: "Fruits", emoji: "🥝", gradient: "linear-gradient(135deg, #56ab2f, #2d8f2d)", description: "Exotic green kiwi with sweet-tart flavor. Rich in Vitamin C and great for fruit bowls.", nutrition: "Very high in Vitamin C, Vitamin K, Fiber and antioxidants.", tips: "Ripen at room temperature. Refrigerate ripe kiwis for up to a month.", origin: "Imported / Himachal Pradesh" },
    { name: "Pineapple", price: 50, unit: "kg", category: "Fruits", emoji: "🍍", gradient: "linear-gradient(135deg, #ffd700, #56ab2f)", description: "Sweet tropical pineapple with juicy flesh. Great for juice, dessert and fruit salad.", nutrition: "Rich in Vitamin C, Manganese and the enzyme Bromelain.", tips: "Ripen at room temperature. Refrigerate cut pieces. Keep upside down before cutting.", origin: "Kerala" },
    { name: "Strawberry", price: 80, unit: "box", category: "Fruits", emoji: "🍓", gradient: "linear-gradient(135deg, #ff6b6b, #dc143c)", description: "Fresh red strawberries, sweet and fragrant. Perfect for desserts, smoothies and snacks.", nutrition: "Rich in Vitamin C, Manganese and antioxidants.", tips: "Do not wash until ready to eat. Refrigerate in a single layer on paper towel.", origin: "Mahabaleshwar, Maharashtra" },
    { name: "Cherry", price: 500, unit: "kg", category: "Fruits", emoji: "🍒", gradient: "linear-gradient(135deg, #8b0000, #dc143c)", description: "Premium sweet cherries, juicy and delicious. Perfect for snacking, baking and desserts.", nutrition: "Rich in Vitamin C, Potassium and antioxidants. Anti-inflammatory.", tips: "Refrigerate unwashed in airtight container. Wash just before eating.", origin: "Imported / Kashmir" },
    { name: "Litchi", price: 125, unit: "kg", category: "Fruits", emoji: "🫐", gradient: "linear-gradient(135deg, #ff6b6b, #ffcc02)", description: "Sweet and fragrant litchi with translucent flesh. A refreshing summer fruit.", nutrition: "Rich in Vitamin C, Potassium, Copper and antioxidants.", tips: "Refrigerate immediately. Peel and deseed before eating. Best consumed fresh.", origin: "Bihar / Kashmir" },
    { name: "Peach (Aadoo)", price: 125, unit: "kg", category: "Fruits", emoji: "🍑", gradient: "linear-gradient(135deg, #ffb6c1, #ff9a44)", description: "Soft and juicy peaches with fuzzy skin. Great for eating fresh, jams and desserts.", nutrition: "Rich in Vitamin C, Vitamin A, Fiber and Potassium.", tips: "Ripen at room temperature. Refrigerate ripe peaches for 3-5 days.", origin: "Himachal Pradesh" },
    { name: "Plum (Alu Bukhara)", price: 125, unit: "kg", category: "Fruits", emoji: "🟣", gradient: "linear-gradient(135deg, #7b4397, #4a1a6b)", description: "Sweet and tart plums with vibrant color. Perfect for snacking, baking and preserves.", nutrition: "Rich in Vitamin C, Vitamin K, Fiber and antioxidants.", tips: "Ripen at room temperature. Refrigerate ripe plums for up to 5 days.", origin: "Himachal Pradesh" },
    { name: "Fig (Anjeer)", price: 400, unit: "kg", category: "Fruits", emoji: "🟤", gradient: "linear-gradient(135deg, #8b7355, #5c4033)", description: "Sweet and chewy figs, rich in natural sugars. Great for desserts, snacks and health.", nutrition: "High in Fiber, Calcium, Potassium and antioxidants.", tips: "Fresh figs should be consumed quickly. Dried figs can be stored for months.", origin: "Turkey / Pune" },
    { name: "Coconut", price: 35, unit: "piece", category: "Fruits", emoji: "🥥", gradient: "linear-gradient(135deg, #8b7355, #d4a574)", description: "Fresh coconut with sweet water and tender meat. Essential for cooking and religious use.", nutrition: "Rich in healthy fats, Fiber, Manganese and Copper.", tips: "Store at room temperature for a few days. Refrigerate for up to a week.", origin: "Kerala" },
    { name: "Dragon Fruit", price: 400, unit: "kg", category: "Fruits", emoji: "🐉", gradient: "linear-gradient(135deg, #ff6b6b, #7b4397)", description: "Exotic dragon fruit with mild sweet flavor and stunning appearance. Great for smoothie bowls.", nutrition: "Low in calories. Rich in Vitamin C, Fiber and Magnesium.", tips: "Refrigerate whole for up to 5 days. Cut just before eating.", origin: "Vietnam / Maharashtra" },
    { name: "Avocado", price: 80, unit: "piece", category: "Fruits", emoji: "🥑", gradient: "linear-gradient(135deg, #56ab2f, #2d8f2d)", description: "Creamy and nutritious avocado, perfect for toast, smoothies, guacamole and salads.", nutrition: "Rich in healthy monounsaturated fats, Potassium, Fiber and Vitamin E.", tips: "Ripen at room temperature. Refrigerate ripe avocados. Add lemon juice to cut halves.", origin: "Imported / Maharashtra" },

    // GROCERY
    { name: "Rice", price: 80, unit: "kg", category: "Grocery", emoji: "🍚", gradient: "linear-gradient(135deg, #f5f5dc, #d4a574)", description: "Premium quality basmati rice, long grain and aromatic. Perfect for biryani, pulao and daily meals.", nutrition: "Rich in Carbohydrates and energy. Low in fat and sodium.", tips: "Store in airtight container in cool, dry place. Keep bay leaves to repel insects.", origin: "Punjab / Haryana" },
    { name: "Milk", price: 70, unit: "litre", category: "Grocery", emoji: "🥛", gradient: "linear-gradient(135deg, #f5f5f5, #e0e0e0)", description: "Fresh full-cream milk, pasteurized and pure. Great for tea, coffee, paneer and desserts.", nutrition: "Excellent source of Calcium, Protein, Vitamin D and Vitamin B12.", tips: "Refrigerate immediately. Boil before consumption. Use within the expiry date.", origin: "Amul / Local Dairy" },
    { name: "Wheat Atta", price: 40, unit: "kg", category: "Grocery", emoji: "🌾", gradient: "linear-gradient(135deg, #d4a574, #c0956c)", description: "Fresh stone-ground wheat flour, soft and nutritious. Perfect for roti, chapati and paratha.", nutrition: "Rich in Fiber, Protein, Iron and B Vitamins.", tips: "Store in airtight container in cool, dry place. Refrigerate in humid climates.", origin: "MP / Rajasthan" },
    { name: "Toor Dal", price: 110, unit: "kg", category: "Grocery", emoji: "🫘", gradient: "linear-gradient(135deg, #ffd700, #ff9a44)", description: "Premium quality toor dal, cooks soft and creamy. Essential for dal tadka and sambar.", nutrition: "High in Protein, Fiber, Folate and Iron.", tips: "Store in airtight container. Wash thoroughly before cooking. Soak for faster cooking.", origin: "Gujarat / Maharashtra" },
    { name: "Sugar", price: 70, unit: "kg", category: "Grocery", emoji: "🧂", gradient: "linear-gradient(135deg, #f5f5f5, #e0e0e0)", description: "Fine granulated white sugar, pure and sweet. Essential for tea, coffee, baking and desserts.", nutrition: "Quick source of energy. Use in moderation.", tips: "Store in airtight container in dry place. Keep away from moisture to prevent clumping.", origin: "UP / Maharashtra" },
    { name: "Salt", price: 45, unit: "kg", category: "Grocery", emoji: "🧂", gradient: "linear-gradient(135deg, #f5f5f5, #bdc3c7)", description: "Iodized table salt, essential for cooking and seasoning. Keeps thyroid healthy.", nutrition: "Source of Iodine and Sodium. Essential for body functions in small amounts.", tips: "Store in dry, airtight container. Keep salt shaker away from steam.", origin: "Gujarat (Rock Salt)" },
    { name: "Cooking Oil", price: 250, unit: "litre", category: "Grocery", emoji: "🫗", gradient: "linear-gradient(135deg, #ffd700, #d4a574)", description: "Refined sunflower cooking oil, light and healthy. Perfect for frying, sautéing and cooking.", nutrition: "Source of Vitamin E and healthy unsaturated fats. Cholesterol-free.", tips: "Store in cool, dark place. Do not reuse oil multiple times for frying.", origin: "Fortune / Saffola" },
    { name: "Tea Powder", price: 400, unit: "kg", category: "Grocery", emoji: "🍵", gradient: "linear-gradient(135deg, #8b4513, #d2691e)", description: "Premium CTC tea powder, strong and flavorful. Perfect for masala chai and regular tea.", nutrition: "Contains antioxidants (Catechins). May boost metabolism and heart health.", tips: "Store in airtight container away from light and moisture. Use within 3 months.", origin: "Assam / Darjeeling" },
    { name: "Bread", price: 45, unit: "pack", category: "Grocery", emoji: "🍞", gradient: "linear-gradient(135deg, #d4a574, #c0956c)", description: "Fresh soft white bread, sliced and ready to eat. Perfect for sandwiches and toast.", nutrition: "Source of Carbohydrates and some B Vitamins. Best as a quick meal.", tips: "Store in bread box at room temperature. Refrigerate to prevent mold in humid weather.", origin: "English Oven / Local Bakery" },
    { name: "Eggs", price: 7, unit: "piece", category: "Grocery", emoji: "🥚", gradient: "linear-gradient(135deg, #f5f5dc, #d4a574)", description: "Farm-fresh chicken eggs, protein-rich and versatile. Great for breakfast, baking and cooking.", nutrition: "Excellent source of Protein, Vitamin D, B12 and Choline.", tips: "Refrigerate pointed end down. Use within 3-4 weeks. Check freshness in water test.", origin: "Local Poultry Farm" }
];

// ===============================
// GLOBAL CART
// ===============================

let cart = [];

// ===============================
// LOAD CART
// ===============================

function loadCart() {
    const savedCart = localStorage.getItem("freshMartCart");
    if (savedCart) {
        try {
            cart = JSON.parse(savedCart);
        } catch (error) {
            cart = [];
            localStorage.removeItem("freshMartCart");
        }
    }
    updateCart();
}

// ===============================
// SAVE CART
// ===============================

function saveCart() {
    try {
        localStorage.setItem("freshMartCart", JSON.stringify(cart));
    } catch (error) {
        console.warn("Could not save cart:", error);
    }
    syncCartToServer();
}

// ===============================
// PERSISTENT CART (DB sync for logged-in users)
// ===============================

function isLoggedIn() {
    return readStorageValue("freshMartLoggedIn", "false") === "true" && !!getAuthToken();
}

var productIdMap = null;

// Build name -> backend product _id map (real ids when backend is up)
function loadProductIdMap() {
    if (productIdMap) return Promise.resolve(productIdMap);
    return fetchProducts().then(function(list) {
        var map = {};
        (list || []).forEach(function(p) {
            if (p._id && p.name) map[p.name] = p._id;
        });
        productIdMap = map;
        return map;
    }).catch(function() {
        productIdMap = {};
        return productIdMap;
    });
}

function cartItemProductId(item) {
    if (item && item.productId) return item.productId;
    if (item && productIdMap && productIdMap[item.name]) return productIdMap[item.name];
    return null;
}

// Map a weight chip label back to its multiplier (mirrors utils/pricing.js)
function getMultForWeight(weight, unit) {
    if (!weight) return 1;
    if (/^\d+$/.test(String(weight))) return parseInt(weight, 10) || 1;
    var options = getQtyOptions(unit || "kg");
    for (var i = 0; i < options.length; i++) {
        if (options[i].label === weight) return options[i].mult;
    }
    return 1;
}

function dbCartPayload() {
    var out = [];
    cart.forEach(function(item) {
        var pid = cartItemProductId(item);
        if (!pid) return;
        out.push({
            product: pid,
            quantity: Math.max(1, parseInt(item.quantity, 10) || 1),
            weight: item.qtyLabel || null,
            unit: item.unit || null
        });
    });
    return out;
}

var cartSyncTimer = null;

// Debounced push of the local cart to the DB (logged-in users only)
function syncCartToServer() {
    if (!isLoggedIn()) return;
    if (cartSyncTimer) clearTimeout(cartSyncTimer);
    cartSyncTimer = setTimeout(function() {
        loadProductIdMap().then(function() {
            var payload = dbCartPayload();
            if (payload.length === 0) {
                apiClearCart().catch(function() {});
            } else {
                apiSetCart(payload).catch(function() {});
            }
        });
    }, 400);
}

function cartEntryFromServerItem(it) {
    var mult = getMultForWeight(it.weight, it.unit);
    return {
        name: it.name,
        price: Math.round((Number(it.basePrice) || 0) * mult * 100) / 100,
        quantity: it.quantity,
        qtyLabel: it.weight || null,
        mult: mult,
        unit: it.unit || "kg",
        productId: it.product
    };
}

// Server cart is authoritative; only keep local items that don't exist on the server
function applyCartFromServer(serverItems) {
    var map = {};
    serverItems.forEach(function(it) {
        if (!it || !it.name) return;
        map[it.name.toLowerCase()] = cartEntryFromServerItem(it);
    });

    cart.forEach(function(item) {
        if (!item || !item.name) return;
        var key = item.name.toLowerCase();
        if (!map[key]) map[key] = item;
    });

    cart = [];
    Object.keys(map).forEach(function(key) { cart.push(map[key]); });

    saveCart();
    updateCart();
    updateAllCartControls();

    if (document.body && document.body.dataset.page === "checkout" && typeof loadCheckout === "function") {
        loadCheckout();
    }
}

// Load the DB cart for a logged-in user (adopt + keep local-only items)
function loadCartFromServer() {
    if (!isLoggedIn()) return Promise.resolve();
    loadProductIdMap().catch(function() {});
    return apiGetCart().then(function(data) {
        var items = (data && data.items) || [];
        applyCartFromServer(items);
        syncCartToServer();
    }).catch(function() {});
}

// Merge the guest local cart into the DB cart, then adopt the merged result
function mergeGuestCartIntoDb() {
    if (!isLoggedIn()) return Promise.resolve();

    var guest = cart.map(function(item) {
        return {
            name: item.name,
            quantity: item.quantity,
            qtyLabel: item.qtyLabel || null,
            unit: item.unit || null
        };
    });
    if (guest.length === 0) return Promise.resolve();

    return loadProductIdMap().then(function() {
        return apiMergeCart(guest).then(function(data) {
            var items = (data && data.items) || [];
            var mapped = items.map(cartEntryFromServerItem);
            var mappedNames = {};
            mapped.forEach(function(m) { mappedNames[m.name.toLowerCase()] = true; });

            // Preserve any local-only items the server doesn't know about
            var keepLocal = cart.filter(function(item) {
                return item && item.name && !mappedNames[item.name.toLowerCase()];
            });

            cart = mapped.concat(keepLocal);
            saveCart();
            updateCart();
            updateAllCartControls();

            if (document.body && document.body.dataset.page === "checkout" && typeof loadCheckout === "function") {
                loadCheckout();
            }
        });
    }).catch(function() {});
}

function redirectAfterLoginCheck(url) {
    mergeGuestCartIntoDb().then(function() {
        setTimeout(function() { window.location.href = url; }, 500);
    }).catch(function() {
        setTimeout(function() { window.location.href = url; }, 500);
    });
}

// ===============================
// STORAGE HELPERS
// ===============================

function readStorageValue(key, fallback = null) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? fallback : value;
    } catch (error) {
        console.warn("Could not read storage:", error);
        return fallback;
    }
}

function writeStorageValue(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (error) {
        console.warn("Could not write storage:", error);
        return false;
    }
}

// ===============================
// TOAST NOTIFICATION
// ===============================

function showToast(message, type) {
    type = type || "success";

    const existing = document.querySelectorAll(".fm-toast");
    existing.forEach(function(t) { t.remove(); });

    var icon = "✓";
    var bgColor = "#159447";

    if (type === "error") {
        icon = "✕";
        bgColor = "#e74c3c";
    } else if (type === "warning") {
        icon = "⚠";
        bgColor = "#f39c12";
    } else if (type === "info") {
        icon = "ℹ";
        bgColor = "#3498db";
    }

    var toast = document.createElement("div");
    toast.className = "fm-toast";
    toast.innerHTML = '<span class="fm-toast-icon">' + icon + '</span><span>' + message + '</span>';
    toast.style.background = bgColor;

    document.body.appendChild(toast);

    requestAnimationFrame(function() {
        toast.classList.add("fm-toast-show");
    });

    setTimeout(function() {
        toast.classList.remove("fm-toast-show");
        setTimeout(function() {
            toast.remove();
        }, 400);
    }, 2500);
}

// ===============================
// ADD TO CART
// ===============================

function addToCart(name, price, unit) {
    var product = products.find(function(p) { return p.name === name; });
    var u = unit || (product ? product.unit : "kg");
    var opt = getActiveOption(name, u);
    var scaled = Math.round(price * opt.mult * 100) / 100;
    var existingProduct = cart.find(function(item) { return item.name === name; });

    if (existingProduct) {
        existingProduct.quantity++;
        existingProduct.price = scaled;
        existingProduct.qtyLabel = opt.label;
        existingProduct.mult = opt.mult;
        existingProduct.unit = u;
    } else {
        cart.push({ name: name, price: scaled, quantity: 1, qtyLabel: opt.label, mult: opt.mult, unit: u });
    }

    saveCart();
    updateCart();
    updateAllCartControls();
    showToast(name + " (" + opt.label + ") added to cart!", "success");
}

// ===============================
// UPDATE CART
// ===============================

function updateCart() {
    var totalItems = 0;
    var totalPrice = 0;

    cart.forEach(function(item) {
        totalItems += item.quantity;
        totalPrice += item.price * item.quantity;
    });

    var cartCount = document.getElementById("cartCount");
    if (cartCount) {
        cartCount.innerText = totalItems;
    }

    if (document.querySelectorAll(".product").length > 0) {
        updateAllCartControls();
    }

    var cartItems = document.getElementById("cartItems");
    if (!cartItems) return;

    cartItems.innerHTML = "";

    if (cart.length === 0) {
        cartItems.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">🛒</div><h3>Your cart is empty</h3><p>Add some fresh products!</p></div>';
    } else {
        cart.forEach(function(item, index) {
            var itemLabel = item.name + (item.qtyLabel ? " (" + item.qtyLabel + ")" : "");
            cartItems.innerHTML += '<div class="cart-item"><div class="cart-item-info"><strong>' + itemLabel + '</strong><br><span class="cart-item-price">₹' + item.price + ' × ' + item.quantity + ' = ₹' + (item.price * item.quantity) + '</span></div><div class="cart-item-actions"><button onclick="decreaseQuantity(' + index + ')">−</button><strong class="cart-item-qty">' + item.quantity + '</strong><button onclick="increaseQuantity(' + index + ')">+</button><button class="cart-item-remove" onclick="removeItem(' + index + ')">✕</button></div></div>';
        });
    }

    var cartTotal = document.getElementById("cartTotal");
    if (cartTotal) {
        cartTotal.innerText = "Total: ₹" + totalPrice;
    }

    var minOrderNoteCart = document.getElementById("minOrderNoteCart");
    if (minOrderNoteCart) {
        if (totalPrice < MIN_ORDER_AMOUNT && totalPrice > 0) {
            minOrderNoteCart.style.display = "block";
            minOrderNoteCart.innerHTML = '⚠️ Minimum order is <strong>₹' + MIN_ORDER_AMOUNT + '</strong>. Add ₹' + (MIN_ORDER_AMOUNT - totalPrice) + ' more.';
        } else {
            minOrderNoteCart.style.display = "none";
        }
    }
}

// ===============================
// INCREASE / DECREASE / REMOVE
// ===============================

function increaseQuantity(index) {
    if (!cart[index]) return;
    cart[index].quantity++;
    saveCart();
    updateCart();
}

function decreaseQuantity(index) {
    if (!cart[index]) return;
    if (cart[index].quantity > 1) {
        cart[index].quantity--;
    } else {
        cart.splice(index, 1);
    }
    saveCart();
    updateCart();
}

function removeItem(index) {
    if (!cart[index]) return;
    var name = cart[index].name;
    cart.splice(index, 1);
    saveCart();
    updateCart();
    showToast(name + " removed from cart", "warning");
}

// ===============================
// OPEN / CLOSE CART
// ===============================

function openCart() {
    var cartModal = document.getElementById("cartModal");
    if (cartModal) {
        cartModal.classList.add("cart-modal-open");
    }
    updateCart();
}

function closeCart() {
    var cartModal = document.getElementById("cartModal");
    if (cartModal) {
        cartModal.classList.remove("cart-modal-open");
    }
}

// ===============================
// SCROLL TO PRODUCTS
// ===============================

function scrollToProducts() {
    var products = document.getElementById("products");
    if (products) {
        products.scrollIntoView({ behavior: "smooth" });
    }
}

// ===============================
// CATALOG FILTERS (category + search + price + sort)
// ===============================

var CATALOG_PAGE_SIZE = 8;
var PRICE_MIN = 0;
var PRICE_MAX = 0;
var catalogFilters = { category: "All", search: "", minPrice: 0, maxPrice: 100000, sort: "default" };
var catalogPage = 1;
var searchTimer = null;

function collectPrices() {
    var prices = [];
    products.forEach(function(p) { prices.push(p.price); });
    return prices;
}

function initPriceRange() {
    var prices = collectPrices();
    if (!prices.length) return;
    PRICE_MIN = Math.min.apply(null, prices);
    PRICE_MAX = Math.max.apply(null, prices);
    catalogFilters.minPrice = PRICE_MIN;
    catalogFilters.maxPrice = PRICE_MAX;

    var minEl = document.getElementById("priceMin");
    var maxEl = document.getElementById("priceMax");
    if (minEl && maxEl) {
        var lo = Math.floor(PRICE_MIN);
        var hi = Math.ceil(PRICE_MAX);
        minEl.min = lo; minEl.max = hi; minEl.value = lo;
        maxEl.min = lo; maxEl.max = hi; maxEl.value = hi;
    }
    updatePriceRangeUI();
}

function getCatalogIndices() {
    var search = catalogFilters.search.toLowerCase().trim();
    var list = [];

    products.forEach(function(p, i) {
        if (catalogFilters.category !== "All" && p.category !== catalogFilters.category) return;
        if (search) {
            if (p.name.toLowerCase().indexOf(search) === -1) return;
        }
        if (p.price < catalogFilters.minPrice || p.price > catalogFilters.maxPrice) return;
        list.push(i);
    });

    var sort = catalogFilters.sort;
    if (sort === "low") {
        list.sort(function(a, b) { return products[a].price - products[b].price || a - b; });
    } else if (sort === "high") {
        list.sort(function(a, b) { return products[b].price - products[a].price || a - b; });
    } else if (sort === "popular") {
        list.sort(function(a, b) {
            var ra = getProductRating(products[a].name);
            var rb = getProductRating(products[b].name);
            if (rb.rating !== ra.rating) return rb.rating - ra.rating;
            if (rb.count !== ra.count) return rb.count - ra.count;
            return a - b;
        });
    }

    return list;
}

function applyCatalogFilter() {
    catalogPage = 1;
    renderCatalog();
}

function productCardHTML(index) {
    var product = products[index];
    var r = getProductRating(product.name);
    var inCart = cart.find(function(c) { return c.name === product.name; });
    var qty = inCart ? inCart.quantity : 0;
    var wishClass = isWishlisted(product.name) ? "wishlist-active" : "";
    var safeName = product.name.replace(/'/g, "\\'");

    return '<div class="product" data-category="' + product.category + '" onclick="openProductDetail(' + index + ')">' +
        '<button type="button" class="wishlist-heart ' + wishClass + '" data-name="' + product.name.replace(/"/g, "&quot;") + '" onclick="event.stopPropagation(); toggleWishlist(\'' + safeName + '\')">♥</button>' +
        '<button type="button" class="whatsapp-share-btn product-share" title="Share on WhatsApp" onclick="event.stopPropagation(); shareOnWhatsApp(\'' + safeName + '\',' + product.price + ',\'' + product.unit + '\',' + index + ')">Share</button>' +
        '<div class="product-image" style="' + imageStyle(product.name, product.gradient) + '">' + productImgHTML(product.name) + '</div>' +
        '<h3>' + product.name + '</h3>' +
        starHTML(r.rating) +
        '<span class="rating-count">(' + r.count + ')</span>' +
        '<p class="product-price">₹' + product.price + ' / ' + product.unit + '</p>' +
        '<span class="product-badge">' + product.category + '</span>' +
        '<div class="card-controls">' + cartControlsHTML(safeName, product.price, qty, product.unit) + '</div>' +
    '</div>';
}

function updateCategoryButtons() {
    var btns = document.querySelectorAll(".cat-filter-btn");
    btns.forEach(function(btn) {
        btn.classList.toggle("cat-filter-active", btn.dataset.cat === catalogFilters.category);
    });
}

function filterCategory(category) {
    catalogFilters.category = category;
    updateCategoryButtons();
    applyCatalogFilter();
    scrollToProducts();
}

function showAllProducts() {
    catalogFilters.category = "All";
    updateCategoryButtons();
    applyCatalogFilter();
    scrollToProducts();
}

function searchProducts() {
    var searchInput = document.getElementById("searchInput");
    if (!searchInput) return;
    var search = searchInput.value.toLowerCase().trim();
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
        catalogFilters.search = search;
        applyCatalogFilter();
    }, 200);
}

function onPriceRangeChange() {
    var minEl = document.getElementById("priceMin");
    var maxEl = document.getElementById("priceMax");
    if (!minEl || !maxEl) return;
    var min = parseInt(minEl.value, 10);
    var max = parseInt(maxEl.value, 10);
    if (isNaN(min)) min = PRICE_MIN;
    if (isNaN(max)) max = PRICE_MAX;
    if (min > max) {
        var t = min; min = max; max = t;
        minEl.value = min;
        maxEl.value = max;
    }
    catalogFilters.minPrice = min;
    catalogFilters.maxPrice = max;
    updatePriceRangeUI();
    applyCatalogFilter();
}

function updatePriceRangeUI() {
    var label = document.getElementById("priceRangeLabel");
    if (label) label.innerText = "₹" + catalogFilters.minPrice + " – ₹" + catalogFilters.maxPrice;

    var minEl = document.getElementById("priceMin");
    var maxEl = document.getElementById("priceMax");
    if (!minEl || !maxEl) return;

    var lo = parseInt(minEl.min, 10) || 0;
    var hi = parseInt(minEl.max, 10) || 1;
    var span = (hi - lo) || 1;
    var pMin = ((catalogFilters.minPrice - lo) / span) * 100;
    var pMax = ((catalogFilters.maxPrice - lo) / span) * 100;
    var grad = "linear-gradient(to right, var(--border-color) 0%, var(--border-color) " + pMin + "%, var(--green-primary) " + pMin + "%, var(--green-primary) " + pMax + "%, var(--border-color) " + pMax + "%, var(--border-color) 100%)";
    minEl.style.background = grad;
    maxEl.style.background = grad;
}

function changeSort(value) {
    catalogFilters.sort = value;
    applyCatalogFilter();
}

function clearFilters() {
    catalogFilters = { category: "All", search: "", minPrice: PRICE_MIN, maxPrice: PRICE_MAX, sort: "default" };

    var searchInput = document.getElementById("searchInput");
    if (searchInput) searchInput.value = "";

    var sortEl = document.getElementById("sortSelect");
    if (sortEl) sortEl.value = "default";

    var minEl = document.getElementById("priceMin");
    var maxEl = document.getElementById("priceMax");
    if (minEl) { minEl.value = PRICE_MIN; }
    if (maxEl) { maxEl.value = PRICE_MAX; }

    updateCategoryButtons();
    updatePriceRangeUI();
    applyCatalogFilter();
}

// ===============================
// DARK MODE
// ===============================

function initDarkMode() {
    var savedTheme = readStorageValue("freshMartTheme", "light");
    if (savedTheme === "dark") {
        document.body.classList.add("dark-mode");
    }
    updateDarkModeIcon();
}

function toggleDarkMode() {
    document.body.classList.toggle("dark-mode");
    var isDark = document.body.classList.contains("dark-mode");
    writeStorageValue("freshMartTheme", isDark ? "dark" : "light");
    updateDarkModeIcon();
}

function updateDarkModeIcon() {
    var btn = document.getElementById("darkModeToggle");
    if (!btn) return;
    if (document.body.classList.contains("dark-mode")) {
        btn.innerHTML = "☀️";
        btn.title = "Switch to Light Mode";
    } else {
        btn.innerHTML = "🌙";
        btn.title = "Switch to Dark Mode";
    }
}

// ===============================
// SKELETON LOADING
// ===============================

function showSkeleton() {
    var container = document.getElementById("productContainer");
    if (!container) return;

    var html = "";
    for (var i = 0; i < 12; i++) {
        html += '<div class="product skeleton-card"><div class="skeleton-img"></div><div class="skeleton-text skeleton-text-long"></div><div class="skeleton-text skeleton-text-short"></div><div class="skeleton-text skeleton-text-btn"></div></div>';
    }
    container.innerHTML = html;
}

// ===============================
// RATINGS (deterministic seed)
// ===============================

function getProductRating(name) {
    var seed = 0;
    for (var i = 0; i < name.length; i++) {
        seed += name.charCodeAt(i);
    }
    var rating = 3.5 + ((seed % 15) / 10);
    if (rating > 5) rating = 5;
    var count = 10 + (seed % 90);
    return { rating: Math.round(rating * 10) / 10, count: count };
}

function starHTML(rating, size) {
    size = size || "";
    var full = Math.floor(rating);
    var half = (rating - full) >= 0.25 && (rating - full) < 0.75;
    var empty = 5 - full - (half ? 1 : 0);
    var html = '<span class="stars' + (size ? " stars-" + size : "") + '">';
    for (var i = 0; i < full; i++) html += '★';
    if (half) html += '<span class="star-half">★</span>';
    for (var j = 0; j < empty; j++) html += '<span class="star-off">★</span>';
    html += '</span>';
    return html;
}

// ===============================
// WISHLIST
// ===============================

var wishlist = [];

function loadWishlist() {
    var saved = readStorageValue("freshMartWishlist", "[]");
    try {
        wishlist = JSON.parse(saved);
        if (!Array.isArray(wishlist)) wishlist = [];
    } catch (e) {
        wishlist = [];
    }
    updateWishlistUI();
}

function saveWishlist() {
    writeStorageValue("freshMartWishlist", JSON.stringify(wishlist));
}

function isWishlisted(name) {
    return wishlist.indexOf(name) !== -1;
}

function toggleWishlist(name) {
    var idx = wishlist.indexOf(name);
    if (idx !== -1) {
        wishlist.splice(idx, 1);
        showToast(name + " removed from wishlist", "warning");
    } else {
        wishlist.push(name);
        showToast(name + " added to wishlist ❤️", "success");
    }
    saveWishlist();
    updateWishlistUI();
}

function updateWishlistUI() {
    var hearts = document.querySelectorAll(".wishlist-heart");
    hearts.forEach(function(heart) {
        var name = heart.getAttribute("data-name");
        if (isWishlisted(name)) {
            heart.classList.add("wishlist-active");
        } else {
            heart.classList.remove("wishlist-active");
        }
    });

    var countEl = document.getElementById("wishlistCount");
    if (countEl) countEl.innerText = wishlist.length;
}

function toggleWishlistPage() {
    var modal = document.getElementById("wishlistModal");
    var items = document.getElementById("wishlistItems");
    if (!modal || !items) return;

    var filtered = wishlist.filter(function(name) {
        return products.find(function(p) { return p.name === name; });
    });

    if (filtered.length === 0) {
        items.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">❤️</div><h3>Your wishlist is empty</h3><p>Tap the ♥ on any product to save it here.</p></div>';
    } else {
        var html = "";
        filtered.forEach(function(name) {
            var product = products.find(function(p) { return p.name === name; });
            if (!product) return;
            var r = getProductRating(product.name);
            var safeName = product.name.replace(/'/g, "\\'");
            var id = products.indexOf(product);
            html += '<div class="wishlist-item"><div class="product-image" style="' + imageStyle(product.name, product.gradient) + '" onclick="openProductDetail(' + id + ')">' + productImgHTML(product.name) + '</div><div class="wishlist-item-info"><h4>' + product.name + '</h4>' + starHTML(r.rating) + '<p class="product-price">₹' + product.price + ' / ' + product.unit + '</p><div class="wishlist-item-actions"><button type="button" class="product-add-btn" onclick="event.stopPropagation(); addToCart(\'' + safeName + '\', ' + product.price + '); toggleWishlist(\'' + safeName + '\'); renderWishlistItems();">Move to Cart</button><button type="button" class="wishlist-remove-btn" onclick="event.stopPropagation(); toggleWishlist(\'' + safeName + '\'); renderWishlistItems();">Remove</button></div></div></div>';
        });
        items.innerHTML = html;
    }

    modal.classList.add("cart-modal-open");
}

function closeWishlistPage() {
    var modal = document.getElementById("wishlistModal");
    if (modal) modal.classList.remove("cart-modal-open");
}

function renderWishlistItems() {
    updateWishlistUI();
    toggleWishlistPage();
}

// ===============================
// RECENTLY VIEWED
// ===============================

function trackRecentlyViewed(index) {
    var recent = [];
    var saved = readStorageValue("freshMartRecent", "[]");
    try { recent = JSON.parse(saved); } catch (e) { recent = []; }

    recent = recent.filter(function(id) { return id !== index; });
    recent.unshift(index);
    if (recent.length > 8) recent.pop();
    writeStorageValue("freshMartRecent", JSON.stringify(recent));
}

function renderRecentlyViewed() {
    var container = document.getElementById("recentlyViewedContainer");
    if (!container) return;

    var recent = [];
    var saved = readStorageValue("freshMartRecent", "[]");
    try { recent = JSON.parse(saved); } catch (e) { recent = []; }

    var validIds = recent.filter(function(id) { return products[id]; });

    if (validIds.length === 0) {
        container.innerHTML = '<p class="recent-empty">Products you view will appear here.</p>';
        return;
    }

    var section = document.getElementById("recentlyViewedSection");
    if (section) section.style.display = "block";

    var html = "";
    validIds.forEach(function(id) {
        var product = products[id];
        var r = getProductRating(product.name);
        html += '<div class="product recent-product" onclick="openProductDetail(' + id + ')"><div class="product-image recent-img" style="' + imageStyle(product.name, product.gradient) + '">' + productImgHTML(product.name) + '</div><h3>' + product.name + '</h3>' + starHTML(r.rating) + '<p class="product-price">₹' + product.price + ' / ' + product.unit + '</p><button type="button" class="product-add-btn" onclick="event.stopPropagation(); addToCart(\'' + product.name.replace(/'/g, "\\'") + '\', ' + product.price + ')">Add To Cart</button></div>';
    });

    container.innerHTML = html;
}







function imageStyle(name, gradient) {
    return "background:" + (gradient || "#eaffef");
}

// ===============================
// PRODUCT IMAGES
// ===============================

var PRODUCT_IMAGE_FILES = {
    "Fresh Tomato": "images/tomato.png",
    "Potato": "images/potato.png",
    "Onion": "images/onion.png",
    "Carrot": "images/carrot.png",
    "Cauliflower": "images/cauliflower.png",
    "Cabbage": "images/cabbage.png",
    "Capsicum": "images/bell_pepper_capsicum.png",
    "Green Peas": "images/green_peas.png",
    "Cucumber": "images/cucumber.png",
    "Spinach (Palak)": "images/spinach.png",
    "Brinjal": "images/brinjal.png",
    "Bottle Gourd (Lauki)": "images/bottle_gourd.png",
    "Bread": "images/Bread.jfif",
    "Bitter Gourd (Karela)": "images/Bitter_Gourd.png",
    "Radish (Mooli)": "images/radish.png",
    "Beetroot": "images/Beetroot.png",
    "Garlic": "images/garlic.png",
    "Ginger": "images/ginger.png",
    "Green Chilli": "images/green_chilli.png",
    "Coriander (Dhaniya)": "images/coriander.png",
    "Mint (Pudina)": "images/mint.png",
    "Lemon": "images/lemon.png",
    "Mushroom": "images/mushroom.png",
    "Sweet Corn": "images/corn.png",
    "Broccoli": "images/Broccoli.jfif",
    "Pumpkin (Kaddu)": "images/pumpkin.jfif",
    "Curry Leaves": "images/curry_leaves.png",
    "Apple": "images/Apple.png",
    "Banana": "images/Banana.png",
    "Orange": "images/orange.png",
    "Papaya": "images/papaya.jpg",
    "Mango": "images/Mango.jfif",
    "Grapes": "images/Green_Grapes.jfif",
    "Watermelon": "images/Watermelon.jfif",
    "Pomegranate (Anar)": "images/Pomegranate.jfif",
    "Guava (Amrood)": "images/guava.png",
    "Kiwi": "images/kiwi.png",
    "Pineapple": "images/pineapple.png",
    "Strawberry": "images/strawberry.png",
    "Cherry": "images/cherry.png",
    "Litchi": "images/lychee.png",
    "Peach (Aadoo)": "images/Peach.jfif",
    "Plum (Alu Bukhara)": "images/plums.jfif",
    "Fig (Anjeer)": "images/fig.jfif",
    "Coconut": "images/coconut.jfif",
    "Dragon Fruit": "images/dragon fruit.jfif",
    "Avocado": "images/Avocado.png",
    "Rice": "images/rice.png",
    "Milk": "images/milk.png",
    "Wheat Atta": "images/wheat_flour.png",
    "Toor Dal": "images/ahrar dal.png",
    "Sugar": "images/sugar.jfif",
    "Salt": "images/salt.jfif",
    "Cooking Oil": "images/Cooking_Oil.jfif",
    "Tea Powder": "images/Tea_Powder.jfif",
    "Eggs": "images/eggs.png"
};

function getProductImage(name) {
    return PRODUCT_IMAGE_FILES[name] || "";
}

function productImgHTML(name) {
    var img = getProductImage(name);
    if (!img) {
        return "";
    }
    return '<img class="product-photo" src="' + img + '" alt="' + name + '">';
}

// ===============================
// WHATSAPP SHARE
// ===============================

function getStoreUrl() {
    return window.location.origin || "http://localhost:5000";
}

function shareOnWhatsApp(name, price, unit, id) {
    var text = "*FreshMart* ke sabse fresh! \n\n" +
               name + " — ₹" + price + " / " + unit + "\n" +
               "Fresh aur quality guaranteed! \n\n" +
               "Yahan se order karo: " + getStoreUrl() + "/product-detail.html?id=" + id;
    var url = "https://wa.me/?text=" + encodeURIComponent(text);
    window.open(url, "_blank");
}

// ===============================
// RENDER PRODUCTS
// ===============================

function renderProducts() {
    catalogPage = 1;
    renderCatalog();
}

function renderCatalog() {
    var container = document.getElementById("productContainer");
    if (!container) return;

    var list = getCatalogIndices();
    var shown = Math.min(catalogPage * CATALOG_PAGE_SIZE, list.length);
    var html = "";
    for (var i = 0; i < shown; i++) {
        html += productCardHTML(list[i]);
    }
    container.innerHTML = html;

    var loadMoreBtn = document.getElementById("loadMoreBtn");
    if (loadMoreBtn) {
        var hasMore = list.length > shown;
        loadMoreBtn.style.display = hasMore ? "inline-block" : "none";
        loadMoreBtn.innerHTML = "<span>Load More</span> (" + (list.length - shown) + " more)";
    }

    var info = document.getElementById("resultsInfo");
    if (info) info.innerText = list.length === 0 ? "" : "Showing " + shown + " of " + list.length + " products";

    var noResults = document.getElementById("noResults");
    if (noResults) noResults.style.display = list.length === 0 ? "block" : "none";

    updateWishlistUI();
    updateAllCartControls();
}

function loadMoreProducts() {
    var list = getCatalogIndices();
    if (catalogPage * CATALOG_PAGE_SIZE >= list.length) return;
    catalogPage++;
    renderCatalog();
}

// ===============================
// CART CONTROLS (quantity selector)
// ===============================

function cartControlsHTML(name, price, qty, unit) {
    var options = getQtyOptions(unit || "kg");
    var active = getActiveOption(name, unit || "kg");

    var chips = '<div class="qty-chips">';
    options.forEach(function(o) {
        var cls = (o.label === active.label) ? "qty-chip active" : "qty-chip";
        chips += '<button type="button" class="' + cls + '" onclick="event.stopPropagation(); selectQtyOption(\'' + name + '\',\'' + o.label + '\',' + o.mult + ',\'' + unit + '\')">' + o.label + '</button>';
    });
    chips += '</div>';

    var main;
    if (qty > 0) {
        main = '<div class="qty-selector"><button type="button" class="qty-btn qty-minus" onclick="event.stopPropagation(); changeCardQty(\'' + name + '\', -1, ' + price + ')">−</button><span class="qty-value">' + qty + '</span><button type="button" class="qty-btn qty-plus" onclick="event.stopPropagation(); changeCardQty(\'' + name + '\', 1, ' + price + ')">+</button></div>';
    } else {
        main = '<button type="button" class="product-add-btn" onclick="event.stopPropagation(); addToCart(\'' + name + '\', ' + price + ',\'' + unit + '\')">Add To Cart</button>';
    }
    var buy = '<button type="button" class="buy-now-btn" onclick="event.stopPropagation(); buyNow(\'' + name + '\', ' + price + ',\'' + unit + '\')">Buy Now</button>';

    return chips + '<div class="card-btn-row">' + main + buy + '</div>';
}

function changeCardQty(name, delta, price) {
    var existing = cart.find(function(item) { return item.name === name; });

    if (!existing) {
        cart.push({ name: name, price: price, quantity: 1, qtyLabel: "", mult: 1 });
    } else {
        existing.quantity += delta;
        if (existing.quantity <= 0) {
            cart = cart.filter(function(item) { return item.name !== name; });
            delete qtySelections[name];
        }
    }

    saveCart();
    updateCart();
    updateAllCartControls();
}

function updateAllCartControls() {
    var productsEls = document.querySelectorAll(".product");
    productsEls.forEach(function(productEl) {
        var ctl = productEl.querySelector(".card-controls");
        if (!ctl) return;
        var title = productEl.querySelector("h3");
        if (!title) return;
        var nameEl = title.innerText.trim();
        var product = products.find(function(p) { return p.name === nameEl; });
        if (!product) return;
        var inCart = cart.find(function(c) { return c.name === nameEl; });
        var qty = inCart ? inCart.quantity : 0;
        var safeName = nameEl.replace(/'/g, "\\'");
        ctl.innerHTML = cartControlsHTML(safeName, product.price, qty, product.unit);
    });
}

// ===============================
// QUANTITY / WEIGHT SELECTORS
// ===============================

var MIN_ORDER_AMOUNT = 250;
var qtySelections = {};

function getQtyOptions(unit) {
    if (unit === "kg")    return [{ label: "250g", mult: 0.25 }, { label: "500g", mult: 0.5 }, { label: "1kg", mult: 1 }, { label: "2kg", mult: 2 }];
    if (unit === "litre") return [{ label: "250ml", mult: 0.25 }, { label: "500ml", mult: 0.5 }, { label: "1L", mult: 1 }, { label: "2L", mult: 2 }];
    if (unit === "bunch") return [{ label: "1", mult: 1 }, { label: "2", mult: 2 }, { label: "3", mult: 3 }];
    if (unit === "dozen") return [{ label: "1", mult: 1 }, { label: "2", mult: 2 }];
    return [{ label: "1", mult: 1 }, { label: "2", mult: 2 }, { label: "3", mult: 3 }, { label: "5", mult: 5 }];
}

function getActiveOption(name, unit) {
    if (qtySelections[name]) return qtySelections[name];
    var item = cart.find(function(c) { return c.name === name; });
    if (item && item.qtyLabel) return { label: item.qtyLabel, mult: item.mult || 1 };
    var options = getQtyOptions(unit || "kg");
    if (unit === "kg" || unit === "litre") {
        var half = options.filter(function(o) { return o.mult === 0.5; });
        return half[0] || options[0];
    }
    return options[0];
}

function selectQtyOption(name, label, mult, unit) {
    qtySelections[name] = { label: label, mult: mult };
    var item = cart.find(function(c) { return c.name === name; });
    if (item) {
        var product = products.find(function(p) { return p.name === name; });
        var base = product ? product.price : (item.price / (item.mult || 1));
        item.price = Math.round(base * mult * 100) / 100;
        item.qtyLabel = label;
        item.mult = mult;
        item.unit = unit;
        saveCart();
        updateCart();
    }
    updateAllCartControls();
}

function buyNow(name, price, unit) {
    addToCart(name, price, unit);
    proceedToCheckout();
}

// ===============================
// PRODUCT DETAIL PAGE
// ===============================

function openProductDetail(index) {
    trackRecentlyViewed(index);
    window.location.href = "product-detail.html?id=" + index;
}

function loadProductDetail() {
    var detailContainer = document.getElementById("productDetail");
    if (!detailContainer) return;

    var params = new URLSearchParams(window.location.search);
    var id = parseInt(params.get("id"));

    if (isNaN(id) || !products[id]) {
        detailContainer.innerHTML = '<div class="detail-not-found"><h2>Product not found</h2><a href="index.html">← Back to Shop</a></div>';
        return;
    }

    var p = products[id];
    var r = getProductRating(p.name);
    var reviews = getReviews(p.name);
    var recent = [];
    var saved = readStorageValue("freshMartRecent", "[]");
    try { recent = JSON.parse(saved); } catch (e) { recent = []; }
    if (recent[recent.length - 1] !== id) {
        recent = recent.filter(function(x) { return x !== id; });
        recent.push(id);
    }
    if (recent.length > 8) recent.shift();
    writeStorageValue("freshMartRecent", JSON.stringify(recent));

    var wishClass = isWishlisted(p.name) ? "wishlist-active" : "";
    var safeName = p.name.replace(/'/g, "\\'");

    var reviewsHTML = reviewsHTMLFor(p.name, reviews);

    var relatedHTML = "";
    var related = products.filter(function(item) {
        return item.category === p.category && item.name !== p.name;
    });

    var shuffled = related.sort(function() { return 0.5 - Math.random(); });
    var showRelated = shuffled.slice(0, 4);

    showRelated.forEach(function(item, i) {
        var origIndex = products.indexOf(item);
        var ir = getProductRating(item.name);
        var safeRelName = item.name.replace(/'/g, "\\'");
        relatedHTML += '<div class="product" data-category="' + item.category + '" onclick="window.location.href=\'product-detail.html?id=' + origIndex + '\'"><div class="product-image" style="' + imageStyle(item.name, item.gradient) + '">' + productImgHTML(item.name) + '</div><h3>' + item.name + '</h3>' + starHTML(ir.rating) + '<p class="product-price">₹' + item.price + ' / ' + item.unit + '</p><button type="button" class="product-add-btn" onclick="event.stopPropagation(); addToCart(\'' + safeRelName + '\', ' + item.price + ')">Add To Cart</button></div>';
    });

    detailContainer.innerHTML = '' +
        '<div class="detail-hero" style="' + imageStyle(p.name, p.gradient) + '">' + productImgHTML(p.name) +
            '<button type="button" class="wishlist-heart detail-wishlist ' + wishClass + '" data-name="' + p.name.replace(/"/g, "&quot;") + '" onclick="toggleWishlist(\'' + safeName + '\')">♥</button>' +
        '</div>' +
            '<div class="detail-info">' +
            '<button type="button" class="whatsapp-share-btn detail-share" onclick="shareOnWhatsApp(\'' + safeName + '\',' + p.price + ',\'' + p.unit + '\',' + id + ')">WhatsApp Share</button>' +
            '<span class="product-badge">' + p.category + '</span>' +
            '<h1>' + p.name + '</h1>' +
            '<div class="detail-rating">' + starHTML(r.rating) + '<span class="rating-count">' + r.rating.toFixed(1) + ' (' + r.count + ' ratings)</span></div>' +
            '<div class="detail-price">₹' + p.price + ' / ' + p.unit + '</div>' +
            '<p class="detail-desc">' + p.description + '</p>' +
            '<div class="detail-origin">' + p.origin + '</div>' +
            '<div class="detail-section">' +
                '<h3>Nutrition Facts</h3>' +
                '<p>' + p.nutrition + '</p>' +
            '</div>' +
            '<div class="detail-section">' +
                '<h3>💡 Storage Tips</h3>' +
                '<p>' + p.tips + '</p>' +
            '</div>' +
            '<div class="detail-actions">' +
                '<div class="detail-qty">' +
                    '<button onclick="detailQtyChange(-1)">−</button>' +
                    '<span id="detailQty">1</span>' +
                    '<button onclick="detailQtyChange(1)">+</button>' +
                '</div>' +
                '<div class="detail-btn-row">' +
                    '<button class="detail-add-btn" onclick="addDetailToCart(\'' + safeName + '\', ' + p.price + ')">Add To Cart</button>' +
                    '<button class="buy-now-btn" onclick="buyNowDetail(\'' + safeName + '\', ' + p.price + ', \'' + p.unit + '\')">⚡ Buy Now</button>' +
                '</div>' +
            '</div>' +
            reviewsHTML +
        '</div>' +
        '<div class="detail-related">' +
            '<h2>You May Also Like</h2>' +
            '<div class="product-container">' + relatedHTML + '</div>' +
        '</div>';
}

// ===============================
// REVIEWS & RATINGS
// ===============================

function getReviews(name) {
    var all = readStorageValue("freshMartReviews", "{}");
    try {
        all = JSON.parse(all);
        if (all[name]) return all[name];
    } catch (e) {}
    return [];
}

function saveReview(name, rating, comment, userName) {
    var all = readStorageValue("freshMartReviews", "{}");
    try { all = JSON.parse(all); } catch (e) { all = {}; }
    if (!all[name]) all[name] = [];

    all[name].push({
        rating: rating,
        comment: comment,
        user: userName || "Anonymous",
        date: new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    });

    writeStorageValue("freshMartReviews", JSON.stringify(all));
}

function submitReview() {
    var params = new URLSearchParams(window.location.search);
    var id = parseInt(params.get("id"));
    if (!products[id]) return;

    var name = products[id].name;
    var ratingSel = document.querySelector('input[name="userRating"]:checked');
    var rating = ratingSel ? parseInt(ratingSel.value) : 5;
    var comment = document.getElementById("reviewComment").value.trim();
    var userName = document.getElementById("reviewName").value.trim();

    if (!comment) {
        showToast("Please write a review comment.", "error");
        return;
    }

    saveReview(name, rating, comment, userName);
    showToast("Thanks for your review! ⭐", "success");
    document.getElementById("reviewComment").value = "";
    document.getElementById("reviewName").value = "";
    loadProductDetail();
}

function reviewsHTMLFor(name, reviews) {
    var html = '<div class="detail-section reviews-section">';
    html += '<h3>⭐ Customer Reviews</h3>';

    if (!reviews || reviews.length === 0) {
        html += '<p class="reviews-none">No reviews yet. Be the first to review this product!</p>';
    } else {
        reviews.slice(-4).reverse().forEach(function(rev) {
            html += '<div class="review-item">' +
                '<div class="review-header"><span class="review-user">👤 ' + rev.user + '</span>' + starHTML(rev.rating) + '<span class="review-date">' + rev.date + '</span></div>' +
                '<p class="review-comment">' + rev.comment + '</p>' +
            '</div>';
        });
    }

    html += '<div class="review-form">' +
        '<h4>Write a Review</h4>' +
        '<div class="review-star-input">' +
            '<input type="radio" id="r5" name="userRating" value="5"><label for="r5">★</label>' +
            '<input type="radio" id="r4" name="userRating" value="4"><label for="r4">★</label>' +
            '<input type="radio" id="r3" name="userRating" value="3"><label for="r3">★</label>' +
            '<input type="radio" id="r2" name="userRating" value="2"><label for="r2">★</label>' +
            '<input type="radio" id="r1" name="userRating" value="1"><label for="r1">★</label>' +
        '</div>' +
        '<input type="text" id="reviewName" class="review-input" placeholder="Your name" maxlength="30">' +
        '<textarea id="reviewComment" class="review-textarea" placeholder="Share your experience..."></textarea>' +
        '<button type="button" class="review-submit" onclick="submitReview()">Submit Review</button>' +
    '</div>';

    html += '</div>';
    return html;
}

var detailQtyValue = 1;

function detailQtyChange(delta) {
    detailQtyValue = Math.max(1, detailQtyValue + delta);
    var el = document.getElementById("detailQty");
    if (el) el.innerText = detailQtyValue;

    var params = new URLSearchParams(window.location.search);
    var id = parseInt(params.get("id"));
    if (products[id]) {
        var product = products[id];
        var opt = getActiveOption(product.name, product.unit);
        var addBtn = document.querySelector(".detail-add-btn");
        if (addBtn) {
            addBtn.innerText = "🛒 Add To Cart — ₹" + (Math.round(product.price * opt.mult * 100) / 100 * detailQtyValue);
        }
    }
}

function addDetailToCart(name, price, unit) {
    var opt = getActiveOption(name, unit || "kg");
    var scaled = Math.round(price * opt.mult * 100) / 100;
    for (var i = 0; i < detailQtyValue; i++) {
        var existingProduct = cart.find(function(item) { return item.name === name; });
        if (existingProduct) {
            existingProduct.quantity++;
        } else {
            cart.push({ name: name, price: scaled, quantity: 1, qtyLabel: opt.label, mult: opt.mult, unit: unit });
        }
    }
    saveCart();
    updateCart();
    showToast(detailQtyValue + "x " + name + " added to cart!", "success");
    detailQtyValue = 1;
    var el = document.getElementById("detailQty");
    if (el) el.innerText = 1;
}

function buyNowDetail(name, price, unit) {
    addDetailToCart(name, price, unit);
    proceedToCheckout();
}

// ===============================
// RENDER SKELETON → PRODUCTS
// ===============================

function initHomePage() {
    showSkeleton();
    initBannerSlider();
    setTimeout(function() {
        initPriceRange();
        renderProducts();
        loadCart();
        renderRecentlyViewed();
    }, 1200);
}

// ===============================
// OFFER BANNER SLIDER
// ===============================

var bannerIndex = 0;
var bannerTimer = null;

function initBannerSlider() {
    var track = document.getElementById("bannerTrack");
    var dots = document.getElementById("bannerDots");
    if (!track || !dots) return;

    var slides = track.children.length;
    if (slides <= 1) return;

    dots.innerHTML = "";
    for (var i = 0; i < slides; i++) {
        var d = document.createElement("button");
        d.type = "button";
        d.className = "banner-dot" + (i === 0 ? " active" : "");
        d.setAttribute("data-idx", i);
        d.onclick = (function(idx) {
            return function() { goToBanner(idx); };
        })(i);
        dots.appendChild(d);
    }

    track.style.transform = "translateX(0)";
    startBannerAuto();
}

function goToBanner(idx) {
    var track = document.getElementById("bannerTrack");
    if (!track) return;
    var slides = track.children.length;
    if (idx < 0) idx = slides - 1;
    if (idx >= slides) idx = 0;
    bannerIndex = idx;
    track.style.transform = "translateX(-" + (bannerIndex * 100) + "%)";

    var dots = document.querySelectorAll(".banner-dot");
    for (var i = 0; i < dots.length; i++) {
        dots[i].classList.toggle("active", i === bannerIndex);
    }
    restartBannerAuto();
}

function nextBanner() {
    goToBanner(bannerIndex + 1);
}

function startBannerAuto() {
    stopBannerAuto();
    bannerTimer = setInterval(nextBanner, 4000);
}

function stopBannerAuto() {
    if (bannerTimer) { clearInterval(bannerTimer); bannerTimer = null; }
}

function restartBannerAuto() {
    startBannerAuto();
}

// ===============================
// PROCEED TO CHECKOUT
// ===============================

function proceedToCheckout() {
    if (!cart || cart.length === 0) {
        var savedCart = localStorage.getItem("freshMartCart");
        if (savedCart) {
            try { cart = JSON.parse(savedCart); } catch (e) { cart = []; }
        }
    }

    if (!cart || cart.length === 0) {
        showToast("Your cart is empty. Please add a product first.", "error");
        return;
    }

    var subTotal = getCartSubtotal();
    if (subTotal < MIN_ORDER_AMOUNT) {
        showToast("Minimum order amount is ₹" + MIN_ORDER_AMOUNT + ". Please add more items.", "error");
        return;
    }

    localStorage.setItem("freshMartCart", JSON.stringify(cart));
    window.location.href = "checkout.html";
}

// ===============================
// CART SUBTOTAL
// ===============================

function getCartSubtotal() {
    var sum = 0;
    cart.forEach(function(item) {
        sum += item.price * item.quantity;
    });
    return sum;
}

// ===============================
// LOAD CHECKOUT
// ===============================

function loadCheckout() {
    var checkoutItems = document.getElementById("checkoutItems");
    if (!checkoutItems) return;

    var savedCart = localStorage.getItem("freshMartCart");
    if (savedCart) {
        try { cart = JSON.parse(savedCart); } catch (e) { cart = []; }
    }

    checkoutItems.innerHTML = "";
    var subtotal = 0;

    if (cart.length === 0) {
        checkoutItems.innerHTML = '<div class="cart-empty"><div class="cart-empty-icon">🛒</div><h3>Your cart is empty</h3><p>Please add products before checkout.</p></div>';
    } else {
        cart.forEach(function(item) {
            var itemTotal = item.price * item.quantity;
            subtotal += itemTotal;
            var itemLabel = item.name + (item.qtyLabel ? " (" + item.qtyLabel + ")" : "");
            checkoutItems.innerHTML += '<div class="checkout-product"><span>' + itemLabel + ' × ' + item.quantity + '</span><strong>₹' + itemTotal + '</strong></div>';
        });
    }

    var delivery = (subtotal >= 500) ? 0 : 20;

    var checkoutSubtotal = document.getElementById("checkoutSubtotal");
    if (checkoutSubtotal) checkoutSubtotal.innerText = "₹" + subtotal;

    var deliveryCharge = document.getElementById("deliveryCharge");
    if (deliveryCharge) {
        deliveryCharge.innerText = "₹" + delivery;
        if (delivery === 0 && subtotal > 0) {
            deliveryCharge.classList.add("free-delivery");
        } else {
            deliveryCharge.classList.remove("free-delivery");
        }
    }

    var checkoutTotal = document.getElementById("checkoutTotal");
    if (checkoutTotal) checkoutTotal.innerText = "₹" + (subtotal + delivery);

    var minOrderNote = document.getElementById("minOrderNote");
    if (minOrderNote) {
        if (subtotal < MIN_ORDER_AMOUNT) {
            minOrderNote.style.display = "block";
            minOrderNote.innerHTML = '⚠️ Minimum order amount is <strong>₹' + MIN_ORDER_AMOUNT + '</strong>. Add ₹' + (MIN_ORDER_AMOUNT - subtotal) + ' more to place your order.';
        } else {
            minOrderNote.style.display = "none";
        }
    }
}

// ===============================
// PAYMENT METHOD UI
// ===============================

function detectPincodeInfo() {
    var pinInput = document.getElementById("customerPincode");
    var hintBox = document.getElementById("pincodeHint");
    if (!pinInput || !hintBox) return;

    var pin = pinInput.value.trim();
    if (!/^\d{6}$/.test(pin)) {
        hintBox.style.display = "none";
        return;
    }

    hintBox.style.display = "block";
    hintBox.innerHTML = '<span class="pincode-hint-loading">🔍 Checking pincode...</span>';

    // Free India pincode API - no key required
    fetch("https://api.postalpincode.in/pincode/" + pin)
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (!data || !data[0] || data[0].Status !== "Success" || !data[0].PostOffice || !data[0].PostOffice.length) {
                hintBox.innerHTML = '<span class="pincode-hint-error">⚠️ Location not found for this pincode</span>';
                return;
            }
            var office = data[0].PostOffice[0];
            var district = office.District || "";
            var state = office.State || "";
            var name = office.Name || "";

            var cityField = document.getElementById("customerCity");
            if (cityField && district && !cityField.value.trim()) {
                cityField.value = district;
            }

            hintBox.innerHTML = '<span class="pincode-hint-ok">📍 ' + name + ', ' + district + ', ' + state + '</span>';
        })
        .catch(function() {
            hintBox.innerHTML = '<span class="pincode-hint-error">⚠️ Could not check pincode. Check your connection.</span>';
        });
}

function handlePaymentMethodChange(method) {
    var onlineMethods = document.getElementById("onlineMethods");
    var paymentFlag = document.getElementById("paymentFlag");
    if (!onlineMethods) return;

    if (method === "online") {
        onlineMethods.style.display = "block";
        if (paymentFlag) paymentFlag.style.display = "none";
    } else {
        onlineMethods.style.display = "none";
        if (paymentFlag) paymentFlag.style.display = "none";
    }
}

function getSelectedOnlineMethod() {
    var radios = document.querySelectorAll('input[name="onlineMethod"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) return radios[i].value;
    }
    return "UPI";
}

function getCurrentPaymentMethod() {
    var radios = document.querySelectorAll('input[name="payment"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) return radios[i].value;
    }
    return "cod";
}

// ===============================
// QR PAYMENT MODAL
// ===============================

var pendingOrder = null;
var pendingOrderConfirmed = false;

function getDeliverySlot() {
    var radios = document.querySelectorAll('input[name="deliverySlot"]');
    for (var i = 0; i < radios.length; i++) {
        if (radios[i].checked) return radios[i].value;
    }
    return "Morning (8-11 AM)";
}

function buildOrderObject() {
    var name = document.getElementById("customerName").value.trim();
    var phone = document.getElementById("customerPhone").value.trim();
    var address = document.getElementById("customerAddress").value.trim();
    var city = document.getElementById("customerCity").value.trim();
    var pincode = document.getElementById("customerPincode").value.trim();

    var orderNumber = "FM" + Date.now().toString().slice(-6);
    var subtotal = getCartSubtotal();
    var delivery = (subtotal >= 500) ? 0 : 20;

    return {
        orderNumber: orderNumber,
        customer: { name: name, phone: phone, address: address, city: city, pincode: pincode },
        items: JSON.parse(JSON.stringify(cart)),
        subtotal: subtotal,
        total: subtotal + delivery,
        paymentMethod: getCurrentPaymentMethod(),
        onlineMethod: getSelectedOnlineMethod(),
        deliverySlot: getDeliverySlot()
    };
}

// Show QR code payment modal for online orders
function showQrPaymentModal(order) {
    var amount = order.total;
    var upiId = "freshmart@upi"; // store UPI ID - change this

    // UPI deep link for QR (works with GPay/PhonePe/Paytm scanning)
    var upiLink = "upi://pay?pa=" + upiId +
        "&pn=FreshMart%20Store" +
        "&am=" + amount +
        "&cu=INR" +
        "&tn=" + order.orderNumber;
    var qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=250x250&bgcolor=ffffff&color=159447&data=" + encodeURIComponent(upiLink);

    var methodLabel = order.onlineMethod === "card" ? "Credit/Debit Card"
        : order.onlineMethod === "netbanking" ? "Net Banking"
        : order.onlineMethod === "wallet" ? "Wallet"
        : "UPI";

    var modal = document.createElement("div");
    modal.id = "qrModal";
    modal.className = "qr-modal";

    modal.innerHTML =
        '<div class="qr-modal-box">' +
            '<button class="qr-close" onclick="closeQrModal()">✕</button>' +
            '<h3>' + (order.onlineMethod === "card" ? "💳" : order.onlineMethod === "netbanking" ? "🏛️" : order.onlineMethod === "wallet" ? "👛" : "📱") + ' ' + methodLabel + ' Payment</h3>' +
            '<p class="qr-amount">Amount to pay: <strong>₹' + amount + '</strong></p>' +
            '<p class="qr-instruction">Scan this QR code with any UPI app and pay, then click "I have paid".</p>' +
            '<div class="qr-code-wrap">' +
                '<img src="' + qrUrl + '" alt="QR Code" onerror="this.style.display=\'none\';document.getElementById(\'qrFallback\').style.display=\'block\';" />' +
                '<div id="qrFallback" style="display:none;">' +
                    '<p>Scan or pay using UPI ID:</p>' +
                    '<strong>' + upiId + '</strong>' +
                '</div>' +
            '</div>' +
            '<p class="qr-amount">Order ID: <strong>' + order.orderNumber + '</strong></p>' +
            '<button class="paid-btn" onclick="confirmPaidPayment()">✅ I have paid</button>' +
            '<button class="pay-cancel-btn" onclick="closeQrModal()">Cancel Payment</button>' +
        '</div>';

    document.body.appendChild(modal);
}

function closeQrModal() {
    var modal = document.getElementById("qrModal");
    if (modal) modal.remove();
    pendingOrderConfirmed = false;
}

// ===============================
// PLACE ORDER
// ===============================

function placeOrder() {
    var name = document.getElementById("customerName").value.trim();
    var phone = document.getElementById("customerPhone").value.trim();
    var address = document.getElementById("customerAddress").value.trim();
    var city = document.getElementById("customerCity").value.trim();
    var pincode = document.getElementById("customerPincode").value.trim();

    if (!name || !phone || !address || !city || !pincode) {
        showToast("Please fill all delivery details.", "error");
        return;
    }

    if (!/^\d{10}$/.test(phone)) {
        showToast("Please enter a valid 10-digit mobile number.", "error");
        return;
    }

    if (!/^\d{6}$/.test(pincode)) {
        showToast("Please enter a valid 6-digit pincode.", "error");
        return;
    }

    if (!cart || cart.length === 0) {
        showToast("Your cart is empty.", "error");
        return;
    }

    var subTotal = getCartSubtotal();
    if (subTotal < MIN_ORDER_AMOUNT) {
        showToast("Minimum order amount is ₹" + MIN_ORDER_AMOUNT + ". Please add more items.", "error");
        return;
    }

    var order = buildOrderObject();
    var method = getCurrentPaymentMethod();

    // Online payment -> real Razorpay Checkout when configured, QR demo flow otherwise
    if (method === "online") {
        var placeBtn = document.getElementById("placeOrderBtn");
        if (placeBtn) placeBtn.disabled = true;

        apiPaymentConfig().then(function(config) {
            if (config && config.configured) {
                return placeOnlineOrder(order);
            }
            // Demo mode (no Razorpay keys) -> keep the existing QR fallback
            pendingOrder = order;
            pendingOrderConfirmed = false;
            showQrPaymentModal(order);
        }).catch(function() {
            // Backend unavailable -> use the QR demo flow
            pendingOrder = order;
            pendingOrderConfirmed = false;
            showQrPaymentModal(order);
        });
        return;
    }

    // COD -> place order directly
    order.payment = "Cash On Delivery";
    finalizeOrder(order);
}

// ===============================
// REAL RAZORPAY CHECKOUT
// ===============================

function onlineMethodLabel() {
    var m = getSelectedOnlineMethod();
    if (m === "card") return "Card";
    if (m === "netbanking") return "Net Banking";
    if (m === "wallet") return "Wallet";
    return "UPI";
}

// Create the order on the backend (server computes totals + Razorpay order), then open Checkout
function placeOnlineOrder(order) {
    pendingOrder = order;

    var payload = {
        customer: order.customer,
        items: order.items.map(function(item) {
            return {
                name: item.name,
                price: item.price,
                quantity: item.quantity || 1,
                weight: item.qtyLabel || null,
                productId: cartItemProductId(item)
            };
        }),
        payment: "Razorpay - " + onlineMethodLabel(),
        paymentMethod: "online",
        deliverySlot: order.deliverySlot || getDeliverySlot(),
        paid: false
    };

    return createOrderBackend(payload).then(function(res) {
        var savedOrder = res.data;
        var rzpOrder = res.razorpayOrder;
        var keyId = res.key_id;

        if (rzpOrder && rzpOrder.id && keyId && String(rzpOrder.id).indexOf("demo_") !== 0) {
            return openRazorpayCheckout(savedOrder, rzpOrder, keyId);
        }

        // Server is up but Razorpay isn't configured -> QR demo fallback
        reenablePlaceOrder();
        pendingOrderConfirmed = false;
        showQrPaymentModal(order);
    }).catch(function(err) {
        reenablePlaceOrder();
        showToast((err && err.message) ? err.message : "Could not initialise payment.", "error");
        // Offline fallback so the checkout still works via the QR demo flow
        pendingOrderConfirmed = false;
        showQrPaymentModal(order);
    });
}

function reenablePlaceOrder() {
    var btn = document.getElementById("placeOrderBtn");
    if (btn) btn.disabled = false;
}

var razorpayScriptLoading = false;

function loadRazorpayCheckoutScript() {
    return new Promise(function(resolve, reject) {
        if (window.Razorpay) return resolve();
        if (razorpayScriptLoading) {
            var waited = 0;
            var iv = setInterval(function() {
                if (window.Razorpay) { clearInterval(iv); return resolve(); }
                waited += 50;
                if (waited > 8000) { clearInterval(iv); return reject(new Error("Payment script timed out")); }
            }, 50);
            return;
        }
        razorpayScriptLoading = true;
        var s = document.createElement("script");
        s.src = "https://checkout.razorpay.com/v1/checkout.js";
        s.onload = function() { resolve(); };
        s.onerror = function() { razorpayScriptLoading = false; reject(new Error("Failed to load payment script")); };
        document.head.appendChild(s);
    });
}

function openRazorpayCheckout(savedOrder, rzpOrder, keyId) {
    return loadRazorpayCheckoutScript().then(function() {
        return new Promise(function(resolve) {
            var options = {
                key: keyId,
                order_id: rzpOrder.id,
                amount: rzpOrder.amount,
                currency: rzpOrder.currency || "INR",
                name: "FreshMart",
                description: "FreshMart Order #" + savedOrder.orderNumber,
                theme: { color: "#159447" },
                handler: function(response) {
                    apiVerifyPayment({
                        orderId: savedOrder._id,
                        razorpay_order_id: response.razorpay_order_id,
                        razorpay_payment_id: response.razorpay_payment_id,
                        razorpay_signature: response.razorpay_signature
                    }).then(function() {
                        var order = pendingOrder || savedOrder;
                        order.orderNumber = savedOrder.orderNumber;
                        order.payment = "Razorpay - " + onlineMethodLabel();
                        finishOrderUI(order, true);
                        resolve();
                    }).catch(function(err) {
                        showToast((err && err.message) ? err.message : "Payment verification failed.", "error");
                        reenablePlaceOrder();
                        resolve();
                    });
                },
                modal: {
                    ondismiss: function() {
                        showToast("Payment cancelled. Your cart is saved.", "warning");
                        reenablePlaceOrder();
                        resolve();
                    }
                }
            };

            try {
                var rzp = new Razorpay(options);
                rzp.open();
            } catch (e) {
                showToast("Could not open the payment window.", "error");
                reenablePlaceOrder();
                resolve();
            }
        });
    }).catch(function() {
        showToast("Could not load the payment gateway. Please try again.", "error");
        reenablePlaceOrder();
        pendingOrderConfirmed = false;
        showQrPaymentModal(pendingOrder);
    });
}

// Called when user clicks "I have paid"
function confirmPaidPayment() {
    if (!pendingOrder) return;

    var order = pendingOrder;
    order.payment = "Razorpay - " + (order.onlineMethod === "card" ? "Card"
        : order.onlineMethod === "netbanking" ? "Net Banking"
        : order.onlineMethod === "wallet" ? "Wallet"
        : "UPI");
    order.paid = true;

    closeQrModal();
    finalizeOrder(order, true);
}

// Save order (backend or localStorage) and show receipt
function finalizeOrder(order, isOnline) {
    // Attach names/price to items if no productId
    order.items = order.items.map(function(item) {
        return {
            name: item.name,
            price: item.price,
            quantity: item.quantity || 1,
            weight: item.qtyLabel || null,
            productId: item.productId || null
        };
    });

    // Backend order payload
    var payload = {
        customer: order.customer,
        items: order.items,
        payment: order.payment,
        paymentMethod: order.paymentMethod || "cod",
        subtotal: order.subtotal,
        delivery: order.delivery,
        total: order.total,
        paid: isOnline === true,
        deliverySlot: order.deliverySlot || getDeliverySlot()
    };

    // Try backend first; fallback to localStorage
    submitOrder(payload).then(function(savedOrder) {
        order.orderNumber = savedOrder.orderNumber || order.orderNumber;
        finishOrderUI(order, isOnline);
    }).catch(function() {
        var local = saveOrderLocallyExtra(payload);
        order.orderNumber = local.orderNumber;
        finishOrderUI(order, isOnline);
    });
}

function saveOrderLocallyExtra(payload) {
    var orderNumber = "FM" + Date.now().toString().slice(-6);
    var saved = {
        orderNumber: orderNumber,
        customer: payload.customer,
        items: payload.items,
        payment: payload.payment,
        subtotal: payload.subtotal,
        delivery: payload.delivery,
        total: payload.total,
        paid: true,
        status: "Placed",
        date: new Date().toLocaleString()
    };
    var orders = [];
    var so = localStorage.getItem("freshMartOrders");
    if (so) { try { orders = JSON.parse(so); } catch (e) {} }
    orders.unshift(saved);
    localStorage.setItem("freshMartOrders", JSON.stringify(orders));
    localStorage.setItem("lastOrder", JSON.stringify(saved));
    return saved;
}

function finishOrderUI(order, isOnline) {
    var orderNumberElement = document.getElementById("orderNumber");
    if (orderNumberElement) orderNumberElement.innerText = "Order ID: #" + order.orderNumber;

    var successMessage = document.getElementById("successMessage");
    if (successMessage) successMessage.style.display = "block";

    var receiptLine = document.getElementById("successReceipt");
    if (receiptLine) {
        receiptLine.innerText = isOnline
            ? "Payment: " + order.payment + " • Paid ✓"
            : "Payment: Cash on Delivery";
    }

    cart = [];
    localStorage.removeItem("freshMartCart");
    pendingOrder = null;

    // Clear the persistent DB cart for logged-in users
    if (typeof isLoggedIn === "function" && isLoggedIn()) {
        if (typeof apiClearCart === "function") apiClearCart().catch(function() {});
    }
}

// ===============================
// PAGE LOAD
// ===============================

function initializePage() {
    initDarkMode();
    loadWishlist();

    var page = document.body.dataset.page;

    if (page === "home") {
        initHomePage();
    } else if (page === "checkout") {
        loadCart();
        loadCheckout();
    } else if (page === "orders") {
        loadCart();
        loadOrders();
    } else if (page === "detail") {
        loadCart();
        loadProductDetail();
    } else {
        loadCart();
    }

    // For logged-in users, adopt the DB cart (merges with local-only items)
    loadCartFromServer();

    bindSignupForm();
    bindLoginForm();
}

document.addEventListener("DOMContentLoaded", initializePage);

// ===============================
// SIGNUP
// ===============================

function bindSignupForm() {
    var signupForm = document.getElementById("signupForm");
    if (!signupForm || signupForm.dataset.bound === "true") return;
    signupForm.dataset.bound = "true";

    signupForm.addEventListener("submit", function(event) {
        event.preventDefault();

        var name = document.getElementById("signupName").value.trim();
        var phone = document.getElementById("signupPhone").value.trim();
        var email = document.getElementById("signupEmail").value.trim();
        var password = document.getElementById("signupPassword").value;
        var confirmPassword = document.getElementById("signupConfirmPassword").value;

        if (password !== confirmPassword) {
            showToast("Passwords do not match.", "error");
            return;
        }

        if (!/^\d{10}$/.test(phone)) {
            showToast("Please enter a valid 10-digit mobile number.", "error");
            return;
        }

        var user = { name: name, phone: phone, email: email, password: password };

        // Try backend signup, fallback to localStorage
        apiSignup(user)
            .then(function() {
                // Backend created the account; store locally too for cross-checking
                writeStorageValue("freshMartUser", JSON.stringify(user));
                showToast("Account created successfully!", "success");
                setTimeout(function() {
                    window.location.href = "login.html";
                }, 1000);
            })
            .catch(function(err) {
                var existingUser = readStorageValue("freshMartUser");
                if (existingUser) {
                    try {
                        var existing = JSON.parse(existingUser);
                        if (existing.email === email) {
                            showToast("An account with this email already exists.", "error");
                            return;
                        }
                    } catch (error) {}
                }
                // If backend is offline, save locally (offline mode)
                writeStorageValue("freshMartUser", JSON.stringify(user));
                showToast("Account created successfully! (offline mode)", "success");
                setTimeout(function() {
                    window.location.href = "login.html";
                }, 1000);
            });
    });
}

// ===============================
// LOGIN
// ===============================

function bindLoginForm() {
    var loginForm = document.getElementById("loginForm");
    if (!loginForm || loginForm.dataset.bound === "true") return;
    loginForm.dataset.bound = "true";

    loginForm.addEventListener("submit", function(event) {
        event.preventDefault();

        var email = document.getElementById("loginEmail").value.trim();
        var password = document.getElementById("loginPassword").value;
        var otp = document.getElementById("otpCode") ? document.getElementById("otpCode").value.trim() : "";

        // If OTP entered, verify via OTP flow
        if (otp) {
            apiVerifyOTP(email, otp)
                .then(function(data) {
                    var user = data.data || {};
                    writeStorageValue("freshMartLoggedIn", "true");
                    writeStorageValue("freshMartUser", JSON.stringify({ name: user.name, email: user.email, phone: user.phone }));
                    if (user.isAdmin || user.role === "admin") {
                        showToast("Admin login successful!", "success");
                        redirectAfterLoginCheck("admin.html");
                    } else {
                        showToast("Login successful!", "success");
                        redirectAfterLoginCheck("index.html");
                    }
                })
                .catch(function(err) {
                    showToast(err.message || "Invalid OTP.", "error");
                });
            return;
        }

        // Otherwise password login
        apiLogin({ email: email, password: password })
            .then(function(data) {
                var user = data.data || {};
                writeStorageValue("freshMartLoggedIn", "true");
                writeStorageValue("freshMartUser", JSON.stringify({ name: user.name, email: user.email, phone: user.phone }));
                if (user.isAdmin || user.role === "admin") {
                    showToast("Admin login successful!", "success");
                    redirectAfterLoginCheck("admin.html");
                } else {
                    showToast("Login successful!", "success");
                    redirectAfterLoginCheck("index.html");
                }
            })
            .catch(function() {
                // Fallback to localStorage login (offline mode)
                var savedUser = readStorageValue("freshMartUser");
                if (!savedUser) {
                    showToast("No account found. Please create an account first.", "error");
                    return;
                }
                try {
                    var user = JSON.parse(savedUser);
                    if (email === user.email && password === user.password) {
                        writeStorageValue("freshMartLoggedIn", "true");
                        showToast("Login successful! (offline)", "success");
                        setTimeout(function() { window.location.href = "index.html"; }, 1000);
                    } else {
                        showToast("Invalid email or password.", "error");
                    }
                } catch (error) {
                    showToast("User data is invalid. Please create a new account.", "error");
                }
            });
    });
}

// ===============================
// OTP LOGIN
// ===============================

function handleSendOtp() {
    var emailEl = document.getElementById("loginEmail");
    var email = emailEl ? emailEl.value.trim() : "";
    var messageEl = document.getElementById("otpMessage");

    if (!email) {
        showToast("Please enter your email first.", "error");
        return;
    }

    apiSendOTP(email).then(function(data) {
        if (messageEl) messageEl.textContent = data.devOTP
            ? "✅ OTP sent! (Demo code: " + data.devOTP + ")"
            : "✅ OTP sent to your email. (Check server console for demo OTP)";
        if (!data.success) showToast(data.message || "Failed to send OTP", "error");
    }).catch(function() {
        showToast("Backend not available. Password login can be used offline.", "error");
    });
}

// ===============================
// GOOGLE LOGIN (demo)
// ===============================

function handleGoogleLogin() {
    // This opens a demo prompt. In production, connect to Google OAuth.
    var email = prompt("Enter Google email for demo sign-in:");
    if (!email) return;

    apiLogin({ email: email, password: "google-demo-" + email })
        .then(function() {
            writeStorageValue("freshMartLoggedIn", "true");
            writeStorageValue("freshMartUser", JSON.stringify({ name: email.split("@")[0], email: email }));
            showToast("Google login successful!", "success");
            redirectAfterLoginCheck("index.html");
        })
        .catch(function(err) {
            showToast(err.message || "Google login failed. Try email/password.", "error");
        });
}

// ===============================
// MY ORDERS
// ===============================

function loadOrders() {
    var ordersContainer = document.getElementById("ordersContainer");
    if (!ordersContainer) return;

    var savedOrders = localStorage.getItem("freshMartOrders");

    if (!savedOrders) {
        ordersContainer.innerHTML = '<div class="empty-orders"><div class="empty-orders-icon">📦</div><h2>No Orders Yet</h2><p>You haven\'t placed any orders yet.</p><button type="button" onclick="window.location.href=\'index.html\'">Start Shopping</button></div>';
        return;
    }

    var orders = [];
    try {
        orders = JSON.parse(savedOrders);
        if (!Array.isArray(orders)) orders = [];
    } catch (error) {
        ordersContainer.innerHTML = '<div class="empty-orders"><h2>Order data is invalid</h2></div>';
        return;
    }

    if (orders.length === 0) {
        ordersContainer.innerHTML = '<div class="empty-orders"><div class="empty-orders-icon">📦</div><h2>No Orders Yet</h2><p>You haven\'t placed any orders yet.</p></div>';
        return;
    }

    var ordersHTML = "";

    orders.forEach(function(order, orderIndex) {
        var subtotal = 0;
        var productsHTML = "";

        if (order.items && order.items.length > 0) {
            order.items.forEach(function(item) {
                var price = Number(item.price) || 0;
                var quantity = Number(item.quantity) || 0;
                var itemTotal = price * quantity;
                subtotal += itemTotal;
                var itemName = item.name + (item.weight ? " (" + item.weight + ")" : "");
                productsHTML += '<div class="order-product"><span>' + itemName + ' × ' + quantity + '</span><strong>₹' + itemTotal + '</strong></div>';
            });
        } else {
            productsHTML = '<p>No products found.</p>';
        }

        // Prefer stored values from orders if available
        var delivery, total;
        if (order.total !== undefined && order.subtotal !== undefined) {
            subtotal = Number(order.subtotal);
            delivery = order.delivery !== undefined ? Number(order.delivery) : (subtotal >= 500 ? 0 : 20);
            total = Number(order.total);
        } else {
            delivery = subtotal >= 500 ? 0 : 20;
            total = subtotal + delivery;
        }

        var customer = order.customer || {};

        var paymentLine = '<p><strong>Payment:</strong> ' + (order.payment || "Cash On Delivery") + '</p>';

        ordersHTML += '<div class="order-card"><div class="order-header"><div><div class="order-id">Order ' + (orderIndex + 1) + '</div><strong>#' + (order.orderNumber || "N/A") + '</strong><br><small>' + (order.date || "") + '</small></div><div class="order-status">Order Placed</div></div><h3>Products</h3><div style="margin-top:10px;">' + productsHTML + '</div><div class="summary-row"><span>Subtotal</span><strong>₹' + subtotal + '</strong></div>' + '<div class="summary-row"><span>Delivery</span><strong>₹' + delivery + '</strong></div><div class="order-total">Total: ₹' + total + '</div><div class="detail-section"><h3>Customer Details</h3><p><strong>Name:</strong> ' + (customer.name || "N/A") + '</p><p><strong>Phone:</strong> ' + (customer.phone || "N/A") + '</p><p><strong>Address:</strong> ' + (customer.address || "N/A") + '</p><p><strong>City:</strong> ' + (customer.city || "N/A") + '</p><p><strong>Pincode:</strong> ' + (customer.pincode || "N/A") + '</p></div>' + paymentLine + '<button type="button" class="place-order-btn" style="margin-top:20px;" onclick="window.location.href=\'index.html\'">Continue Shopping</button></div>';
    });

    ordersContainer.innerHTML = ordersHTML;
}
