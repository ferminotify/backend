// Notifiche: totals and distributions of the notifications sent (table `sent` has no date, so no time charts).
import { html, card, stats, columns, empty, num } from './ui.js';
import { ACTIVE, buckets, fillBuckets } from './sql.js';

const RECV = buckets('notifications', [['= 0', '0'], ['<= 10', '1-10'], ['<= 50', '11-50'], ['<= 100', '51-100'], ['<= 200', '101-200'], ['', 'Oltre 200']]);
const DEST = buckets('n', [['= 1', '1'], ['<= 5', '2-5'], ['<= 20', '6-20'], ['<= 50', '21-50'], ['', 'Oltre 50']]);

export async function notifiche(db) {
  const q = (sql) => db.query(sql).then((r) => r.rows);
  const [[s], recv, dest] = await Promise.all([
    q(`SELECT count(*)::int AS inviate, count(DISTINCT sub_id)::int AS utenti, count(DISTINCT uid)::int AS eventi,
         (SELECT count(*) FROM push_sent)::int AS push FROM sent`),
    q(`SELECT ${RECV.label} AS b, count(*)::int AS n FROM subscribers WHERE ${ACTIVE} GROUP BY 1`),
    q(`SELECT ${DEST.label} AS b, count(*)::int AS n FROM (SELECT count(*) AS n FROM sent GROUP BY uid) x GROUP BY 1`),
  ]);
  const chart = (b, rows, label, x) => {
    const filled = fillBuckets(b, rows);
    return filled.some((r) => r.n) ? columns({
      label, totals: true, series: [{ label: x, cls: 'c-data' }],
      items: filled.map((r) => ({ x: r.label, parts: [r.n], title: `${r.label}: ${num(r.n)}` })),
    }) : empty('Nessun dato.');
  };
  return {
    title: 'Notifiche',
    body: html`${stats([
      { label: 'Notifiche inviate', value: num(s.inviate) },
      { label: 'Utenti raggiunti', value: num(s.utenti) },
      { label: 'Eventi notificati', value: num(s.eventi) },
      { label: 'Push inviate', value: num(s.push) },
    ])}
<div class="grid2">
  ${card({ title: 'Iscritti per notifiche ricevute', body: chart(RECV, recv, 'Iscritti attivi per numero di notifiche ricevute', 'Iscritti') })}
  ${card({ title: 'Eventi per numero di destinatari', body: chart(DEST, dest, 'Eventi notificati per numero di destinatari', 'Eventi') })}
</div>`,
  };
}
