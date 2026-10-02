/* Odds as typed in a betting app, in any of the three common formats.
 * Shared by the bet slip (live preview) and the server (validation), so
 * both read "+150" the same way. Everything is stored as decimal odds. */

/**
 * Parse typed odds.
 *   decimal     2.5, 2,50, 1.91
 *   American    +150, -110, 150 (a whole number ≥ 100 with no sign is read as American)
 *   fractional  6/4, 11/10, evens, evs
 * @returns {{ decimal: number, format: 'decimal'|'american'|'fractional', text: string } | null}
 */
export function parseOdds(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  const t = text.toLowerCase().replace(/\s+/g, '');
  if (t === 'evens' || t === 'evs' || t === 'even') return { decimal: 2, format: 'fractional', text };

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

/** "2.50 (+150, 6/4)" — the other two formats, for checking a typed price. */
export function describeOdds(decimal) {
  return `${decimal.toFixed(2)} · ${toAmerican(decimal)} · ${toFractional(decimal)}`;
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
