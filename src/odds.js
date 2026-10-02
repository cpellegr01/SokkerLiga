/* Odds as typed in a betting app, in any of the three common formats.
 * Shared by the bet slip (live preview) and the server (validation), so
 * both read "+150" the same way. Everything is stored as decimal odds. */

/**
 * Parse typed odds.
 *   decimal     2.5, 2,50, 1.91
 *   American    +150, -110, 150 (a whole number ≥ 100 with no sign is read as American)
 *   fractional  6/4, 11/10, evens, evs
 *   percent     68%, 68¢, 68c — the price as a chance or as cents per $1
 *               paid out (prediction-market apps); 68% pays 1 / 0.68 = 1.47
 * @returns {{ decimal: number, format: 'decimal'|'american'|'fractional'|'percent', text: string } | null}
 */
export function parseOdds(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const t = text.toLowerCase().replace(/\s+/g, '');
  if (t === 'evens' || t === 'evs' || t === 'even') return { decimal: 2, format: 'fractional', text };
  /* A bare 10–99 is almost always a price in cents or a percentage (68 for
   * 68¢), not decimal odds of 68; refuse it rather than guess. oddsHint()
   * says what to type instead. */
  if (/^\d{2}$/.test(t)) return null;

  const percent = t.match(/^(\d+(?:[.,]\d+)?)(%|¢|c)$/);
  if (percent) {
    const v = Number(percent[1].replace(',', '.'));
    if (!(v > 0 && v < 100)) return null;
    return { decimal: round(100 / v), format: 'percent', text };
  }

  const frac = t.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
  if (frac) {
    const n = Number(frac[1]);
    const d = Number(frac[2]);
    if (!(n > 0 && d > 0)) return null;
    return { decimal: round(1 + n / d), format: 'fractional', text };
  }

  const american = t.match(/^([+-])(\d+(?:\.\d+)?)$/) ?? (/^\d{3,}$/.test(t) ? [t, '+', t] : null);
  if (american) {
    const v = Number(american[2]);
    if (!(v >= 100)) return null;
    const decimal = american[1] === '+' ? 1 + v / 100 : 1 + 100 / v;
    return { decimal: round(decimal), format: 'american', text };
  }

  const dec = Number(t.replace(',', '.'));
  if (Number.isFinite(dec) && dec > 1) return { decimal: round(dec), format: 'decimal', text };
  return null;
}

const round = (x) => Math.round(x * 10000) / 10000;

/** Why typed odds were refused, and what was probably meant. */
export function oddsHint(input) {
  const t = String(input ?? '').trim();
  if (/^\d{2}$/.test(t)) {
    return { message: `"${t}" on its own is unclear. If your app shows ${t}% or ${t}¢, type ${t}% — that pays ${(100 / Number(t)).toFixed(2)} per 1 staked. For decimal odds of ${t}, type ${t}.0.`,
      suggestion: `${t}%` };
  }
  return { message: 'Not valid odds yet. Use 2.50, +150, 6/4 or 68%.', suggestion: null };
}

export function toAmerican(decimal) {
  if (!(decimal > 1)) return '';
  return decimal >= 2 ? `+${Math.round((decimal - 1) * 100)}` : `${Math.round(-100 / (decimal - 1))}`;
}

export function toFractional(decimal) {
  if (!(decimal > 1)) return '';
  /* The nearest simple fraction, as betting apps quote them. */
  const target = decimal - 1;
  let best = [1, 1];
  let err = Infinity;
  for (let d = 1; d <= 20; d += 1) {
    const n = Math.round(target * d);
    if (n < 1) continue;
    const e = Math.abs(n / d - target);
    if (e < err - 1e-9) { err = e; best = [n, d]; }
  }
  return `${best[0]}/${best[1]}`;
}

/** "2.50 · +150 · 6/4 · 40%" — every format, for checking a typed price. */
export function describeOdds(decimal) {
  return `${decimal.toFixed(2)} · ${toAmerican(decimal)} · ${toFractional(decimal)} · ${Math.round(100 / decimal)}%`;
}

/** Implied probability of decimal odds (bookmaker margin included). */
export const impliedProbability = (decimal) => 1 / decimal;

/** Amounts are integer minor units (cents) everywhere except on screen. */
export function parseMoney(input) {
  const v = Number(String(input ?? '').replace(/[^0-9.,-]/g, '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
}

export function formatMoney(minor, currency = 'USD') {
  if (minor === null || minor === undefined) return '—';
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(minor / 100);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

/** A contract price as typed (prediction-market apps): 68, 68¢, 68% or
 *  0.68 → 0.68. Null outside 1¢–99¢. */
export function parseContractPrice(input) {
  const t = String(input ?? '').trim().toLowerCase().replace(/[¢c%$\s]/g, '').replace(',', '.');
  if (!t || !/^\d*\.?\d+$/.test(t)) return null;
  const v = Number(t);
  const p = v < 1 ? v : v / 100;
  return p > 0 && p < 1 ? Math.round(p * 10000) / 10000 : null;
}
