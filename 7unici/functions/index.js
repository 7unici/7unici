const crypto = require("crypto");
const Razorpay = require("razorpay");
const admin = require("firebase-admin");
const { onRequest } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

admin.initializeApp({
  databaseURL: "https://sameerswaraj-15d99-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.database();

const PLAN_CONFIG = {
  monthly: {
    name: "Monthly Premium",
    amount: 49900,
    period: "monthly",
    interval: 1,
    total_count: 1200
  },
  yearly: {
    name: "Yearly Premium",
    amount: 499900,
    period: "yearly",
    interval: 1,
    total_count: 100
  },
  lifetime: {
    name: "Lifetime Premium",
    amount: 99999900
  }
};

function getRazorpay() {
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (!key_id || !key_secret) {
    throw new Error("Razorpay credentials are not configured.");
  }

  return new Razorpay({ key_id, key_secret });
}

function sendJson(res, status, data) {
  res.status(status).json(data);
}

function withCors(handler) {
  return onRequest((req, res) => {
    res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
    return handler(req, res);
  });
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

async function verifyUser(req) {
  const token = getBearerToken(req);
  if (!token) throw new Error("Login required.");
  return admin.auth().verifyIdToken(token);
}

function cleanMobile(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  return "";
}

function nextEightUnix() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  next.setDate(8);

  if (next.getTime() <= now.getTime()) {
    next.setMonth(next.getMonth() + 1);
  }

  return Math.floor(next.getTime() / 1000);
}

function paymentRef(uid) {
  return db.ref(`users/${uid}/payment`);
}

function moneyFromPaise(value) {
  return Number(value || 0) / 100;
}

function getPremiumCommissionAmount(amountInPaise) {
  return Number((moneyFromPaise(amountInPaise) * 0.10).toFixed(2));
}

function eventKey(prefix, id) {
  return `${prefix}_${String(id || Date.now()).replace(/[.#$/[\]]/g, "_")}`;
}

async function savePremiumCommission(uid, data = {}) {
  const amountInPaise = Number(data.amount || 0);
  if (!uid || !amountInPaise) return;

  const userSnap = await db.ref(`users/${uid}/authData/referredByUid`).get();
  const referrerUid = userSnap.exists() ? String(userSnap.val() || "") : "";
  if (!referrerUid || referrerUid === uid) return;

  const paymentId = data.razorpayPaymentId || data.razorpayOrderId || data.razorpaySubscriptionId;
  const historyKey = eventKey("premium", paymentId || data.eventId || Date.now());
  const historyRef = db.ref(`users/${referrerUid}/commissionEarnings/users/${uid}/premiumHistory/${historyKey}`);
  const existing = await historyRef.get();
  if (existing.exists()) return;

  const userDataSnap = await db.ref(`users/${uid}/authData`).get();
  const userData = userDataSnap.exists() ? userDataSnap.val() || {} : {};
  const commissionAmount = getPremiumCommissionAmount(amountInPaise);
  const userCommissionRef = db.ref(`users/${referrerUid}/commissionEarnings/users/${uid}`);
  const userCommissionSnap = await userCommissionRef.get();
  const current = userCommissionSnap.exists() ? userCommissionSnap.val() || {} : {};
  const premiumEarning = Number(current.premiumEarning || 0) + moneyFromPaise(amountInPaise);
  const premiumCommission = Number(current.premiumCommission || 0) + commissionAmount;
  const productCommission = Number(
    current.productCommission ||
    (Number(current.productEarning || 0) * 0.10) ||
    0
  );
  const totalCommission = productCommission + premiumCommission;

  await userCommissionRef.update({
    name: userData.name || current.name || "User",
    email: userData.email || current.email || "",
    photo: userData.photo || current.photo || "",
    productEarning: Number(current.productEarning || 0),
    productCommission,
    premiumEarning,
    premiumCommission,
    commission: totalCommission,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });

  await historyRef.update({
    plan: data.plan || null,
    amount: moneyFromPaise(amountInPaise),
    commission: commissionAmount,
    razorpayPaymentId: data.razorpayPaymentId || null,
    razorpayOrderId: data.razorpayOrderId || null,
    razorpaySubscriptionId: data.razorpaySubscriptionId || null,
    createdAt: data.createdAt || admin.database.ServerValue.TIMESTAMP
  });

  const usersSnap = await db.ref(`users/${referrerUid}/commissionEarnings/users`).get();
  const users = usersSnap.exists() ? usersSnap.val() || {} : {};
  const totalEarn = Object.values(users).reduce((sum, item) => {
    return sum + Number(item?.commission || 0);
  }, 0);

  await db.ref(`users/${referrerUid}/commissionEarnings`).update({
    totalEarn,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
}

async function ensureCustomer(razorpay, uid, user, mobile) {
  const snap = await paymentRef(uid).child("razorpayCustomerId").get();
  if (snap.exists()) return snap.val();

  const customer = await razorpay.customers.create({
    name: user.name || user.email || uid,
    email: user.email || undefined,
    contact: mobile ? `+91${mobile}` : undefined,
    notes: { uid }
  });

  await paymentRef(uid).update({
    razorpayCustomerId: customer.id,
    mobile,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });

  return customer.id;
}

async function ensurePlan(razorpay, planType) {
  const config = PLAN_CONFIG[planType];
  if (!config || planType === "lifetime") throw new Error("Invalid subscription plan.");

  const planRef = db.ref(`billing/razorpayPlans/${planType}`);
  const existing = await planRef.get();
  if (existing.exists() && existing.val()?.planId) {
    return existing.val().planId;
  }

  const plan = await razorpay.plans.create({
    period: config.period,
    interval: config.interval,
    item: {
      name: config.name,
      amount: config.amount,
      currency: "INR"
    },
    notes: { planType }
  });

  await planRef.set({
    planId: plan.id,
    amount: config.amount,
    period: config.period,
    interval: config.interval,
    createdAt: admin.database.ServerValue.TIMESTAMP
  });

  return plan.id;
}

async function saveHistory(uid, key, data) {
  await paymentRef(uid).child(`history/${key}`).update({
    ...data,
    updatedAt: admin.database.ServerValue.TIMESTAMP
  });
}

exports.createCheckout = withCors(async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const decoded = await verifyUser(req);
    const { plan, mobile } = req.body || {};
    const planType = String(plan || "").toLowerCase();
    const cleanPhone = cleanMobile(mobile);
    const config = PLAN_CONFIG[planType];

    if (!config) return sendJson(res, 400, { error: "Invalid plan." });
    if (!cleanPhone) return sendJson(res, 400, { error: "Valid 10 digit mobile number required." });

    const razorpay = getRazorpay();
    const customerId = await ensureCustomer(razorpay, decoded.uid, decoded, cleanPhone);

    if (planType === "lifetime") {
      const order = await razorpay.orders.create({
        amount: config.amount,
        currency: "INR",
        receipt: `life_${decoded.uid.slice(0, 18)}_${Date.now()}`,
        notes: {
          uid: decoded.uid,
          plan: planType,
          mobile: cleanPhone
        }
      });

      await paymentRef(decoded.uid).update({
        plan: planType,
        status: "pending",
        mobile: cleanPhone,
        razorpayCustomerId: customerId,
        razorpayOrderId: order.id,
        updatedAt: admin.database.ServerValue.TIMESTAMP
      });
      await saveHistory(decoded.uid, eventKey("order", order.id), {
        plan: planType,
        status: "created",
        mobile: cleanPhone,
        amount: config.amount,
        razorpayOrderId: order.id,
        razorpayCustomerId: customerId
      });

      return sendJson(res, 200, {
        keyId: process.env.RAZORPAY_KEY_ID,
        type: "order",
        orderId: order.id,
        amount: config.amount,
        currency: "INR",
        plan: planType,
        mobile: cleanPhone,
        name: decoded.name || "",
        email: decoded.email || ""
      });
    }

    const planId = await ensurePlan(razorpay, planType);
    const subscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count: config.total_count,
      quantity: 1,
      start_at: nextEightUnix(),
      addons: [
        {
          item: {
            name: "Premium activation",
            amount: 100,
            currency: "INR"
          }
        }
      ],
      notes: {
        uid: decoded.uid,
        plan: planType,
        mobile: cleanPhone,
        firstCharge: "100",
        recurringCharge: String(config.amount),
        recurringStartsOnDay: "8"
      }
    });

    await paymentRef(decoded.uid).update({
      plan: planType,
      status: "pending",
      mobile: cleanPhone,
      razorpayCustomerId: customerId,
      razorpaySubscriptionId: subscription.id,
      nextBillingAt: subscription.start_at || null,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });
    await saveHistory(decoded.uid, eventKey("subscription", subscription.id), {
      plan: planType,
      status: "created",
      mobile: cleanPhone,
      amount: 100,
      recurringAmount: config.amount,
      razorpayCustomerId: customerId,
      razorpaySubscriptionId: subscription.id,
      nextBillingAt: subscription.start_at || null
    });

    return sendJson(res, 200, {
      keyId: process.env.RAZORPAY_KEY_ID,
      type: "subscription",
      subscriptionId: subscription.id,
      amount: 100,
      currency: "INR",
      plan: planType,
      mobile: cleanPhone,
      name: decoded.name || "",
      email: decoded.email || ""
    });
  } catch (error) {
    logger.error(error);
    return sendJson(res, 500, { error: error.message || "Checkout create failed." });
  }
});

