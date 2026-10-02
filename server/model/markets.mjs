/* Pricing markets.
 *
 * Goals markets come straight from the scoreline matrix: every one is a sum
 * over scorelines, so 1X2, totals, BTTS and handicaps all agree with each
 * other by construction.
 *
 * Markets that can push (draw no bet, whole-line totals and Asian handicaps)
 * are priced as the probability of winning *given no push*, which is how a
 * bettor compares them with a price: the fair odds of "Arsenal draw no bet"
 * are 1 / P(Arsenal win | not a draw). Quarter-line Asian handicaps split
 * the stake over the two neighbouring half/whole lines; their probability
 * is the expected fraction of the stake won, ignoring returned stakes.
 *
 * Corners and cards use a negative binomial count with the given mean and
 * dispersion (variance = mean + mean² / size).
 */

const sum = (matrix, test) => {
  let p = 0;
  matrix.forEach((row, i) => row.forEach((q, j) => { if (test(i, j)) p += q; }));
  return p;
};

export const TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
export const TEAM_TOTAL_LINES = [0.5, 1.5, 2.5];
export const AH_LINES = [-2.5, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export const EH_LINES = [-2, -1, 1];
export const CORNER_LINES = [7.5, 8.5, 9.5, 10.5, 11.5];
export const CARD_LINES = [2.5, 3.5, 4.5, 5.5];

/** Win / push / lose probabilities of home + line against away. */
function handicapOutcome(matrix, line) {
  const win = sum(matrix, (i, j) => i - j + line > 0);
  const push = sum(matrix, (i, j) => i - j + line === 0);
  return { win, push, lose: 1 - win - push };
}

/** Effective probability for one side of an Asian handicap line. Whole and
 *  half lines: P(win | no push). Quarter lines: average of the two halves. */
export function asianProbability(matrix, line) {
  const frac = Math.abs(line % 0.5);
  if (frac === 0.25) {
    const lower = line - 0.25;
    const upper = line + 0.25;
    return (asianProbability(matrix, lower) + asianProbability(matrix, upper)) / 2;
  }
  const { win, push } = handicapOutcome(matrix, line);
  return push < 1 ? win / (1 - push) : 0.5;
}

/** P(over | no push) for a line on a goal count distribution. */
function overUnder(dist, line) {
  let over = 0;
  let push = 0;
  dist.forEach((p, n) => { if (n > line) over += p; else if (n === line) push += p; });
  const pOver = push < 1 ? over / (1 - push) : 0.5;
  return { over: pOver, under: 1 - pOver };
}

function totalDistribution(matrix, pick = (i, j) => i + j) {
  const dist = [];
  matrix.forEach((row, i) => row.forEach((p, j) => {
    const n = pick(i, j);
    dist[n] = (dist[n] ?? 0) + p;
  }));
  for (let n = 0; n < dist.length; n += 1) dist[n] = dist[n] ?? 0;
  return dist;
}

/**
 * Every goals market priced from the matrix:
 * [{ market: 'over_under', line: 2.5, selection: 'over', p }]
 */
export function priceGoalsMarkets(matrix) {
  const out = [];
  const add = (market, line, selection, p) => out.push({ market, line, selection, p: clamp(p) });

  const home = sum(matrix, (i, j) => i > j);
  const draw = sum(matrix, (i, j) => i === j);
  const away = 1 - home - draw;
  add('match_result', null, 'home', home);
  add('match_result', null, 'draw', draw);
  add('match_result', null, 'away', away);

  add('double_chance', null, 'home_draw', home + draw);
  add('double_chance', null, 'home_away', home + away);
  add('double_chance', null, 'draw_away', draw + away);

  add('draw_no_bet', null, 'home', home / (home + away));
  add('draw_no_bet', null, 'away', away / (home + away));

  const totals = totalDistribution(matrix);
  for (const line of TOTAL_LINES) {
    const { over, under } = overUnder(totals, line);
    add('over_under', line, 'over', over);
    add('over_under', line, 'under', under);
  }

  const btts = sum(matrix, (i, j) => i > 0 && j > 0);
  add('btts', null, 'yes', btts);
  add('btts', null, 'no', 1 - btts);

  for (const line of AH_LINES) {
    const pHome = asianProbability(matrix, line);
    add('asian_handicap', line, 'home', pHome);
    add('asian_handicap', line, 'away', 1 - pHome);
  }

  for (const line of EH_LINES) {
    const { win, push, lose } = handicapOutcome(matrix, line);
    add('european_handicap', line, 'home', win);
    add('european_handicap', line, 'draw', push);
    add('european_handicap', line, 'away', lose);
  }

  const homeGoals = totalDistribution(matrix, (i) => i);
  const awayGoals = totalDistribution(matrix, (i, j) => j);
  for (const line of TEAM_TOTAL_LINES) {
    const h = overUnder(homeGoals, line);
    add('home_total', line, 'over', h.over);
    add('home_total', line, 'under', h.under);
    const a = overUnder(awayGoals, line);
    add('away_total', line, 'over', a.over);
    add('away_total', line, 'under', a.under);
  }
  return out;
}

/* ----------------------------------------------------- count markets */

/** Negative binomial pmf with mean μ and size r (r → ∞ is Poisson). */
export function negBinomial(k, mu, size) {
  if (!Number.isFinite(size) || size > 1e6) {
    let p = Math.exp(-mu);
    for (let i = 1; i <= k; i += 1) p *= mu / i;
    return p;
  }
  const p = size / (size + mu);
  let logC = 0;
  for (let i = 0; i < k; i += 1) logC += Math.log(size + i) - Math.log(i + 1);
  return Math.exp(logC + size * Math.log(p) + k * Math.log(1 - p));
}

export function priceCountMarket(market, lines, mu, size) {
  const dist = [];
  for (let k = 0; k <= 40; k += 1) dist.push(negBinomial(k, mu, size));
  const total = dist.reduce((a, x) => a + x, 0);
  for (let k = 0; k < dist.length; k += 1) dist[k] /= total;
  return lines.flatMap((line) => {
    const { over, under } = overUnder(dist, line);
    return [{ market, line, selection: 'over', p: clamp(over) }, { market, line, selection: 'under', p: clamp(under) }];
  });
}

/** Dispersion from observed totals: size = μ² / (variance − μ), or
 *  Poisson (Infinity) when the data are not over-dispersed. */
export function dispersion(values) {
  if (values.length < 10) return Infinity;
  const m = values.reduce((a, x) => a + x, 0) / values.length;
  const v = values.reduce((a, x) => a + (x - m) ** 2, 0) / (values.length - 1);
  return v > m ? (m * m) / (v - m) : Infinity;
}

const clamp = (p) => Math.min(Math.max(p, 0.0001), 0.9999);
