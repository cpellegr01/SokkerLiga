/* Bankroll tools — optional.
 *
 * One bankroll per currency (betting apps keep their own currency, and
 * amounts in different currencies are never added together).
 *
 *   balance  = starting amount + deposits − withdrawals
 *              + profit of settled bets placed since the bankroll started
 *   exposure = stakes of bets still open
 *
 * Staking plans: flat (the same stake every time), percent (a fixed share
 * of the current balance) or unit (a fixed unit). None of them ever raises
 * a stake to chase a loss or ride a streak; percent follows the balance
 * both ways, which is what keeps a losing run survivable.
 *
 * Settings are dated rows and the ledger is append-only, like everything
 * else in SokkerLiga: a mistake is corrected with an opposite entry.
 */

import { ValidationError } from './db.mjs';
import { parseMoney } from '../src/odds.js';
import { listBets } from './bets.mjs';

const METHODS = ['flat', 'percent', 'unit'];

function settingsFor(db, userId, currency) {
  return db.prepare(`SELECT * FROM bankroll_settings WHERE user_id = ? AND currency = ?
                     ORDER BY effective_from DESC, id DESC LIMIT 1`).get(userId, currency) ?? null;
}

export function saveBankrollSettings(db, userId, input) {
  const currency = String(input.currency ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ValidationError('Choose the currency of this bankroll.');
  const startingMinor = Number.isInteger(input.startingMinor) ? input.startingMinor : parseMoney(input.starting);
  if (startingMinor === null || startingMinor === undefined || startingMinor < 0) throw new ValidationError('Enter the starting amount.');
  if (!METHODS.includes(input.method)) throw new ValidationError('Choose flat, percent or unit staking.');
  let amount;
  if (input.method === 'percent') {
    amount = Number(String(input.amount ?? '').replace(',', '.'));
    if (!(amount > 0 && amount <= 10)) throw new ValidationError('A percentage bet should be between 0.1% and 10% of the balance.');
  } else {
    amount = parseMoney(input.amount);
    if (!amount || amount <= 0) throw new ValidationError(input.method === 'flat' ? 'Enter the bet amount.' : 'Enter the unit size.');
  }
  const maxExposure = Number(input.maxExposurePct ?? 25);
  if (!(maxExposure > 0 && maxExposure <= 100)) throw new ValidationError('Maximum exposure must be between 1% and 100%.');
  const prev = settingsFor(db, userId, currency);
  const startedAt = input.startedAt ? new Date(input.startedAt) : prev ? new Date(prev.started_at) : new Date();
  if (Number.isNaN(startedAt.getTime())) throw new ValidationError('That start date is not valid.');
  db.prepare(`INSERT INTO bankroll_settings (user_id, currency, starting_minor, started_at, method, amount, max_exposure_pct, effective_from)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, currency, startingMinor, startedAt.toISOString(), input.method, amount, maxExposure, new Date().toISOString());
  return bankroll(db, userId);
}

export function addLedgerEntry(db, userId, input) {
  const currency = String(input.currency ?? '').trim().toUpperCase();
  if (!settingsFor(db, userId, currency)) throw new ValidationError('Set up this bankroll first.');
  if (!['deposit', 'withdrawal'].includes(input.kind)) throw new ValidationError('Choose deposit or withdrawal.');
  const amount = parseMoney(input.amount);
  if (!amount || amount <= 0) throw new ValidationError('Enter the amount.');
  const at = input.at ? new Date(input.at) : new Date();
  if (Number.isNaN(at.getTime())) throw new ValidationError('That date is not valid.');
  db.prepare(`INSERT INTO bankroll_ledger (user_id, currency, kind, amount_minor, at, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, currency, input.kind, amount, at.toISOString(), input.note?.trim() || null, new Date().toISOString());
  return bankroll(db, userId);
}

/** The suggested stake for one bankroll, before the exposure cap. */
export function suggestedStake(settings, balanceMinor) {
  if (!settings || balanceMinor <= 0) return 0;
  if (settings.method === 'percent') return Math.floor((balanceMinor * settings.amount) / 100);
  return Math.round(settings.amount);
}

function one(db, userId, currency, bets) {
  const s = settingsFor(db, userId, currency);
  if (!s) return null;
  const ledger = db.prepare(`SELECT id, kind, amount_minor AS amountMinor, at, note FROM bankroll_ledger
                             WHERE user_id = ? AND currency = ? ORDER BY at, id`).all(userId, currency);
  const mine = bets.filter((b) => b.currency === currency && b.placedAt >= s.started_at);
  const settled = mine.filter((b) => b.outcome !== 'pending');
  const open = mine.filter((b) => b.outcome === 'pending');

  /* The balance over time: the start, each ledger entry, each settled bet. */
  const events = [
    ...ledger.map((e) => ({ at: e.at, delta: e.kind === 'deposit' ? e.amountMinor : -e.amountMinor })),
    ...settled.map((b) => ({ at: b.placedAt, delta: b.profitMinor ?? 0 })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  let running = s.starting_minor;
  const overTime = [{ at: s.started_at, balanceMinor: running }];
  for (const e of events) { running += e.delta; overTime.push({ at: e.at, balanceMinor: running }); }

  const deposits = ledger.filter((e) => e.kind === 'deposit').reduce((a, e) => a + e.amountMinor, 0);
  const withdrawals = ledger.filter((e) => e.kind === 'withdrawal').reduce((a, e) => a + e.amountMinor, 0);
  const profit = settled.reduce((a, b) => a + (b.profitMinor ?? 0), 0);
  const balance = s.starting_minor + deposits - withdrawals + profit;
  const exposure = open.reduce((a, b) => a + b.totalCostMinor, 0);
  const cap = Math.max(0, Math.floor((balance * s.max_exposure_pct) / 100) - exposure);
  const plain = suggestedStake(s, balance);
  return {
    currency,
    settings: { startingMinor: s.starting_minor, startedAt: s.started_at, method: s.method, amount: s.amount,
      maxExposurePct: s.max_exposure_pct, effectiveFrom: s.effective_from },
    balanceMinor: balance, depositsMinor: deposits, withdrawalsMinor: withdrawals, profitMinor: profit,
    exposureMinor: exposure, exposurePct: balance > 0 ? (exposure / balance) * 100 : null, openBets: open.length,
    suggestedStakeMinor: Math.min(plain, cap),
    cappedByExposure: plain > cap,
    ledger, overTime,
  };
}

/** Every bankroll the user has set up, plus currencies they bet in without one. */
export function bankroll(db, userId) {
  const bets = listBets(db, userId);
  const configured = db.prepare('SELECT DISTINCT currency FROM bankroll_settings WHERE user_id = ?').all(userId).map((r) => r.currency);
  const used = [...new Set([...bets.map((b) => b.currency),
    ...db.prepare('SELECT DISTINCT currency FROM sportsbooks WHERE is_active = 1').all().map((r) => r.currency)])];
  return {
    bankrolls: configured.map((c) => one(db, userId, c, bets)).filter(Boolean),
    unconfigured: used.filter((c) => !configured.includes(c)),
  };
}
