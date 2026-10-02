/* The goals model — Dixon–Coles.
 *
 * Each team has an attack and a defence rating. In a match, the home side's
 * expected goals are
 *
 *     λ_home = exp(base + home_c + attack_home + defence_away)
 *     λ_away = exp(base + attack_away + defence_home)
 *
 * (a higher "defence" number means a leakier defence). Goals are Poisson,
 * with Dixon and Coles' correction ρ for the four low scores (0–0, 1–0, 0–1,
 * 1–1), which plain Poisson gets measurably wrong.
 *
 * Fitting: weighted maximum likelihood by alternating closed-form updates
 * (each rating has an exact update when the others are held still). Older
 * matches weigh less — weight halves every `halfLifeDays`. Thin samples are
 * shrunk toward average with `shrinkage` pseudo-matches, so a newly promoted
 * team with three games is not rated on three games alone.
 *
 * Pure: takes match rows, returns ratings. The caller decides which matches
 * are allowed in — that is where look-ahead is prevented (features.mjs).
 */

export const MODEL_KEY = 'dixon-coles';
export const MODEL_VERSION = '1';

const DAY = 86400_000;

/**
 * @param {Array<{homeId:number, awayId:number, homeGoals:number, awayGoals:number,
 *                kickoffUtc:string, competitionId:number}>} matches
 * @param {{asOf:string, halfLifeDays?:number, shrinkage?:number, iterations?:number}} opts
 */
export function fitRatings(matches, { asOf, halfLifeDays = 365, shrinkage = 3, iterations = 60 } = {}) {
  const t0 = Date.parse(asOf);
  const decay = Math.LN2 / halfLifeDays;
  const rows = matches
    .filter((m) => Date.parse(m.kickoffUtc) < t0 && Number.isFinite(m.homeGoals) && Number.isFinite(m.awayGoals))
    .map((m) => ({ ...m, w: Math.exp(-decay * ((t0 - Date.parse(m.kickoffUtc)) / DAY)) }));
  if (rows.length < 20) {
    return { ok: false, reason: `Only ${rows.length} finished matches before this one — too few to fit.`, matches: rows.length };
  }

  const teams = new Set();
  const comps = new Set();
  for (const r of rows) { teams.add(r.homeId); teams.add(r.awayId); comps.add(r.competitionId); }

  const attack = new Map([...teams].map((t) => [t, 0]));
  const defence = new Map([...teams].map((t) => [t, 0]));
  const home = new Map([...comps].map((c) => [c, 0.25]));
  const sumW = rows.reduce((a, r) => a + r.w, 0);
  const goalsW = rows.reduce((a, r) => a + r.w * (r.homeGoals + r.awayGoals), 0);
  let base = Math.log(goalsW / (2 * sumW));

  /* Per-team weighted totals reused by every update. */
  const byTeam = new Map([...teams].map((t) => [t, []]));
  for (const r of rows) { byTeam.get(r.homeId).push(r); byTeam.get(r.awayId).push(r); }
  const byComp = new Map([...comps].map((c) => [c, []]));
  for (const r of rows) byComp.get(r.competitionId).push(r);

  for (let it = 0; it < iterations; it += 1) {
    /* attack_i: goals scored / goals expected with attack_i = 0. The
     * shrinkage pseudo-matches pull toward 0 with weight `shrinkage`. */
    for (const t of teams) {
      let scored = 0;
      let expected = 0;
      for (const r of byTeam.get(t)) {
        if (r.homeId === t) {
          scored += r.w * r.homeGoals;
          expected += r.w * Math.exp(base + home.get(r.competitionId) + defence.get(r.awayId));
        } else {
          scored += r.w * r.awayGoals;
          expected += r.w * Math.exp(base + defence.get(r.homeId));
        }
      }
      const prior = shrinkage * Math.exp(base);
      attack.set(t, Math.log((scored + prior) / (expected + prior)));
    }
    for (const t of teams) {
      let conceded = 0;
      let expected = 0;
      for (const r of byTeam.get(t)) {
        if (r.homeId === t) {
          conceded += r.w * r.awayGoals;
          expected += r.w * Math.exp(base + attack.get(r.awayId));
        } else {
          conceded += r.w * r.homeGoals;
          expected += r.w * Math.exp(base + home.get(r.competitionId) + attack.get(r.homeId));
        }
      }
      const prior = shrinkage * Math.exp(base);
      defence.set(t, Math.log((conceded + prior) / (expected + prior)));
    }
    /* Ratings are relative: keep each set averaging zero, fold the shift
     * into the base rate. */
    const meanA = mean([...attack.values()]);
    const meanD = mean([...defence.values()]);
    for (const t of teams) { attack.set(t, attack.get(t) - meanA); defence.set(t, defence.get(t) - meanD); }
    base += meanA + meanD;

    for (const c of comps) {
      let hg = 0;
      let he = 0;
      for (const r of byComp.get(c)) {
        hg += r.w * r.homeGoals;
        he += r.w * Math.exp(base + attack.get(r.homeId) + defence.get(r.awayId));
      }
      home.set(c, Math.log((hg + 1) / (he + 1)));
    }
  }

  const rho = fitRho(rows, (r) => lambdas({ base, home, attack, defence }, r.homeId, r.awayId, r.competitionId));
  const exposure = new Map([...teams].map((t) => [t, byTeam.get(t).reduce((a, r) => a + r.w, 0)]));
  return {
    ok: true, base, rho, attack, defence, home, exposure,
    matches: rows.length, teams: teams.size, asOf, halfLifeDays, shrinkage,
  };
}