exports.verifyCheckout = withCors(async (req, res) => {
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed." });

  try {
    const decoded = await verifyUser(req);
    const {
      plan,
      razorpay_payment_id,
      razorpay_order_id,
      razorpay_subscription_id,
      razorpay_signature
    } = req.body || {};
    const planType = String(plan || "").toLowerCase();
    const config = PLAN_CONFIG[planType];

    if (!config) return sendJson(res, 400, { error: "Invalid plan." });
    if (!razorpay_payment_id || !razorpay_signature) {
      return sendJson(res, 400, { error: "Payment verification data missing." });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET;
    const base = planType === "lifetime"
      ? `${razorpay_order_id}|${razorpay_payment_id}`
      : `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const expected = crypto.createHmac("sha256", secret).update(base).digest("hex");

    if (expected !== razorpay_signature) {
      return sendJson(res, 400, { error: "Payment signature mismatch." });
    }

    const now = admin.database.ServerValue.TIMESTAMP;
    const updates = {
      status: "active",
      plan: planType,
      razorpayPaymentId: razorpay_payment_id,
      updatedAt: now
    };

    if (planType === "lifetime") {
      updates.lifetime = true;
      updates.razorpayOrderId = razorpay_order_id || null;
      updates.currentPeriodEnd = null;
    } else {
      updates.lifetime = false;
      updates.razorpaySubscriptionId = razorpay_subscription_id || null;
      updates.nextBillingAt = nextEightUnix();
    }

    await paymentRef(decoded.uid).update(updates);
    await saveHistory(decoded.uid, eventKey("payment", razorpay_payment_id), {
      plan: planType,
      status: "paid",
      amount: planType === "lifetime" ? config.amount : 100,
      recurringAmount: planType === "lifetime" ? 0 : config.amount,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id || null,
      razorpaySubscriptionId: razorpay_subscription_id || null
    });
    await savePremiumCommission(decoded.uid, {
      plan: planType,
      amount: planType === "lifetime" ? config.amount : 100,
      razorpayPaymentId: razorpay_payment_id,
      razorpayOrderId: razorpay_order_id || null,
      razorpaySubscriptionId: razorpay_subscription_id || null
    });

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    logger.error(error);
    return sendJson(res, 500, { error: error.message || "Payment verify failed." });
  }
});

exports.razorpayWebhook = onRequest(async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = req.headers["x-razorpay-signature"];
      const expected = crypto.createHmac("sha256", webhookSecret)
        .update(req.rawBody)
        .digest("hex");

      if (signature !== expected) {
        return res.status(400).send("Invalid webhook signature");
      }
    }

    const event = req.body || {};
    const payload = event.payload || {};
    const payment = payload.payment?.entity || {};
    const subscription = payload.subscription?.entity || {};
    const order = payload.order?.entity || {};
    const uid = payment.notes?.uid || subscription.notes?.uid || order.notes?.uid;
    const plan = payment.notes?.plan || subscription.notes?.plan || order.notes?.plan || "";

    if (!uid) {
      logger.warn("Razorpay webhook skipped: uid missing", event.event);
      return res.status(200).send("uid missing");
    }

    const statusMap = {
      "payment.authorized": "authorized",
      "payment.captured": "active",
      "order.paid": "active",
      "invoice.paid": "active",
      "subscription.charged": "active",
      "subscription.activated": "active",
      "subscription.cancelled": "cancelled",
      "subscription.paused": "paused",
      "payment.failed": "failed"
    };
    const status = statusMap[event.event] || payment.status || subscription.status || "updated";
    const key = eventKey("event", event.id || payment.id || subscription.id || order.id);

    await paymentRef(uid).update({
      status,
      plan: plan || null,
      mobile: payment.notes?.mobile || subscription.notes?.mobile || order.notes?.mobile || null,
      razorpayCustomerId: payment.customer_id || subscription.customer_id || null,
      razorpayPaymentId: payment.id || null,
      razorpayOrderId: payment.order_id || order.id || null,
      razorpaySubscriptionId: payment.subscription_id || subscription.id || null,
      lifetime: plan === "lifetime" ? true : null,
      updatedAt: admin.database.ServerValue.TIMESTAMP
    });

    await saveHistory(uid, key, {
      event: event.event,
      plan: plan || null,
      status,
      mobile: payment.notes?.mobile || subscription.notes?.mobile || order.notes?.mobile || null,
      amount: payment.amount || order.amount || null,
      razorpayPaymentId: payment.id || null,
      razorpayOrderId: payment.order_id || order.id || null,
      razorpaySubscriptionId: payment.subscription_id || subscription.id || null,
      razorpayCustomerId: payment.customer_id || subscription.customer_id || null,
      createdAt: payment.created_at || subscription.created_at || order.created_at || null
    });

    if (["payment.captured", "order.paid", "invoice.paid", "subscription.charged"].includes(event.event)) {
      await savePremiumCommission(uid, {
        eventId: event.id || null,
        plan: plan || null,
        amount: payment.amount || order.amount || null,
        razorpayPaymentId: payment.id || null,
        razorpayOrderId: payment.order_id || order.id || null,
        razorpaySubscriptionId: payment.subscription_id || subscription.id || null,
        createdAt: payment.created_at || subscription.created_at || order.created_at || null
      });
    }

    return res.status(200).send("ok");
  } catch (error) {
    logger.error(error);
    return res.status(500).send("webhook failed");
  }
});
