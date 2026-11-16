// Chart geometry in a 0..100 box; views/charts/ draw it.
import { num, pct, dayMonth, weekday } from './format.js';

/** Count axis: round step ~max/4, top = first step above max. */
export function countAxis(max) {
  const rough = Math.max(1, max) / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough));
  const steps = Math.max(1, Math.ceil(max / step));
  return { top: step * steps, ticks: Array.from({ length: steps + 1 }, (_, i) => i * step) };
}

/** x label anchored to the side near an edge. */
const xLabel = (at, text, sub) => ({ at, cls: at < 6 ? 'start' : at > 94 ? 'end' : '', text, sub });

const yTicks = (ticks, top, fmt) => ticks.map((t) => ({ label: fmt(t), bottom: (t / top) * 100, y: 100 - (t / top) * 100, base: t === 0 }));

/** Rate lines (0..1), one point per day; null = gap. series: [{ label, cls, values }] */
export function rateLines({ days, series, titles, every = 7, label }) {
  const n = days.length;
  const x = (i) => ((i + 0.5) / n) * 100;
  const y = (v) => 100 - v * 100;
  const line = ({ cls, values }) => {
    const segments = [];
    let cur = [];
    values.forEach((v, i) => {
      if (v == null) { if (cur.length) segments.push(cur); cur = []; } else cur.push(`${x(i).toFixed(2)},${y(v).toFixed(2)}`);
    });
    if (cur.length) segments.push(cur);
    return {
      cls,
      segments: segments.map((sg) => sg.join(' ')),
      dots: values.flatMap((v, i) => (v == null ? [] : [{ x: x(i).toFixed(2), y: y(v).toFixed(2) }])),
    };
  };
  return {
    label,
    legend: series.map((sr) => ({ label: sr.label, cls: sr.cls, kind: 'line' })),
    ticks: yTicks([0, 0.25, 0.5, 0.75, 1], 1, (t) => pct(t)),
    lines: series.map(line),
    hits: days.map((d, i) => ({ x: (i / n) * 100, w: 100 / n, title: titles[i] })),
    xLabels: days.map((iso, i) => ({ i, iso })).filter(({ i }) => (n - 1 - i) % every === 0).map(({ i, iso }) => xLabel(x(i), dayMonth(iso))),
  };
}

/** Count bars, one per day, value above; flag = red cap + note. bars: [{ iso, value, title, flag }] */
export function countBars({ bars, label, legendLabel, flagLabel = 'Errori nel giorno' }) {
  const n = bars.length;
  const { top, ticks } = countAxis(Math.max(0, ...bars.map((b) => b.value)));
  const w = (100 / n) * 0.56;
  return {
    label,
    legend: [{ label: legendLabel, cls: 'c-bar', kind: 'box' }, ...(bars.some((b) => b.flag) ? [{ label: flagLabel, cls: 'c-bad', kind: 'box' }] : [])],
    ticks: yTicks(ticks, top, num),
    bars: bars.map((b, i) => {
      const h = (b.value / top) * 100;
      return { x: (i / n) * 100 + (100 / n - w) / 2, y: 100 - h, w, h, title: b.title };
    }),
    values: bars.map((b, i) => ({ left: ((i + 0.5) / n) * 100, bottom: (b.value / top) * 100, w, cap: Boolean(b.flag), text: num(b.value) })),
    xLabels: bars.map((b, i) => xLabel(((i + 0.5) / n) * 100, weekday(b.iso), b.flag)),
  };
}

/** Stacked columns. items: [{ x, sub?, parts, title }], series: one { label, cls } per part. */
export function columns({ items, series, label, every = 1, totals = false }) {
  const n = items.length;
  const sums = items.map((it) => it.parts.reduce((a, b) => a + b, 0));
  const { top, ticks } = countAxis(Math.max(0, ...sums));
  const slot = 100 / n;
  const w = slot * (n > 16 ? 0.72 : 0.58);
  return {
    label,
    legend: series.length > 1 ? series.map((sr) => ({ label: sr.label, cls: sr.cls, kind: 'box' })) : [],
    ticks: yTicks(ticks, top, num),
    bars: items.flatMap((it, i) => {
      let acc = 0;
      return it.parts.flatMap((v, j) => {
        const y = 100 - ((acc + v) / top) * 100;
        acc += v;
        return v ? [{ cls: series[j].cls, x: i * slot + (slot - w) / 2, y, w, h: (v / top) * 100 }] : [];
      });
    }),
    hits: items.map((it, i) => ({ x: i * slot, w: slot, title: it.title })),
    totals: totals ? items.flatMap((it, i) => (sums[i] ? [{ left: (i + 0.5) * slot, bottom: (sums[i] / top) * 100, text: num(sums[i]) }] : [])) : null,
    xLabels: items.map((it, i) => ({ i, it })).filter(({ i }) => (n - 1 - i) % every === 0)
      .map(({ i, it }) => xLabel((i + 0.5) * slot, it.x, it.sub)),
  };
}

/** Horizontal bars. rows: [{ label, value, note? }] */
export function hBars({ rows, cls = 'c-data', fmt = num, label }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return { cls, label, rows: rows.map((r) => ({ ...r, text: fmt(r.value), width: Math.max(0.5, (r.value / max) * 100).toFixed(1) })) };
}
