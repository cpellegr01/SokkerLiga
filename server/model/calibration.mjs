/* Calibration — does a 70% call come in 70% of the time?
 *
 * Isotonic regression (pool-adjacent-violators) per market: a monotone map
 * from the model's probability to how often calls like it came in. Monotone
 * means it can stretch or squeeze the model's probabilities but never
 * reorder them. Fitted on 1%-wide bins of graded selections, which keeps it
 * fast on hundreds of thousands of rows and smooths the noise at the ends.
 *
 * Pure functions; the fitting job (performance.mjs) decides which rows are
 * allowed in — only those graded before the fit.
 */

const clampP = (p) => Math.min(0.995, Math.max(0.005, p));

/**
 * Pool adjacent violators.
 * @param {Array<{p:number, w:number, wy:number}>} bins sorted by p; wy = weighted wins
 * @returns {Array<[number, number]>} knots [raw p, calibrated p], increasing in both
 */
export function fitIsotonic(bins) {
  const blocks = [];
  for (const b of bins) {
    if (!(b.w > 0)) continue;
    blocks.push({ w: b.w, wp: b.p * b.w, wy: b.wy });
    while (blocks.length > 1) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.wy / prev.w <= last.wy / last.w) break;
      blocks.splice(-2, 2, { w: prev.w + last.w, wp: prev.wp + last.wp, wy: prev.wy + last.wy });
    }
  }
  return blocks.map((b) => [round(b.wp / b.w), round(clampP(b.wy / b.w))]);
}

/** The calibrated probability: straight lines between knots, flat beyond the ends. */
export function applyKnots(knots, p) {
  if (!knots?.length) return p;
  if (p <= knots[0][0]) return knots[0][1];
  const last = knots[knots.length - 1];
  if (p >= last[0]) return last[1];
  let lo = 0;
  let hi = knots.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (knots[mid][0] <= p) lo = mid; else hi = mid;
  }
  const [x0, y0] = knots[lo];
  const [x1, y1] = knots[hi];
  return x1 === x0 ? y1 : y0 + ((p - x0) / (x1 - x0)) * (y1 - y0);
}

/**
 * Brier score, log loss and expected calibration error of binned rows,
 * with each bin's probability passed through `map` (identity for raw).
 * Brier and log loss are exact for a bin whose rows share one probability;
 * at 1% bins that is close enough to compare raw with calibrated.
 */
export function binMetrics(bins, map = (p) => p) {
  let n = 0; let brier = 0; let logLoss = 0;
  const deciles = new Map();
  for (const b of bins) {
    if (!(b.w > 0)) continue;
    const q = Math.min(0.9999, Math.max(0.0001, map(b.p)));
    n += b.w;
    /* Σ w (q − y)² with y ∈ {0, 1}: q²·W − 2q·WY + WY */
    brier += q * q * b.w - 2 * q * b.wy + b.wy;
    logLoss -= b.wy * Math.log(q) + (b.w - b.wy) * Math.log(1 - q);
    const d = Math.min(9, Math.floor(q * 10));
    const cur = deciles.get(d) ?? { w: 0, wq: 0, wy: 0 };
    cur.w += b.w; cur.wq += q * b.w; cur.wy += b.wy;
    deciles.set(d, cur);
  }
  if (!n) return { n: 0, brier: null, logLoss: null, ece: null };
  let ece = 0;
  for (const d of deciles.values()) ece += Math.abs(d.wq - d.wy);
  return { n, brier: brier / n, logLoss: logLoss / n, ece: ece / n };
}

/** How much to trust a market's confidence, from its calibration record:
 *  1 when calls of that kind have come in as often as said, down to 0.8
 *  when they have been off by eight points or more on average. */
export function reliabilityFactor(cal) {
  if (!cal || cal.holdout_n < 200) return 1;
  const ece = cal.applied ? cal.cal_ece : cal.raw_ece;
  if (ece === null || ece === undefined) return 1;
  if (ece <= 0.02) return 1;
  if (ece >= 0.08) return 0.8;
  return 1 - ((ece - 0.02) / 0.06) * 0.2;
}

/**
 * Calibrate a priced match. Each selection is mapped with its market's
 * fit; then each (market, line) group is rescaled so mutually exclusive
 * outcomes still add up to 1, and double chance is rebuilt from the
 * calibrated match result so the two always agree.
 * @param {Array} priced  [{ market, line, selection, p }]
 * @param {Map<string, {knots_json:string, applied:number}>} fits by market
 * @returns {Array} the same rows with `pCal` (null where no fit applied)
 */
export function calibratePriced(priced, fits) {
  const knots = new Map();
  for (const [market, fit] of fits ?? []) if (fit.applied) knots.set(market, JSON.parse(fit.knots_json));
  const out = priced.map((x) => ({ ...x, pCal: knots.has(x.market) && x.market !== 'double_chance'
    ? applyKnots(knots.get(x.market), x.p) : null }));

  const groups = new Map();
  out.forEach((x, i) => {
    if (x.pCal === null || x.market === 'anytime_scorer') return;
    const k = `${x.market}|${x.line}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  });
  for (const idx of groups.values()) {
    const total = idx.reduce((a, i) => a + out[i].pCal, 0);
    if (idx.length > 1 && total > 0) for (const i of idx) out[i].pCal /= total;
  }

  const mr = Object.fromEntries(out.filter((x) => x.market === 'match_result' && x.pCal !== null).map((x) => [x.selection, x.pCal]));
  if (mr.home !== undefined && mr.draw !== undefined && mr.away !== undefined) {
    const dc = { home_draw: mr.home + mr.draw, home_away: mr.home + mr.away, draw_away: mr.draw + mr.away };
    for (const x of out) if (x.market === 'double_chance') x.pCal = dc[x.selection];
  }
  return out.map((x) => ({ ...x, pCal: x.pCal === null ? null : round(clampP(x.pCal)) }));
}

const round = (x) => Math.round(x * 10000) / 10000;
