import express from "express";
import webpush from "web-push";
import dotenv from "dotenv";
dotenv.config();
import pool from '../db.js';
import { authenticateToken } from "./auth.js";

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
// TODO requires authentication?
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
/*
CREATE TABLE push (
  id SERIAL PRIMARY KEY,
  sub_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
*/
// Request body expected: { endpoint: string, keys: { p256dh: string, auth: string } }
// We upsert on (endpoint) so re-subscribe updates keys/user association without duplicates.
router.post("/subscribe", authenticateToken, async (req, res) => {
  const { endpoint, keys } = req.body || {};
  const userId = req.user.id;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ ok: false, error: "Invalid subscription payload" });
  }

  // Maintain in-memory map for fast broadcast if desired (optional)
  const updated = subscriptions.has(endpoint);
  subscriptions.set(endpoint, { endpoint, keys: { p256dh, auth } });
  console.log(`[push] ${updated ? 'Updated' : 'Stored'} subscription in memory:`, endpoint);

  try {
    // Upsert normalized row
    await pool.query(
      `INSERT INTO push (sub_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint)
       DO UPDATE SET sub_id = EXCLUDED.sub_id,
                     p256dh = EXCLUDED.p256dh,
                     auth   = EXCLUDED.auth`,
      [userId, endpoint, p256dh, auth]
    );
    console.log(`[push] Stored subscription in DB for user ${userId}:`, endpoint);
  } catch (err) {
    console.error('[push] DB upsert failed for user', userId, err);
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }

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

  try {
    const subs = await pool.query(`SELECT endpoint, p256dh, auth FROM push`);
    for (const row of subs.rows) {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          removed += 1;
          console.warn(`[push] Removed stale subscription (${status}):`, sub.endpoint);
          try {
            await pool.query(`DELETE FROM push WHERE endpoint = $1`, [sub.endpoint]);
          } catch (dbErr) {
            console.error('[push] DB error removing stale subscription:', dbErr);
          }
        } else {
          console.error('[push] Send failed:', status || err.message || err);
        }
      }
    }
  } catch (err) {
    console.error('Error sending notifications:', err);
    return res.status(500).json({ ok: false, error: "Errore interno durante l'invio delle notifiche." });
  }

  /*
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

        try{
          await pool.query(
            `DELETE FROM push WHERE vapid_key->>'endpoint' = $1`,
            [endpoint]
          );
        }

      } else {
        console.error("[push] Send failed:", status || err.message || err);
      }
    }
  }*/

  res.json({ ok: true, sent, removed, total: subscriptions.size });
});

export default router;