const mean = (xs) => xs.reduce((a, x) => a + x, 0) / (xs.length || 1);

/** Expected goals for a fixture; home advantage of the competition, or the
 *  average across competitions when the competition has no history. */
export function lambdas(model, homeId, awayId, competitionId) {
  const h = model.home.has(competitionId) ? model.home.get(competitionId) : mean([...model.home.values()]);
  const a = (id) => model.attack.get(id) ?? 0;
  const d = (id) => model.defence.get(id) ?? 0;
  return {
    home: Math.exp(model.base + h + a(homeId) + d(awayId)),
    away: Math.exp(model.base + a(awayId) + d(homeId)),
  };
}

/* Dixon–Coles low-score adjustment τ. */
function tau(x, y, lh, la, rho) {
  if (x === 0 && y === 0) return 1 - lh * la * rho;
  if (x === 0 && y === 1) return 1 + lh * rho;
  if (x === 1 && y === 0) return 1 + la * rho;
  if (x === 1 && y === 1) return 1 - rho;
  return 1;
}

/* ρ by a fine grid over its usual range: the likelihood in ρ is smooth and
 * one-dimensional, so a grid is exact enough and cannot diverge. */
function fitRho(rows, lam) {
  let best = 0;
  let bestLl = -Infinity;
  for (let rho = -0.2; rho <= 0.1 + 1e-9; rho += 0.005) {
    let ll = 0;
    for (const r of rows) {
      if (r.homeGoals > 1 || r.awayGoals > 1) continue;
      const { home: lh, away: la } = lam(r);
      const t = tau(r.homeGoals, r.awayGoals, lh, la, rho);
      if (t <= 0) { ll = -Infinity; break; }
      ll += r.w * Math.log(t);
    }
    if (ll > bestLl) { bestLl = ll; best = rho; }
  }
  return Number(best.toFixed(3));
}

const poisson = (k, l) => {
  let p = Math.exp(-l);
  for (let i = 1; i <= k; i += 1) p *= l / i;
  return p;
};

/** P(home = i, away = j) for i, j in 0..maxGoals, normalised to sum to 1. */
export function scoreMatrix(lh, la, rho = 0, maxGoals = 10) {
  const m = [];
  let total = 0;
  for (let i = 0; i <= maxGoals; i += 1) {
    m.push([]);
    for (let j = 0; j <= maxGoals; j += 1) {
      const p = poisson(i, lh) * poisson(j, la) * tau(i, j, lh, la, rho);
      m[i].push(Math.max(p, 0));
      total += Math.max(p, 0);
    }
  }
  for (const row of m) for (let j = 0; j < row.length; j += 1) row[j] /= total;
  return m;
}

/** The most likely scorelines, for showing and for Claude. */
export function topScores(matrix, n = 6) {
  const all = [];
  matrix.forEach((row, i) => row.forEach((p, j) => all.push({ home: i, away: j, p })));
  return all.sort((a, b) => b.p - a.p).slice(0, n).map((s) => ({ ...s, p: round(s.p) }));
}

export const round = (x, d = 4) => Math.round(x * 10 ** d) / 10 ** d;
