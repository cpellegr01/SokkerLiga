import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { go } from '../router.js';
import { parseOdds, describeOdds, parseMoney, formatMoney, oddsHint, parseContractPrice } from '../odds.js';
import { MARKET_OPTIONS, selectionLabel } from '../markets.js';
import { kickoff } from '../format.js';
import { ErrorBanner } from './ui.jsx';
import DatePicker from './DatePicker.jsx';

/* The bet slip: where a bet placed in the betting app is recorded.
 * Selections can be added from a match's Analysis tab ("I bet this") or by
 * hand. The draft survives a page reload (per-browser convenience only). */

const SlipContext = createContext(null);
export const useSlip = () => useContext(SlipContext);

const STORE = 'sokkerliga.betslip';
const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? null; } catch { return null; }
};
const emptyDraft = () => ({ editingId: null, legs: [], stake: '', fee: '', byContracts: false, contracts: '', limitPrice: '', commission: '', stakeAuto: false, sportsbook: '', placedAt: '', totalOdds: '', notes: '' });

export function BetSlipProvider({ children }) {
  const [draft, setDraft] = useState(() => load() ?? emptyDraft());
  const [open, setOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify(draft)); } catch { /* private window: fine */ }
  }, [draft]);

  const value = useMemo(() => ({
    draft, setDraft, open, setOpen,
    /** Add a selection (from the Analysis tab or the picker). */
    add(leg) {
      setDraft((d) => {
        const key = (l) => `${l.matchId}|${l.market}|${l.line ?? ''}|${l.selection}`;
        if (d.legs.some((l) => key(l) === key(leg))) return d;
        return { ...d, legs: [...d.legs, { odds: '', ...leg }] };
      });
      setOpen(true);
    },
    /** Load an existing bet to fix it. */
    edit(bet) {
      setDraft({
        editingId: bet.id, stake: (bet.stakeMinor / 100).toFixed(2), fee: bet.feeMinor ? (bet.feeMinor / 100).toFixed(2) : '',
        commission: bet.commissionMinor ? (bet.commissionMinor / 100).toFixed(2) : '',
        byContracts: !!bet.contracts, contracts: bet.contracts ? String(bet.contracts) : '',
        limitPrice: bet.limitPrice ? String(Math.round(bet.limitPrice * 10000) / 100) : '', stakeAuto: false,
        sportsbook: bet.sportsbook.key,
        placedAt: toLocalInput(bet.placedAt), totalOdds: bet.totalOddsText ?? '', notes: bet.notes ?? '',
        legs: bet.legs.map((l) => ({ matchId: l.matchId, home: l.home, away: l.away, kickoffUtc: l.kickoffUtc,
          market: l.market, line: l.line, selection: l.selection, playerName: l.playerName, odds: l.oddsText,
          fairOdds: l.fairOdds, closingOdds: l.closingOdds ?? '' })),
      });
      setOpen(true);
    },
    clear() { setDraft(emptyDraft()); },
  }), [draft, open]);

  return (
    <SlipContext.Provider value={value}>
      {children}
      {!open && draft.legs.length > 0 && (
        <button className="slip-fab" onClick={() => setOpen(true)}>
          Bet slip · {draft.legs.length} {draft.legs.length === 1 ? 'selection' : 'selections'}
        </button>
      )}
      {open && <SlipDrawer />}
    </SlipContext.Provider>
  );
}

