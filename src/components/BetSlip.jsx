import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import * as api from '../api.js';
import { go } from '../router.js';
import { parseOdds, describeOdds, parseMoney, formatMoney } from '../odds.js';
import { MARKET_OPTIONS, selectionLabel } from '../markets.js';
import { kickoff } from '../format.js';
import { ErrorBanner } from './ui.jsx';

/* The bet slip: where a bet placed in the betting app is recorded.
 * Selections can be added from a match's Analysis tab ("I bet this") or by
 * hand. The draft survives a page reload (per-browser convenience only). */

const SlipContext = createContext(null);
export const useSlip = () => useContext(SlipContext);

const STORE = 'sokkerliga.betslip';
const load = () => {
  try { return JSON.parse(localStorage.getItem(STORE)) ?? null; } catch { return null; }
};
const emptyDraft = () => ({ editingId: null, legs: [], stake: '', sportsbook: '', placedAt: '', totalOdds: '', notes: '' });

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
        editingId: bet.id, stake: (bet.stakeMinor / 100).toFixed(2), sportsbook: bet.sportsbook.key,
        placedAt: toLocalInput(bet.placedAt), totalOdds: bet.totalOddsText ?? '', notes: bet.notes ?? '',
        legs: bet.legs.map((l) => ({ matchId: l.matchId, home: l.home, away: l.away, kickoffUtc: l.kickoffUtc,
          market: l.market, line: l.line, selection: l.selection, odds: l.oddsText, fairOdds: l.fairOdds })),
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

  useEffect(() => { api.listSportsbooks().then(setBooks).catch((e) => setError(e.message)); }, []);
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
  const payout = total && stakeMinor ? Math.round(stakeMinor * total) : null;

  const save = async () => {
    setError(null);
    setSaving(true);
    const body = {
      sportsbook: draft.sportsbook, stake: draft.stake, totalOdds: draft.legs.length > 1 ? draft.totalOdds : '',
      placedAt: draft.placedAt ? new Date(draft.placedAt).toISOString() : undefined, notes: draft.notes,
      legs: draft.legs.map((l) => ({ matchId: l.matchId, market: l.market, line: l.line, selection: l.selection, odds: l.odds })),
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
                    <div>{selectionLabel(l.market, l.line, l.selection, l.home, l.away)}</div>
                    <div className="subtle">{l.home} v {l.away}{l.kickoffUtc ? ` · ${kickoff(l.kickoffUtc)}` : ''}</div>
                  </div>
                  <button className="link-button danger" onClick={() => removeLeg(i)}>Remove</button>
                </div>
                <label className="slip-field">Odds taken
                  <input value={l.odds} inputMode="decimal" placeholder="2.50, +150 or 6/4" autoFocus={!l.odds && i === draft.legs.length - 1}
                    onChange={(e) => setLeg(i, { odds: e.target.value })} />
                </label>
                {l.odds && (p
                  ? <span className="subtle">{describeOdds(p.decimal)}{l.fairOdds ? <ValueNote odds={p.decimal} fair={l.fairOdds} /> : null}</span>
                  : <span className="danger">Not valid odds yet</span>)}
              </div>
            );
          })}

          {adding
            ? <AddSelection onAdd={(leg) => { setDraft((d) => ({ ...d, legs: [...d.legs, { odds: '', ...leg }] })); setAdding(false); }}
                onCancel={draft.legs.length ? () => setAdding(false) : null} />
            : <button onClick={() => setAdding(true)}>Add another selection{draft.legs.length ? ' (parlay)' : ''}</button>}

          {draft.legs.length > 0 && (
            <>
              <div className="slip-row">
                <label className="slip-field">Stake ({currency})
                  <input value={draft.stake} inputMode="decimal" placeholder="10.00" onChange={(e) => set({ stake: e.target.value })} />
                </label>
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
                  <input value={draft.totalOdds} inputMode="decimal" placeholder={product ? product.toFixed(2) : ''}
                    onChange={(e) => set({ totalOdds: e.target.value })} />
                  <span className="subtle">Leave empty to multiply the selections. Fill it in if the app boosted or rounded the price.</span>
                </label>
              )}
              <label className="slip-field">Placed at
                <input type="datetime-local" value={draft.placedAt} onChange={(e) => set({ placedAt: e.target.value })} />
                <span className="subtle">Leave empty for now.</span>
              </label>
              <label className="slip-field">Notes
                <textarea rows={2} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} />
              </label>
            </>
          )}
        </div>
        {draft.legs.length > 0 && (
          <footer className="slip-footer">
            <div className="slip-summary">
              <span>{draft.legs.length > 1 ? `Parlay of ${draft.legs.length}` : 'Single'} · odds {total ? total.toFixed(2) : '—'}</span>
              <span>Returns {payout ? formatMoney(payout, currency) : '—'}</span>
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

  useEffect(() => {
    const from = new Date(Date.now() - 2 * 86400_000).toISOString();
    const to = new Date(Date.now() + 8 * 86400_000).toISOString();
    api.listMatches({ from, to }).then(setMatches).catch(() => setMatches([]));
  }, []);
  const opt = MARKET_OPTIONS.find((m) => m.key === market);
  useEffect(() => {
    setSelection(opt.selections[0]);
    setLine(opt.line ? String(opt.defaultLine) : '');
  }, [market]); // eslint-disable-line react-hooks/exhaustive-deps

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
                <input value={line} inputMode="decimal" onChange={(e) => setLine(e.target.value)} />
              </label>
            )}
            <label className="slip-field">Selection
              <select value={selection} onChange={(e) => setSelection(e.target.value)}>
                {opt.selections.map((s) => (
                  <option key={s} value={s}>{selectionLabel(market, opt.line ? Number(line) : null, s, match.home.name, match.away.name)}</option>
                ))}
              </select>
            </label>
          </div>
          <button className="primary" disabled={opt.line && !Number.isFinite(Number(line))}
            onClick={() => onAdd({ matchId: match.id, home: match.home.name, away: match.away.name, kickoffUtc: match.kickoffUtc,
              market, line: opt.line ? Number(line) : null, selection })}>
            Add to slip
          </button>
        </>
      )}
      {onCancel && <button className="link-button" onClick={onCancel}>Cancel</button>}
    </div>
  );
}
