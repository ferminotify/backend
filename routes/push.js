import express from "express";
import webpush from "web-push";
import dotenv from "dotenv";
import logger from '../utils/logger.js';
dotenv.config();
import pool from '../db.js';
import { authenticateToken } from "./auth.js";

const router = express.Router();
const log = logger.child('push');

// Environment VAPID keys (expected to be URL-safe Base64, but we trust input)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const NOTIFICATION_API_KEY = process.env.NOTIFICATION_API_KEY || "";

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  log.warn('Missing VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY.');
} else {
  webpush.setVapidDetails("mailto:mail@fn.lkev.in", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

// In-memory subscription store (replace with persistent DB later)
const subscriptions = new Map(); // key: endpoint -> subscription

// Helper: build notification payload
function buildPayload(title, body, url) {
  return JSON.stringify({
    title: title || "Fermi Notify",
    body: body || "Hai ricevuto una notifica.",
    url: url || "/",
  });
}

// Helper: remove subscription from DB and memory
async function removeSubscription(endpoint, reason = '') {
  try {
    await pool.query(`DELETE FROM push WHERE endpoint = $1`, [endpoint]);
  } catch (dbErr) {
    console.error('[push] DB error removing subscription:', endpoint, dbErr);
  }
  if (subscriptions.delete(endpoint)) {
    console.log('[push] Removed subscription from memory:', endpoint, reason);
  }
}

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
/*
CREATE TABLE push (
  id SERIAL PRIMARY KEY,
  
  -- Utente che possiede il dispositivo
  sub_id INTEGER NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,

  -- Identificatore stabile del dispositivo, salvato in localStorage
  device_id TEXT NOT NULL,

  -- Device info (UA parsed)
  device_info TEXT NOT NULL,

  -- Subscription Web Push (cambia quando il browser la rinnova)
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,

  -- Timestamp creazione
  created_at TIMESTAMPTZ DEFAULT now(),

  send_push_with_notifications BOOLEAN DEFAULT FALSE,

  -- Impedisce che lo stesso browser (device_id) venga registrato due volte
  UNIQUE (sub_id, device_id)
);

*/
// Request body expected: { endpoint: string, keys: { p256dh: string, auth: string } }
// We upsert on (endpoint) so re-subscribe updates keys/user association without duplicates.
router.post("/subscribe", authenticateToken, async (req, res) => {
  const { endpoint, keys, device_id, device_info } = req.body || {};
  const userId = req.user.id;
  const p256dh = keys?.p256dh;
  const auth = keys?.auth;
  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ ok: false, error: "Invalid subscription payload" });
  }

  // Maintain in-memory map for fast broadcast if desired (optional)
  const updated = subscriptions.has(endpoint);
  subscriptions.set(endpoint, { endpoint, keys: { p256dh, auth } });
  log.info(`${updated ? 'Updated' : 'Stored'} subscription in memory`, { endpoint });

  try {
        const upd = await pool.query(
          `INSERT INTO push (sub_id, endpoint, p256dh, auth, device_id, device_info)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (endpoint)
          DO UPDATE SET 
              sub_id = EXCLUDED.sub_id,
              p256dh = EXCLUDED.p256dh,
              auth = EXCLUDED.auth,
              device_id = EXCLUDED.device_id,
              device_info = EXCLUDED.device_info
          WHERE push.sub_id != EXCLUDED.sub_id
            OR push.p256dh != EXCLUDED.p256dh
            OR push.auth != EXCLUDED.auth
            OR push.device_id != EXCLUDED.device_id
            OR push.device_info != EXCLUDED.device_info`,
          [userId, endpoint, p256dh, auth, device_id, device_info]
        );

        log.info('Stored subscription in DB for user', { userId, endpoint });
      } catch (err) {
        log.error('DB upsert failed for user', { userId, error: err.stack || err });
        return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
      }

      res.status(201).json({ ok: true, updated });
    });

router.post("/notify", async (req, res) => {
  const { title, body, url, endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: "Missing endpoint in payload" });
  }

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ ok: false, error: "VAPID keys not configured" });

  const payload = buildPayload(title, body, url);

  let sub = subscriptions.get(endpoint);
  if (!sub) {
    // no sub in memory, try DB
    try {
      const result = await pool.query(`SELECT endpoint, p256dh, auth FROM push WHERE endpoint = $1`, [endpoint]);
      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: "Subscription not found" });
      }
      const row = result.rows[0];
      sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      // cache in memory for future
      subscriptions.set(endpoint, sub);
      log.info('Loaded subscription from DB into memory', { endpoint });
    } catch (err) {
      log.error('DB error fetching subscription for notify', { error: err.stack || err });
      return res.status(500).json({ ok: false, error: "No subscription found / DB error occurred." });
    }
  }

  try {
    await webpush.sendNotification(sub, payload);
    log.info('Sent push notification', { endpoint });
    return res.json({ ok: true });
  } catch (err) {
    const status = err?.statusCode;
    log.error('Send notification failed', { status, error: err.stack || err, endpoint });

    // If subscription is gone or keys mismatch, remove from DB and memory so future sends don't fail
    if (status === 404 || status === 410 || status === 403) {
      await removeSubscription(endpoint, status === 403 ? 'key mismatch' : 'stale');
      return res.status(410).json({ ok: false, error: "Subscription removed (stale or key mismatch)." });
    }

    return res.status(500).json({ ok: false, error: "Errore interno durante l'invio della notifica." });
  }
});