const toLocalInput = (iso) => {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function SlipDrawer() {
  const { draft, setDraft, setOpen, clear } = useSlip();
  const [books, setBooks] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(draft.legs.length === 0);
  const [bankrolls, setBankrolls] = useState([]);

  useEffect(() => { api.listSportsbooks().then(setBooks).catch((e) => setError(e.message)); }, []);
  useEffect(() => { api.getBankroll().then((b) => setBankrolls(b.bankrolls)).catch(() => setBankrolls([])); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);
  /* Default to the only (or first active) betting app. */
  useEffect(() => {
    const active = (books ?? []).filter((b) => b.isActive);
    if (!draft.sportsbook && active.length) setDraft((d) => ({ ...d, sportsbook: active[0].key }));
  }, [books, draft.sportsbook, setDraft]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setLeg = (i, patch) => setDraft((d) => ({ ...d, legs: d.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const removeLeg = (i) => setDraft((d) => ({ ...d, legs: d.legs.filter((_, j) => j !== i) }));

  const book = (books ?? []).find((b) => b.key === draft.sportsbook);
  const currency = book?.currency ?? 'USD';
  const parsed = draft.legs.map((l) => parseOdds(l.odds));
  const product = parsed.every(Boolean) && parsed.length ? parsed.reduce((a, p) => a * p.decimal, 1) : null;
  const total = draft.totalOdds ? parseOdds(draft.totalOdds)?.decimal ?? null : product;
  const stakeMinor = parseMoney(draft.stake);
  /* Contracts: the limit price replaces the odds; contracts × limit fills
   * in the bet (until it is typed by hand), and the price actually paid is
   * bet ÷ contracts. */
  const contractMode = !!draft.byContracts && draft.legs.length === 1;
  const contracts = contractMode ? Number(String(draft.contracts ?? '').replace(',', '.')) : 0;
  const hasContracts = contracts > 0;
  const limit = contractMode ? parseContractPrice(draft.limitPrice) : null;
  const payout = hasContracts ? Math.round(contracts * 100) : total && stakeMinor ? Math.round(stakeMinor * total) : null;
  const commissionMinor = contractMode ? parseMoney(draft.commission) ?? 0 : 0;
  const feeMinor = (parseMoney(draft.fee) ?? 0) + commissionMinor;
  const contractCost = hasContracts && limit ? Math.round(contracts * limit * 100) : null;
  const fillCents = hasContracts && stakeMinor ? Number((stakeMinor / contracts).toFixed(2)) : null;
  useEffect(() => {
    if (contractCost && (draft.stakeAuto || !draft.stake)) {
      const v = (contractCost / 100).toFixed(2);
      if (v !== draft.stake) setDraft((d) => ({ ...d, stake: v, stakeAuto: true }));
    }
  }, [contractCost]); // eslint-disable-line react-hooks/exhaustive-deps
  /* The bankroll plan for this app's currency, if one is set up. When
   * editing, this bet's own stake is already counted as open. */
  const plan = bankrolls.find((b) => b.currency === currency) ?? null;
  const limitMinor = plan ? Math.floor((plan.balanceMinor * plan.settings.maxExposurePct) / 100) : null;
  const overLimit = plan && stakeMinor && !draft.editingId && plan.exposureMinor + stakeMinor > limitMinor;

  const save = async () => {
    setError(null);
    setSaving(true);
    const body = {
      sportsbook: draft.sportsbook, stake: draft.stake, fee: draft.fee,
      contracts: contractMode ? draft.contracts : '', limitPrice: contractMode ? draft.limitPrice : '',
      commission: contractMode ? draft.commission : '', totalOdds: draft.legs.length > 1 ? draft.totalOdds : '',
      placedAt: draft.placedAt ? new Date(draft.placedAt).toISOString() : undefined, notes: draft.notes,
      legs: draft.legs.map((l) => ({ matchId: l.matchId, market: l.market, line: l.line, selection: l.selection,
        odds: contractMode ? '' : l.odds,
        closingOdds: l.closingOdds || undefined })),
    };
    try {
      if (draft.editingId) await api.updateBet(draft.editingId, { ...body, reason: 'Edited from the bet slip' });
      else await api.createBet(body);
      clear();
      setOpen(false);
      go('bets');
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="slip-backdrop" onClick={() => setOpen(false)} />
      <aside className="slip" role="dialog" aria-label="Bet slip">
        <header className="slip-header">
          <h2>{draft.editingId ? 'Edit bet' : 'Record a bet'}</h2>
          <button onClick={() => setOpen(false)} aria-label="Close">Close</button>
        </header>
        <div className="slip-body">
          <p className="subtle">Place the bet in your betting app first, then record it here exactly as the app shows it.</p>
          <ErrorBanner error={error} />

          {draft.legs.map((l, i) => {
            const p = parsed[i];
            return (
              <div key={`${l.matchId}-${l.market}-${l.line}-${l.selection}`} className="slip-leg">
                <div className="slip-leg-head">
                  <div>
                    <div>{selectionLabel(l.market, l.line, l.selection, l.home, l.away, l.playerName)}</div>
                    <div className="subtle">{l.home} v {l.away}{l.kickoffUtc ? ` · ${kickoff(l.kickoffUtc)}` : ''}</div>
                  </div>
                  <button className="link-button danger" onClick={() => removeLeg(i)}>Remove</button>
                </div>
                {!contractMode && <><label className="slip-field">Odds taken
                  <input value={l.odds} inputMode="text" autoCapitalize="off" autoCorrect="off" placeholder="2.50, +150, 6/4 or 68%" autoFocus={!l.odds && i === draft.legs.length - 1}
                    onChange={(e) => setLeg(i, { odds: e.target.value })} />
                  <span className="subtle">Type the price exactly as your app shows it: decimal (2.50), American (+150), fractional (6/4),
                    or a percentage or cents (68% or 68¢).</span>
                </label>
                {l.odds && (p
                  ? <span className="subtle">Read as {describeOdds(p.decimal)}: every {formatMoney(100, currency)} bet pays back {formatMoney(Math.round(p.decimal * 100), currency)} if it wins
                    {l.fairOdds ? <ValueNote odds={p.decimal} fair={l.fairOdds} /> : null}</span>
                  : <OddsHint text={l.odds} onUse={(v) => setLeg(i, { odds: v })} />)}</>}
                {contractMode && fillCents && l.fairOdds ? <span className="subtle">At {fillCents}¢<ValueNote odds={100 / fillCents} fair={l.fairOdds} /></span> : null}
              </div>
            );
          })}

          {adding
            ? <AddSelection onAdd={(leg) => { setDraft((d) => ({ ...d, legs: [...d.legs, { odds: '', ...leg }] })); setAdding(false); }}
                onCancel={draft.legs.length ? () => setAdding(false) : null} />
            : <button onClick={() => setAdding(true)}>Add another selection{draft.legs.length ? ' (parlay)' : ''}</button>}

          {draft.legs.length > 0 && (
            <>
              {draft.legs.length === 1 && (
                <label className="check">
                  <input type="checkbox" checked={!!draft.byContracts}
                    onChange={(e) => set({ byContracts: e.target.checked, ...(e.target.checked ? {} : { contracts: '', limitPrice: '' }) })} />
                  Bought as contracts (Robinhood, Kalshi): each pays {formatMoney(100, currency)} if it wins
                </label>
              )}
              {contractMode && (
                <>
                  <div className="slip-row">
                    <label className="slip-field">Contracts
                      <input value={draft.contracts} inputMode="decimal" placeholder="e.g. 14" onChange={(e) => set({ contracts: e.target.value })} />
                    </label>
                    <label className="slip-field">Limit price
                      <input value={draft.limitPrice ?? ''} inputMode="decimal" placeholder="e.g. 68" onChange={(e) => set({ limitPrice: e.target.value })} />
                      <span className="subtle">In cents, as on the order: 68 for 68¢.</span>
                    </label>
                  </div>
                  <div className="slip-row">
                    <label className="slip-field">Filled notional ({currency})
                      <input value={draft.stake} inputMode="decimal" placeholder="9.52" onChange={(e) => set({ stake: e.target.value, stakeAuto: false })} />
                      <span className="subtle">What the contracts cost. Filled in from the limit; change it if the order filled lower.</span>
                    </label>
                    <label className="slip-field">Commissions
                      <input value={draft.commission ?? ''} inputMode="decimal" placeholder="0.00" onChange={(e) => set({ commission: e.target.value })} />
                    </label>
                    <label className="slip-field">Fees
                      <input value={draft.fee} inputMode="decimal" placeholder="0.00" onChange={(e) => set({ fee: e.target.value })} />
                    </label>
                  </div>
                  <OrderSummary contracts={hasContracts ? contracts : null} limit={limit} notional={stakeMinor} commission={commissionMinor}
                    fees={parseMoney(draft.fee) ?? 0} fillCents={fillCents} currency={currency} />
                </>
              )}
              {!contractMode && <div className="slip-row">
                <label className="slip-field">Bet ({currency})
                  <input value={draft.stake} inputMode="decimal" placeholder="10.00" onChange={(e) => set({ stake: e.target.value, stakeAuto: false })} />
                  <span className="subtle">The amount you put on the bet — what you lose if it loses.</span>
                  {payout && (
                    <span className="subtle">
                      If it wins you get {formatMoney(payout, currency)} back: your {formatMoney(stakeMinor, currency)} plus{' '}
                      {formatMoney(payout - stakeMinor, currency)}{feeMinor ? `, less ${formatMoney(feeMinor, currency)} fees: ${formatMoney(payout - stakeMinor - feeMinor, currency)} profit` : ' profit'}.
                    </span>
                  )}
                  {plan && !draft.editingId && (
                    <span className="suggested subtle">
                      Your plan suggests a bet of {formatMoney(plan.suggestedStakeMinor, currency)}
                      {plan.suggestedStakeMinor > 0 && (
                        <button type="button" className="link-button" onClick={() => set({ stake: (plan.suggestedStakeMinor / 100).toFixed(2) })}>Use it</button>
                      )}
                    </span>
                  )}
                  {overLimit && (
                    <span className="danger">
                      With this bet, {formatMoney(plan.exposureMinor + stakeMinor, currency)} would ride on open bets — over your
                      {' '}{plan.settings.maxExposurePct}% limit of {formatMoney(limitMinor, currency)}.
                    </span>
                  )}
                </label>
                <label className="slip-field">Fees ({currency}, optional)
                  <input value={draft.fee} inputMode="decimal" placeholder="0.00" onChange={(e) => set({ fee: e.target.value })} />
                  <span className="subtle">Any fee the app charged on top of the bet. It is counted as spent whatever the result.</span>
                </label>
              </div>}
              <div className="slip-row">
                <label className="slip-field">Betting app
                  {books && books.length ? (
                    <select value={draft.sportsbook} onChange={(e) => set({ sportsbook: e.target.value })}>
                      {books.filter((b) => b.isActive || b.key === draft.sportsbook).map((b) => (
                        <option key={b.key} value={b.key}>{b.name} ({b.currency})</option>
                      ))}
                    </select>
                  ) : <QuickAddBook onAdded={(list) => { setBooks(list); set({ sportsbook: list[0]?.key ?? '' }); }} />}
                </label>
              </div>
              {draft.legs.length > 1 && (
                <label className="slip-field">Total odds shown by the app (optional)
                  <input value={draft.totalOdds} inputMode="text" autoCapitalize="off" autoCorrect="off" placeholder={product ? product.toFixed(2) : ''}
                    onChange={(e) => set({ totalOdds: e.target.value })} />
                  <span className="subtle">Leave empty to multiply the selections. Fill it in if the app boosted or rounded the price.</span>
                </label>
              )}
              <div className="slip-field">Placed at
                <DatePicker mode="datetime" label="Placed at" value={draft.placedAt} placeholder="Now"
                  onChange={(v) => set({ placedAt: v })} />
                <span className="subtle">Leave as "Now" if you just placed it.</span>
              </div>
              <label className="slip-field">Notes
                <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
              </label>
            </>
          )}
        </div>
        {draft.legs.length > 0 && (
          <footer className="slip-footer">
            <div className="slip-summary">
              <span>{draft.legs.length > 1 ? `Parlay of ${draft.legs.length}` : 'Single'} · {contractMode ? (fillCents ? `${contracts} contracts at ${fillCents}¢` : 'contracts') : `odds ${total ? total.toFixed(2) : '—'}`}</span>
              <span>{feeMinor ? `Costs ${formatMoney((stakeMinor ?? 0) + feeMinor, currency)} · ` : ''}Returns {payout ? formatMoney(payout, currency) : '—'}</span>
            </div>
            <div className="bet-actions">
              <button className="primary" onClick={save} disabled={saving || !payout || !draft.sportsbook}>
                {saving ? 'Saving…' : draft.editingId ? 'Save changes' : 'Record bet'}
              </button>
              <button className="link-button" onClick={() => { clear(); setOpen(false); }}>Discard</button>
            </div>
          </footer>
        )}
      </aside>
    </>
  );
}

function OddsHint({ text, onUse }) {
  const h = oddsHint(text);
  return (
    <span className="danger">{h.message}
      {h.suggestion && <> <button type="button" className="link-button" onClick={() => onUse(h.suggestion)}>Use {h.suggestion}</button></>}
    </span>
  );
}

/* A contract order laid out as the app shows it. */
function OrderSummary({ contracts, limit, notional, commission, fees, fillCents, currency }) {
  const m = (x) => formatMoney(x, currency);
  const total = (notional ?? 0) + commission + fees;
  const rows = [
    ['Contracts', contracts ?? '—'],
    ['Limit price', limit ? `${Math.round(limit * 10000) / 100}¢` : '—'],
    ['Cost at the limit', contracts && limit ? `${contracts} × ${Math.round(limit * 10000) / 100}¢ = ${m(Math.round(contracts * limit * 100))}` : '—'],
    ['Filled notional', notional ? `${m(notional)}${fillCents ? ` (${fillCents}¢ a contract)` : ''}` : '—'],
    ['Commissions', m(commission)],
    ['Fees', m(fees)],
  ];
  return (
    <div className="order-summary">
      {rows.map(([k, v]) => <div key={k}><span className="subtle">{k}</span><span>{v}</span></div>)}
      <div className="order-total"><span>Total cost</span><span>{notional ? m(total) : '—'}</span></div>
      {contracts && notional ? (
        <div><span className="subtle">Pays if it wins</span>
          <span>{m(Math.round(contracts * 100))} · profit <span className={contracts * 100 - total > 0 ? 'profit-up' : 'profit-down'}>{m(Math.round(contracts * 100) - total)}</span></span></div>
      ) : null}
    </div>
  );
}

/* Compare the price taken with the model's fair odds at the time. */
function ValueNote({ odds, fair }) {
  const edge = 1 / fair - 1 / odds;
  return odds > fair
    ? <span className="profit-up"> · above the model's fair {fair.toFixed(2)} (edge {(edge * 100).toFixed(1)} pts)</span>
    : <span className="profit-down"> · below the model's fair {fair.toFixed(2)} — no edge</span>;
}

function QuickAddBook({ onAdded }) {
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState(null);
  const add = async () => {
    try { onAdded(await api.saveSportsbook({ name, currency })); } catch (e) { setError(e.message); }
  };
  return (
    <div className="slip-field">
      <span className="subtle">No betting apps yet. Add the one you use:</span>
      <input placeholder="Name, e.g. DraftKings" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="Currency" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
      {error && <span className="danger">{error}</span>}
      <button onClick={add} disabled={!name.trim()}>Add betting app</button>
    </div>
  );
}

/* Pick a match and selection by hand: matches from yesterday to a week ahead. */
function AddSelection({ onAdd, onCancel }) {
  const [q, setQ] = useState('');
  const [matches, setMatches] = useState(null);
  const [match, setMatch] = useState(null);
  const [market, setMarket] = useState('match_result');
  const [line, setLine] = useState('');
  const [selection, setSelection] = useState('home');
  const [squads, setSquads] = useState(null);

  useEffect(() => {
    const from = new Date(Date.now() - 2 * 86400_000).toISOString();
    const to = new Date(Date.now() + 8 * 86400_000).toISOString();
    api.listMatches({ from, to }).then(setMatches).catch(() => setMatches([]));
  }, []);
  const opt = MARKET_OPTIONS.find((m) => m.key === market);
  useEffect(() => {
    setSelection(opt.selections[0] ?? '');
    setLine(opt.line ? String(opt.defaultLine) : '');
  }, [market]); // eslint-disable-line react-hooks/exhaustive-deps
  /* Player markets: both squads, top scorers first. */
  useEffect(() => {
    if (!opt.player || !match) return;
    setSquads(null);
    api.matchPlayers(match.id).then(setSquads).catch(() => setSquads({ home: { players: [] }, away: { players: [] } }));
  }, [opt.player, match]);
  const players = squads ? [...squads.home.players, ...squads.away.players] : [];
  const playerName = opt.player ? players.find((p) => `p:${p.id}` === selection)?.name ?? null : null;

  const shown = (matches ?? []).filter((m) => !q || `${m.home.name} ${m.away.name} ${m.competition.name}`.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <div className="slip-leg">
      {!match ? (
        <>
          <label className="slip-field">Match
            <input placeholder="Search by team or competition" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="plain">
            {matches === null ? <span className="subtle">Loading…</span> : shown.map((m) => (
              <button key={m.id} className="link-button" style={{ textAlign: 'left', padding: '0.25rem 0' }} onClick={() => setMatch(m)}>
                {m.home.name} v {m.away.name} <span className="subtle">· {kickoff(m.kickoffUtc)} · {m.competition.name}</span>
              </button>
            ))}
            {matches && !shown.length && <span className="subtle">No matches found.</span>}
          </div>
        </>
      ) : (
        <>
          <div className="slip-leg-head">
            <div>{match.home.name} v {match.away.name}<div className="subtle">{kickoff(match.kickoffUtc)}</div></div>
            <button className="link-button" onClick={() => setMatch(null)}>Change</button>
          </div>
          <label className="slip-field">Market
            <select value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKET_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
            </select>
          </label>
          <div className="slip-row">
            {opt.line && (
              <label className="slip-field">Line
                <input value={line} inputMode="text" autoCapitalize="off" autoCorrect="off" onChange={(e) => setLine(e.target.value)} />
              </label>
            )}
            {opt.player ? (
              <label className="slip-field">Player
                {squads === null ? <span className="subtle">Loading the squads…</span> : (
                  <select value={selection} onChange={(e) => setSelection(e.target.value)}>
                    <option value="">Choose a player</option>
                    {[['home', squads.home], ['away', squads.away]].map(([side, team]) => (
                      <optgroup key={side} label={team.name ?? (side === 'home' ? match.home.name : match.away.name)}>
                        {team.players.map((p) => (
                          <option key={p.id} value={`p:${p.id}`}>{p.name}{p.goals ? ` (${p.goals} goals this year)` : ''}</option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </label>
            ) : (
              <label className="slip-field">Selection
                <select value={selection} onChange={(e) => setSelection(e.target.value)}>
                  {opt.selections.map((s) => (
                    <option key={s} value={s}>{selectionLabel(market, opt.line ? Number(line) : null, s, match.home.name, match.away.name)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <button className="primary" disabled={(opt.line && !Number.isFinite(Number(line))) || !selection}
            onClick={() => onAdd({ matchId: match.id, home: match.home.name, away: match.away.name, kickoffUtc: match.kickoffUtc,
              market, line: opt.line ? Number(line) : null, selection, playerName })}>
            Add to slip
          </button>
        </>
      )}
      {onCancel && <button className="link-button" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
