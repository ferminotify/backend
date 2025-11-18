import express from "express";
import webpush from "web-push";
import dotenv from "dotenv";
import crypto from "node:crypto";
dotenv.config();

const router = express.Router();

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_FINGERPRINT = VAPID_PUBLIC_KEY
  ? crypto.createHash("sha256").update(VAPID_PUBLIC_KEY).digest("hex").slice(0, 16)
  : null;

// Validate VAPID key formats
function b64urlToBuffer(b64url) {
  if (!b64url) return null;
  const base64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = base64.length % 4 === 2 ? "==" : base64.length % 4 === 3 ? "=" : "";
  try {
    return Buffer.from(base64 + pad, "base64");
  } catch {
    return null;
  }
}

const _pubBuf = b64urlToBuffer(VAPID_PUBLIC_KEY);
const _privBuf = b64urlToBuffer(VAPID_PRIVATE_KEY);
const VAPID_PUBLIC_VALID = Boolean(_pubBuf && _pubBuf.length === 65 && _pubBuf[0] === 0x04);
const VAPID_PRIVATE_VALID = Boolean(_privBuf && _privBuf.length === 32);

if (!VAPID_PUBLIC_VALID) {
  console.warn("[push] VAPID public key format invalid. Expected uncompressed P-256 (65 bytes starting with 0x04)." );
}
if (!VAPID_PRIVATE_VALID) {
  console.warn("[push] VAPID private key format invalid. Expected 32 bytes raw key.");
}

// Configure VAPID
webpush.setVapidDetails("mailto:mail@fn.lkev.in", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.warn(
    "[push] Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in the backend environment. Clients may subscribe with a different key and sends will fail with 403."
  );
}

// Store subscriptions (replace with DB later)
// Map keyed by endpoint to dedupe
const subscriptions = new Map();

// GET /public-key → expose VAPID public key
router.get("/public-key", (req, res) => {
  console.log("[push] Serving VAPID public key", VAPID_FINGERPRINT ? `(fp:${VAPID_FINGERPRINT})` : "");
  res.json({ key: VAPID_PUBLIC_KEY, fingerprint: VAPID_FINGERPRINT });
});

// GET /health → quick diagnostics
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    hasVapidPublicKey: Boolean(VAPID_PUBLIC_KEY),
    hasVapidPrivateKey: Boolean(VAPID_PRIVATE_KEY),
    fingerprint: VAPID_FINGERPRINT,
    publicKeyValid: VAPID_PUBLIC_VALID,
    privateKeyValid: VAPID_PRIVATE_VALID,
    subscriptions: subscriptions.size,
  });
});

// POST /subscribe → save subscription
router.post("/subscribe", (req, res) => {
  const subscription = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ ok: false, error: "Invalid subscription payload" });
  }

  const existed = subscriptions.has(subscription.endpoint);
  subscriptions.set(subscription.endpoint, {
    ...subscription,
    _meta: { createdAt: Date.now() },
  });

  console.log(
    `[push] ${existed ? "Updated" : "Stored"} subscription:`,
    subscription.endpoint
  );
  res.status(201).json({ ok: true, deduped: existed });
});

// POST /notify → send notification to all subscribers
router.post("/notify", async (req, res) => {
  const { title, body, url } = req.body || {};
  const payload = JSON.stringify({
    title: title || "Test Notification",
    body: body || "This is a test push notification.",
    url: url || "/",
  });

  let sent = 0;
  let removed = 0;
  let mismatched = 0;
  const removals = [];

  for (const [endpoint, sub] of subscriptions.entries()) {
    try {
      await webpush.sendNotification(sub, payload);
      sent += 1;
    } catch (err) {
      const status = err?.statusCode;
      if (status === 404 || status === 410) {
        // Gone/Not Found: remove subscription
        removals.push(endpoint);
        removed += 1;
        console.warn(`[push] Removing stale subscription (${status}):`, endpoint);
      } else if (status === 403) {
        // VAPID mismatch: client subscribed with a different public key
        mismatched += 1;
        console.error(
          `[push] 403 VAPID mismatch for ${endpoint}. Server public key fp:${VAPID_FINGERPRINT}. Clients must resubscribe.`
        );
        // Optionally, remove it to force resubscription next time
        removals.push(endpoint);
      } else {
        console.error("[push] Push failed:", err);
      }
    }
  }

  // Apply removals
  removals.forEach((ep) => subscriptions.delete(ep));

  res.json({ ok: true, sent, removed, mismatched, total: subscriptions.size });
});

export default router;