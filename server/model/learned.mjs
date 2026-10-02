/* The learned challenger — match result.
 *
 * Multinomial logistic regression on the backtest's inputs: the goals
 * model's own view of the match plus things it does not see (recent form,
 * rest, congestion, league position, continental competition). Draw is the
 * reference class, and the inputs include ln(P(home)/P(draw)) and
 * ln(P(away)/P(draw)) from Dixon–Coles, so with weights [0, 1, 0, …] and
 * [0, 0, 1, …] the challenger *is* Dixon–Coles. Training starts there and
 * a penalty pulls it back there: it only moves away where the data say so.
 *
 * Pure functions. Training rows come from backtest_matches (performance.mjs),
 * each built as of before its match, so the held-out score is honest.
 */

export const LEARNED_KEY = 'stacked-1x2';

export const INPUTS = ['bias', 'dcHomeVsDraw', 'dcAwayVsDraw', 'formDiff', 'restDiff', 'congestionDiff', 'positionDiff', 'continental'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const perMatch = (f) => (f?.played ? f.points / f.played : null);

/** The challenger's inputs from a built match and its priced markets. */
export function learnedInputs(built, priced) {
  const mr = Object.fromEntries(priced.filter((x) => x.market === 'match_result').map((x) => [x.selection, x.p]));
  if (mr.home === undefined) return null;
  const f = built.features;
  const h = f.home;
  const a = f.away;
  const formH = perMatch(h.form5);
  const formA = perMatch(a.form5);
  const posKnown = h.table && a.table && h.table.played >= 5 && a.table.played >= 5;
  const values = [
    1,
    Math.log(mr.home / mr.draw),
    Math.log(mr.away / mr.draw),
    formH === null || formA === null ? 0 : (formH - formA) / 3,
    h.restDays === null || a.restDays === null ? 0 : clamp((h.restDays - a.restDays) / 7, -2, 2),
    (h.matchesLast14Days - a.matchesLast14Days) / 3,
    posKnown ? (a.table.position - h.table.position) / 20 : 0,
    f.match.competitionKind === 'continental' || f.match.competitionKind === 'international' ? 1 : 0,
  ];
  return { values: values.map((v) => Math.round(v * 10000) / 10000), dc: { home: mr.home, draw: mr.draw, away: mr.away } };
}

const START = () => ({
  home: INPUTS.map((k) => (k === 'dcHomeVsDraw' ? 1 : 0)),
  away: INPUTS.map((k) => (k === 'dcAwayVsDraw' ? 1 : 0)),
});

export function predictLearned(weights, x) {
  const sh = weights.home.reduce((a, w, i) => a + w * x[i], 0);
  const sa = weights.away.reduce((a, w, i) => a + w * x[i], 0);
  const m = Math.max(sh, sa, 0);
  const eh = Math.exp(sh - m);
  const ea = Math.exp(sa - m);
  const ed = Math.exp(-m);
  const t = eh + ea + ed;
  return { home: eh / t, draw: ed / t, away: ea / t };
}

/**
 * Full-batch gradient descent with a penalty on moving away from
 * Dixon–Coles. rows: [{ x: number[], y: 'home'|'draw'|'away' }]
 */
export function trainLearned(rows, { penalty = 0.02, iterations = 400, rate = 0.3 } = {}) {
  const start = START();
  const w = { home: [...start.home], away: [...start.away] };
  const n = rows.length;
  const k = INPUTS.length;
  for (let it = 0; it < iterations; it += 1) {
    const gh = new Array(k).fill(0);
    const ga = new Array(k).fill(0);
    for (const r of rows) {
      const p = predictLearned(w, r.x);
      const eh = p.home - (r.y === 'home' ? 1 : 0);
      const ea = p.away - (r.y === 'away' ? 1 : 0);
      for (let i = 0; i < k; i += 1) { gh[i] += eh * r.x[i]; ga[i] += ea * r.x[i]; }
    }
    for (let i = 0; i < k; i += 1) {
      w.home[i] -= rate * (gh[i] / n + penalty * (w.home[i] - start.home[i]));
      w.away[i] -= rate * (ga[i] / n + penalty * (w.away[i] - start.away[i]));
    }
  }
  return { home: w.home.map(r4), away: w.away.map(r4) };
}

/** Average log loss and Brier (sum over the three outcomes) of 1X2 views. */
export function scoreResults(rows, predict) {
  let ll = 0; let brier = 0;
  for (const r of rows) {
    const p = predict(r);
    ll -= Math.log(Math.max(1e-6, p[r.y]));
    for (const s of ['home', 'draw', 'away']) brier += (p[s] - (r.y === s ? 1 : 0)) ** 2;
  }
  return { logLoss: ll / rows.length, brier: brier / rows.length };
}

const r4 = (x) => Math.round(x * 10000) / 10000;
