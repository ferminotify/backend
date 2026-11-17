// Once, when turning the dead-mailbox deactivation back on (utils/emailBounces.js): the
// "mailbox deleted" rejections received while it was paused only went to email_bounces.
// Turns those subscribers off as recordBounce would have done, dated at their last such
// rejection: "In verifica", so the notifier checks the address once (email_check_due,
// docs/email-caselle-morte.md) before it counts as confirmed. Mailgun addresses are removed
// from Mailgun's bounce list, else Mailgun would drop that check.
// Only subscribers whose email is still on: safe to run again.
//
//   node scripts/email-inactive-backfill.js --dry-run   lists them, changes nothing
//   node scripts/email-inactive-backfill.js             turns them off
import pool from '../db.js';
import { forgetMailgunBounce } from '../utils/emailBounces.js';

const dryRun = process.argv.includes('--dry-run');
const LAST = `SELECT DISTINCT ON (b.sub_id) b.sub_id, b.at, b.provider, b.reason, s.email
  FROM email_bounces b JOIN subscribers s ON s.id = b.sub_id
  WHERE b.status = 'unknown_user' AND s.email_inactive_at IS NULL
  ORDER BY b.sub_id, b.at DESC`;

const { rows } = await pool.query(LAST);
for (const r of rows) console.log(`${r.sub_id}\t${r.email}\t${r.provider}\t${r.at.toISOString()}\t${String(r.reason || '').slice(0, 80)}`);
if (dryRun) {
  console.log(`${rows.length} da disattivare (prova, nessuna modifica)`);
  process.exit(0);
}
const { rowCount } = await pool.query(
  `UPDATE subscribers s SET email_inactive_at = b.at, email_inactive_reason = left(b.provider || ': ' || coalesce(b.reason, ''), 1000)
    FROM (${LAST}) b WHERE s.id = b.sub_id AND s.email_inactive_at IS NULL`
);
for (const r of rows) if (r.provider === 'mailgun') await forgetMailgunBounce(r.email);
console.log(`${rowCount} disattivate`);
await pool.end();
process.exit(0);
