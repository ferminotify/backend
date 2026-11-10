// Delivery reports from the email providers (docs/email-caselle-morte.md):
//
// POST /hooks/email/azure?key=…   Azure Event Grid, Microsoft.Communication.EmailDeliveryReportReceived
//                                 (the school addresses and the service emails). AZURE_EVENTGRID_KEY.
// POST /hooks/email/mailgun       Mailgun webhooks "Permanent failure" and "Delivered" (the other
//                                 addresses), signed with MAILGUN_WEBHOOK_SIGNING_KEY.
//
// Mounted before cors (no Origin from the providers). 200 also for ignored events, otherwise
// the provider retries them. Without the env variable a hook answers 404.
import express from 'express';
import logger from '../utils/logger.js';
import { mailgunSignatureOk, recordBounce, recordDelivered, safeEqual } from '../utils/emailBounces.js';

const router = express.Router();
const log = logger.child('hooks');

router.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json'] }));

router.post('/email/azure', async (req, res) => {
  const key = process.env.AZURE_EVENTGRID_KEY;
  if (!key) return res.status(404).end();
  if (!safeEqual(req.query.key, key)) return res.status(401).end();
  const events = Array.isArray(req.body) ? req.body : [req.body];
  try {
    for (const ev of events) {
      const type = ev?.eventType || ev?.type; // Event Grid schema or CloudEvents
      const data = ev?.data || {};
      if (type === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
        log.info('Event Grid subscription validated');
        return res.json({ validationResponse: data.validationCode });
      }
      if (type !== 'Microsoft.Communication.EmailDeliveryReportReceived' || !data.recipient) continue;
      if (data.status === 'Delivered') await recordDelivered(data.recipient);
      else if (['Bounced', 'Failed', 'Suppressed'].includes(data.status)) {
        const reason = data.deliveryStatusDetails?.statusMessage || data.status;
        await recordBounce(data.recipient, 'azure', reason, { suppressed: data.status === 'Suppressed' });
      }
      // Expanded, Quarantined, FilteredSpam…: not about the mailbox
    }
    res.status(200).end();
  } catch (err) {
    log.error('Azure delivery report failed', { error: err.stack || err.message });
    res.status(500).end(); // Event Grid retries
  }
});

router.post('/email/mailgun', async (req, res) => {
  const key = process.env.MAILGUN_WEBHOOK_SIGNING_KEY;
  if (!key) return res.status(404).end();
  if (!mailgunSignatureOk(req.body?.signature, key)) return res.status(401).end();
  const ev = req.body['event-data'] || {};
  try {
    if (ev.event === 'delivered' && ev.recipient) await recordDelivered(ev.recipient);
    else if (ev.event === 'failed' && ev.severity === 'permanent' && ev.recipient) {
      const ds = ev['delivery-status'] || {};
      // "Too old": Mailgun stopped retrying temporary errors after hours; the last attempt's reply.
      const tooOld = /too old/i.test(ds.description || '') || ev.reason === 'old';
      const code = (tooOld && ds['last-code']) || ds.code || '';
      const text = (tooOld && ds['last-message']) || ds.message || ds.description || ev.reason || '';
      await recordBounce(ev.recipient, 'mailgun', `${tooOld ? 'Too old: ' : ''}${code} ${text}`.trim(), { tooOld });
    }
    res.status(200).end();
  } catch (err) {
    log.error('Mailgun webhook failed', { error: err.stack || err.message });
    res.status(500).end(); // Mailgun retries
  }
});

export default router;
