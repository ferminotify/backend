import express from "express";
import webpush from "web-push";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();

// Environment VAPID keys (expected to be URL-safe Base64, but we trust input)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const NOTIFICATION_API_KEY = process.env.NOTIFICATION_API_KEY || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn("[push] Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.");
} else {
  webpush.setVapidDetails("mailto:mail@fn.lkev.in", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// In-memory subscription store (replace with persistent DB later)
const subscriptions = new Map(); // key: endpoint -> subscription

// GET /public-key → expose VAPID public key for client subscription
router.get("/public-key", (_req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

// GET /health → minimal diagnostics
router.get("/health", (_req, res) => {
  res.json({
    ok: true,
    subscriptions: subscriptions.size,
    hasKeys: Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY),
  });
});

// POST /subscribe → register or update a subscription
router.post("/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: "Invalid subscription payload" });
  }
  const updated = subscriptions.has(subscription.endpoint);
  subscriptions.set(subscription.endpoint, subscription);
  console.log(`[push] ${updated ? "Updated" : "Stored"} subscription:`, subscription.endpoint);
  res.status(201).json({ ok: true, updated });
});

// POST /notify → broadcast a notification to all stored subscriptions
router.post("/notify", async (req, res) => {

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${NOTIFICATION_API_KEY}`) return res.status(401).json({ ok: false, error: "Unauthorized" });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ ok: false, error: "VAPID keys not configured" });

  const { title, body, url } = req.body || {};
  const payload = JSON.stringify({
    title: title || "Fermi Notify",
    body: body || "Hai ricevuto una notifica.",
    url: url || "/",
  });

  let sent = 0;
  let removed = 0;
  for (const [endpoint, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent += 1;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        subscriptions.delete(endpoint);
        removed += 1;
        console.warn(`[push] Removed stale subscription (${status}):`, endpoint);
      } else {
        console.error("[push] Send failed:", status || err.message || err);
      }
    }
  }

  res.json({ ok: true, sent, removed, total: subscriptions.size });
});

export default router;