router.post("/notify/broadcast", async (req, res) => {

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${NOTIFICATION_API_KEY}`) return res.status(401).json({ ok: false, error: "Unauthorized" });

  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return res.status(503).json({ ok: false, error: "VAPID keys not configured" });

  const { title, body, url } = req.body || {};
  const payload = buildPayload(title, body, url);

  let sent = 0;
  let removed = 0; // deleted due to 404/410/403 (stale or key mismatch)

  try {
    const subs = await pool.query(`SELECT endpoint, p256dh, auth FROM push`);

    for (const row of subs.rows) {
      const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
      try {
        await webpush.sendNotification(sub, payload);
        sent += 1;
      } catch (err) {
        const status = err?.statusCode;
        // 404/410 = subscription gone. 403 = VAPID auth mismatch.
        if (status === 404 || status === 410 || status === 403) {
              // remove stale subscription (DB + memory)
              await removeSubscription(sub.endpoint, status === 403 ? 'key mismatch' : 'stale');
          removed += 1;
          continue; // continue loop – do NOT abort broadcast
        }

            log.error('Send failed (non-removable error)', { status, endpoint: sub.endpoint, error: err.stack || err });
        return res.status(500).json({ ok: false, error: "Errore interno durante l'invio delle notifiche." });
      }
    }
  } catch (err) {
        log.error('Error sending notifications', { error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno durante l'invio delle notifiche." });
  }

  // total = count currently in DB after removals, not in-memory map size
  let total = sent + removed; // fallback
  try {
    const countRes = await pool.query('SELECT count(*)::int AS c FROM push');
    total = countRes.rows[0]?.c ?? total;
  } catch (countErr) {
    log.warn('Could not fetch total count after notify', { message: countErr.message });
  }

  res.json({ ok: true, sent, removed, total });
});

router.post("/unsubscribe", authenticateToken, async (req, res) => {
  const { endpoint } = req.body || {};
  const userId = req.user.id;
  if (!endpoint) {
    return res.status(400).json({ ok: false, error: "Invalid unsubscribe payload" });
  }

  // Remove from in-memory map
  const existed = subscriptions.delete(endpoint);
  if (existed) {
    log.info('Removed subscription from memory', { endpoint });
  }

  try {
    const result = await pool.query(`DELETE FROM push WHERE endpoint = $1 AND sub_id = $2`, [endpoint, userId]);
    if (result.rowCount > 0) {
      log.info('Unsubscribed user from endpoint', { userId, endpoint });
      return res.json({ ok: true, unsubscribed: true });
    } else {
      return res.status(404).json({ ok: false, error: "Subscription not found for user." });
    }
  } catch (err) {
    log.error('DB error during unsubscribe for user', { userId, error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }
});

/*
PUSH NOTIFICATION TIME:
send_push_with_notifications = Boolean
*/
router.post("/send-push-with-notifications", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { send_push_with_notifications, device_id } = req.body;

  if (typeof send_push_with_notifications !== 'boolean') return res.status(400).json({ ok: false, error: "Invalid payload" });

  if (!device_id) return res.status(400).json({ ok: false, error: "Missing device_id" });

  try {
    const result = await pool.query(
      `UPDATE push
       SET send_push_with_notifications = $1
       WHERE sub_id = $2 AND device_id = $3`,
      [send_push_with_notifications, userId, device_id]
    );

    return res.json({ ok: true, updated: result.rowCount > 0 });
    } catch (err) {
    log.error('DB error updating send_push_with_notifications for user', { userId, error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }
});

/* GET USER PUSH DEVICES */
router.get("/devices", authenticateToken, async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await pool.query(
      `SELECT device_id, device_info, created_at, send_push_with_notifications
       FROM push
       WHERE sub_id = $1`,
      [userId]
    );

    return res.json({ ok: true, devices: result.rows });
    } catch (err) {
    log.error('DB error fetching devices for user', { userId, error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }
});

/* DELETE USER PUSH DEVICE */
// TODO forse non funziona senza unsubscribe lato client?
router.delete("/devices/:device_id", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const deviceId = req.params.device_id;

  try {
    const result = await pool.query(
      `DELETE FROM push
       WHERE sub_id = $1 AND device_id = $2`,
      [userId, deviceId]
    );

    return res.json({ ok: true, deleted: result.rowCount > 0 });
    } catch (err) {
    log.error('DB error deleting device for user', { userId, error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }
});

router.post("/update-device-info", authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { device_id, device_info } = req.body;

  if (!device_id || !device_info) {
    return res.status(400).json({ ok: false, error: "Invalid payload" });
  }

  try {
    const result = await pool.query(
      `UPDATE push
       SET device_info = $1
       WHERE sub_id = $2 AND device_id = $3`,
      [device_info, userId, device_id]
    );

    return res.json({ ok: true, updated: result.rowCount > 0 });
    } catch (err) {
    log.error('DB error updating device_info for user', { userId, error: err.stack || err });
    return res.status(500).json({ ok: false, error: "Errore interno. Riprova più tardi." });
  }
});

export default router;