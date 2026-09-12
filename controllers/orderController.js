// ===============================
// ORDER CONTROLLER
// ===============================

const Order = require("../models/Order");
const Product = require("../models/Product");
const Razorpay = require("razorpay");
const { getMultFromWeight, round2 } = require("../utils/pricing");

// CREATE ORDER
exports.createOrder = async (req, res) => {
    try {
        const { customer, items, payment, paymentMethod, subtotal, delivery, total, paid, deliverySlot, subscription, subscriptionPlan } = req.body;

        // Validate items
        if (!items || items.length === 0) {
            return res.status(400).json({ success: false, message: "Cart is empty" });
        }

        // Generate order number
        const orderNumber = "FM" + Date.now().toString().slice(-6);

        // Check stock, compute authoritative server-side totals from DB prices
        // whenever items carry a productId. Client-sent totals are ignored when
        // the DB price is available so the amount charged can never be tampered with.
        let serverSubtotal = 0;
        for (const item of items) {
            const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
            item.quantity = qty;

            if (item.productId) {
                const product = await Product.findById(item.productId);
                if (!product || !product.active) {
                    return res.status(400).json({
                        success: false,
                        message: item.name + " is no longer available"
                    });
                }
                if (product.stock < qty) {
                    return res.status(400).json({
                        success: false,
                        message: "Only " + product.stock + " units of " + product.name + " in stock"
                    });
                }
                const mult = getMultFromWeight(item.weight, product.unit);
                const itemSub = round2(product.price * mult * qty);
                item.price = itemSub;
                item.unit = product.unit;
                item.weight = item.weight || null;
                serverSubtotal += itemSub;
            } else {
                serverSubtotal += round2((Number(item.price) || 0) * qty);
            }
        }

        // Decrement stock
        for (const item of items) {
            if (item.productId) {
                await Product.findByIdAndUpdate(item.productId, {
                    $inc: { stock: -item.quantity }
                });
            }
        }

        const finalSubtotal = round2(serverSubtotal);
        const finalDelivery = finalSubtotal >= 500 ? 0 : 20;
        const finalTotal = round2(finalSubtotal + finalDelivery);

        const finalPaymentMethod = paymentMethod || "cod";
        const orderData = {
            orderNumber,
            customer,
            items: items.map(function (item) {
                return {
                    name: item.name,
                    price: item.price,
                    quantity: item.quantity,
                    weight: item.weight || null,
                    productId: item.productId || undefined
                };
            }),
            payment: payment || (finalPaymentMethod === "cod" ? "Cash On Delivery" : "Razorpay - Online"),
            paymentMethod: finalPaymentMethod,
            subtotal: finalSubtotal,
            delivery: finalDelivery,
            deliverySlot: deliverySlot || "Morning (8-11 AM)",
            subscription: subscription === true,
            subscriptionPlan: subscriptionPlan || null,
            total: finalTotal,
            user: req.user ? req.user._id : null
        };

        // For online payment, mark as unpaid until verified (unless confirm-paid passed)
        if (finalPaymentMethod !== "cod") {
            orderData.paid = paid === true ? true : false;
            if (orderData.paid) orderData.paymentAt = new Date();
        } else {
            orderData.paid = true;
            orderData.paymentAt = new Date();
        }

        const order = await Order.create(orderData);

        // If online payment AND not yet paid, create Razorpay order for checkout
        let razorpayOrder = null;
        if (finalPaymentMethod !== "cod" && orderData.paid !== true && process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
            try {
                const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
                const rzpOptions = {
                    amount: Math.round(order.total * 100),
                    currency: "INR",
                    receipt: orderNumber,
                    notes: { orderNumber: orderNumber }
                };
                razorpayOrder = await rzp.orders.create(rzpOptions);
                order.razorpay.orderId = razorpayOrder.id;
                order.razorpay.method = null;
                await order.save();
            } catch (e) {
                // If razorpay fails, keep order but flag for demo/pending
                order.paymentMethod = finalPaymentMethod;
            }
        }

        res.status(201).json({
            success: true,
            data: order,
            razorpayOrder: razorpayOrder,
            key_id: (razorpayOrder && razorpayOrder.id) ? (process.env.RAZORPAY_KEY_ID || null) : null
        });
    } catch (error) {
        res.status(400).json({ success: false, message: error.message });
    }
};

// GET ALL ORDERS (admin)
exports.getOrders = async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 });
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET MY ORDERS (customer)
exports.getMyOrders = async (req, res) => {
    try {
        const orders = await Order.find({ user: req.user._id }).sort({ createdAt: -1 });
        res.json({ success: true, count: orders.length, data: orders });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET SINGLE ORDER
exports.getOrder = async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// UPDATE ORDER STATUS (admin)
exports.updateOrderStatus = async (req, res) => {
    try {
        const { status } = req.body;
        const validStatuses = ["Placed", "Confirmed", "Preparing", "Out for Delivery", "Delivered", "Cancelled"];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, message: "Invalid status" });
        }

        const order = await Order.findById(req.params.id);
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }

        // If cancelling, restore stock
        if (status === "Cancelled" && order.status !== "Cancelled") {
            for (const item of order.items) {
                if (item.productId) {
                    await Product.findByIdAndUpdate(item.productId, {
                        $inc: { stock: item.quantity }
                    });
                }
            }

            // Auto-refund paid online orders
            if (order.paid && order.razorpay.paymentId && !order.razorpay.paymentId.startsWith("demo")) {
                try {
                    const rzp = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
                    const refund = await rzp.payments.refund(order.razorpay.paymentId, {
                        amount: Math.round(order.total * 100),
                        notes: { orderNumber: order.orderNumber, reason: "Order cancelled" }
                    });
                    order.refund.id = refund.id;
                    order.refund.amount = order.total;
                    order.refund.status = refund.status || "processed";
                    order.refund.initiatedAt = new Date();
                } catch (e) {}
            }
        }

        order.status = status;
        await order.save();
        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};

// GET ORDER BY NUMBER (public - for tracking)
exports.getOrderByNumber = async (req, res) => {
    try {
        const order = await Order.findOne({ orderNumber: req.params.number });
        if (!order) {
            return res.status(404).json({ success: false, message: "Order not found" });
        }
        res.json({ success: true, data: order });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
