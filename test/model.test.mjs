import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fitRatings, lambdas, scoreMatrix, topScores } from '../server/model/goals.mjs';
import {
  priceGoalsMarkets, asianProbability, priceCountMarket, negBinomial, dispersion,
} from '../server/model/markets.mjs';

/* A deterministic random source, so the simulated league is the same on
 * every run. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function poissonDraw(l, r) {
  const L = Math.exp(-l);
  let k = 0;
  let p = 1;
  do { k += 1; p *= r(); } while (p > L);
  return k - 1;
}

/* Twelve teams with known strengths; two seasons of double round-robin. */
function simulate(seed = 7) {
  const r = rng(seed);
  const strength = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, attack: 0.4 - i * 0.07, defence: -0.3 + i * 0.05 }));
  const matches = [];
  let day = 0;
  for (let season = 0; season < 2; season += 1) {
    for (const h of strength) {
      for (const a of strength) {
        if (h.id === a.id) continue;
        day += 0.35;
        const lh = Math.exp(0.15 + 0.25 + h.attack + a.defence);
        const la = Math.exp(0.15 + a.attack + h.defence);
        matches.push({ homeId: h.id, awayId: a.id, competitionId: 1,
          homeGoals: poissonDraw(lh, r), awayGoals: poissonDraw(la, r),
          kickoffUtc: new Date(Date.UTC(2024, 7, 1) + day * 86400_000).toISOString() });
      }
    }
  }
  return { strength, matches, asOf: new Date(Date.UTC(2024, 7, 1) + (day + 1) * 86400_000).toISOString() };
}

describe('The goals model', () => {
  test('recovers the order of team strengths and a positive home advantage', () => {
    const { matches, asOf } = simulate();
    const m = fitRatings(matches, { asOf });
    assert.ok(m.ok);
    assert.equal(m.matches, 264);
    const attackOrder = [...m.attack.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    /* The strongest attack should be among the top three, the weakest among the bottom three. */
    assert.ok(attackOrder.slice(0, 3).includes(1), `top attacks ${attackOrder.slice(0, 3)}`);
    assert.ok(attackOrder.slice(-3).includes(12), `bottom attacks ${attackOrder.slice(-3)}`);
    assert.ok(m.home.get(1) > 0.1 && m.home.get(1) < 0.45, `home advantage ${m.home.get(1)}`);
    const { home, away } = lambdas(m, 1, 12, 1);
    assert.ok(home > away * 1.8, 'best at home against worst');
  });

  test('ignores matches on or after the moment it is fitted for', () => {
    const { matches, asOf } = simulate();
    const cut = matches[100].kickoffUtc;
    const m = fitRatings(matches, { asOf: cut });
    assert.equal(m.matches, 100);
    assert.ok(fitRatings(matches, { asOf }).matches > m.matches);
  });

  test('refuses to fit on almost nothing', () => {
    const m = fitRatings(simulate().matches.slice(0, 5), { asOf: '2030-01-01T00:00:00Z' });
    assert.equal(m.ok, false);
    assert.match(m.reason, /too few/);
  });

  test('a score matrix sums to one and the Dixon–Coles correction moves draws', () => {
    const plain = scoreMatrix(1.4, 1.1, 0);
    const total = plain.flat().reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    const corrected = scoreMatrix(1.4, 1.1, -0.1);
    assert.ok(corrected[0][0] > plain[0][0], 'negative rho adds 0–0s');
    assert.equal(topScores(plain, 1)[0].home, 1);
  });
});

describe('Market pricing', () => {
  const matrix = scoreMatrix(1.6, 1.0, -0.05);
  const priced = priceGoalsMarkets(matrix);
  const p = (market, selection, line = null) => priced.find((x) => x.market === market && x.selection === selection
    && (x.line ?? null) === line).p;

  test('the three results sum to one; double chance agrees with them', () => {
    const sum = p('match_result', 'home') + p('match_result', 'draw') + p('match_result', 'away');
    assert.ok(Math.abs(sum - 1) < 1e-6);
    assert.ok(Math.abs(p('double_chance', 'home_draw') - (p('match_result', 'home') + p('match_result', 'draw'))) < 1e-6);
  });

  test('over and under are complementary at every line, and over falls as the line rises', () => {
    for (const line of [0.5, 1.5, 2.5, 3.5]) {
      assert.ok(Math.abs(p('over_under', 'over', line) + p('over_under', 'under', line) - 1) < 1e-6);
    }
    assert.ok(p('over_under', 'over', 1.5) > p('over_under', 'over', 2.5));
  });

  test('Asian handicap 0 is draw no bet; −0.5 is a home win; quarters sit between', () => {
    assert.ok(Math.abs(asianProbability(matrix, 0) - p('draw_no_bet', 'home')) < 1e-9);
    assert.ok(Math.abs(asianProbability(matrix, -0.5) - p('match_result', 'home')) < 1e-6);
    const q = asianProbability(matrix, -0.25);
    assert.ok(q < asianProbability(matrix, 0) && q > asianProbability(matrix, -0.5));
    assert.ok(Math.abs(p('asian_handicap', 'home', -0.75) + p('asian_handicap', 'away', -0.75) - 1) < 1e-6);
  });

  test('European handicap −1: home must win by two', () => {
    const twoPlus = matrix.flat().reduce((a, x, k) => {
      const i = Math.floor(k / matrix.length); const j = k % matrix.length;
      return a + (i - j >= 2 ? x : 0);
    }, 0);
    assert.ok(Math.abs(p('european_handicap', 'home', -1) - twoPlus) < 1e-6);
  });

  test('both teams to score and team totals', () => {
    assert.ok(Math.abs(p('btts', 'yes') + p('btts', 'no') - 1) < 1e-6);
    assert.ok(p('home_total', 'over', 0.5) > p('away_total', 'over', 0.5), 'the stronger side scores more often');
  });

  test('count markets: negative binomial sums to one, is wider than Poisson, and prices lines', () => {
    const nb = Array.from({ length: 60 }, (_, k) => negBinomial(k, 10, 8)).reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(nb - 1) < 1e-6);
    assert.ok(negBinomial(18, 10, 8) > negBinomial(18, 10, Infinity), 'fatter tail');
    const corners = priceCountMarket('corners_ou', [9.5], 10.2, 12);
    assert.ok(corners[0].p > 0.5 && corners[0].p < 0.7);
    assert.equal(dispersion([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]), Infinity);
    assert.ok(Number.isFinite(dispersion([2, 18, 5, 15, 9, 11, 3, 17, 7, 13, 4, 16])));
  });
});
