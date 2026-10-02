import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { kickoff, longDate } from '../format.js';
import { formatMoney } from '../odds.js';
import { OUTCOME_LABEL } from '../markets.js';
import { useApi, Page, Loading, ErrorBanner, Empty, Tabs, OutcomeBadge, Profit, DecisionBadge } from '../components/ui.jsx';
import { useSlip } from '../components/BetSlip.jsx';

export default function Bets() {
  const [status, setStatus] = useState('open');
  const { data, error, loading, reload } = useApi(() => api.listBets({ status }), [status]);
  const slip = useSlip();

  return (
    <Page title="My Bets" subtitle="Bets placed in your betting app and recorded here. They settle automatically once the result is confirmed."
      actions={<button className="primary" onClick={() => slip.setOpen(true)}>Record a bet</button>}>
      <Tabs tabs={[{ key: 'open', label: 'Open' }, { key: 'settled', label: 'Settled' }, { key: '', label: 'All' }]}
        active={status} onChange={setStatus} />
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data?.length ? data.map((b) => <BetCard key={b.id} bet={b} onChanged={reload} />)
        : <Empty>{status === 'open' ? 'No open bets.' : 'No bets here yet.'} Use <strong>Record a bet</strong> after placing one,
          or <strong>I bet this</strong> on a match's Analysis tab.</Empty>}
    </Page>
  );
}

function BetCard({ bet, onChanged }) {
  const slip = useSlip();
  const [correcting, setCorrecting] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    if (!window.confirm('Delete this bet? It is kept in the history but no longer counted.')) return;
    try { await api.deleteBet(bet.id); onChanged(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="card bet-card">
      <div className="bet-head">
        <div>
          <div>{bet.kind === 'parlay' ? `Parlay of ${bet.legs.length}` : 'Single'} · {bet.sportsbook.name}</div>
          <div className="subtle">Placed {longDate(bet.placedAt)}</div>
        </div>
        <div className="bet-figures">
          {bet.contracts ? (
            <>
              <span>{bet.contracts} contract{bet.contracts === 1 ? '' : 's'}{bet.limitPrice ? ` · limit ${Math.round(bet.limitPrice * 10000) / 100}¢` : ''}</span>
              <span>Filled notional {formatMoney(bet.stakeMinor, bet.currency)}</span>
              {bet.commissionMinor > 0 && <span>Commissions {formatMoney(bet.commissionMinor, bet.currency)}</span>}
            </>
          ) : <span>Bet {formatMoney(bet.stakeMinor, bet.currency)}</span>}
          {bet.feeMinor > 0 && <span>Fees {formatMoney(bet.feeMinor, bet.currency)}</span>}
          {bet.totalCostMinor !== bet.stakeMinor && <span>Total cost {formatMoney(bet.totalCostMinor, bet.currency)}</span>}
          <span>Odds {bet.totalOdds.toFixed(2)}</span>
          {bet.outcome === 'pending'
            ? <span>Returns {formatMoney(bet.potentialPayoutMinor, bet.currency)}</span>
            : <span>Profit <Profit minor={bet.profitMinor} currency={bet.currency} format={formatMoney} /></span>}
          <OutcomeBadge outcome={bet.outcome} />
          {bet.settledBy === 'manual' && <span className="subtle">Corrected by hand</span>}
        </div>
      </div>

      <div className="bet-legs">
        {bet.legs.map((l) => (
          <div key={l.id} className="bet-leg">
            <div className="bet-leg-main">
              <span>{l.label} <span className="subtle">at {l.oddsText}{l.oddsFormat !== 'decimal' ? ` (pays ${l.odds.toFixed(2)})` : ''}</span></span>
              <a className="subtle" href={href('match', l.matchId, { tab: 'analysis' })}>
                {l.home} v {l.away} · {l.score ?? kickoff(l.kickoffUtc)} · {l.competition}
              </a>
            </div>
            <div className="bet-figures">
              {l.modelProbability !== null ? (
                <>
                  <span className="subtle">Model gave it {(l.modelProbability * 100).toFixed(1)}%, so worth {l.fairOdds.toFixed(2)} or better</span>
                  <span className={l.edge > 0 ? 'profit-up' : 'profit-down'}>
                    {l.edge > 0 ? `Your price beat that: edge ${(l.edge * 100).toFixed(1)} pts` : `Your price was below that: no edge (${(l.edge * 100).toFixed(1)} pts)`}
                  </span>
                  {l.edge > 0.25 && <span className="danger">An edge this big usually means the odds were typed wrongly — check them with Edit.</span>}
                  {l.followedRecommendation !== null && <DecisionBadge decision={l.followedRecommendation ? 'recommend' : 'pass'} prefix="Model: " />}
                </>
              ) : <span className="subtle">No analysis before this bet</span>}
              {bet.legs.length > 1 && <OutcomeBadge outcome={l.outcome} />}
            </div>
            <ClosingPrice bet={bet} leg={l} onChanged={onChanged} />
          </div>
        ))}
      </div>

      {bet.notes && <p className="subtle">{bet.notes}</p>}
      <ErrorBanner error={error} />
      <div className="bet-actions">
        <button className="link-button" onClick={() => slip.edit(bet)}>Edit</button>
        <button className="link-button" onClick={() => setCorrecting((c) => !c)}>Correct the result</button>
        <button className="link-button danger" onClick={remove}>Delete</button>
      </div>
      {correcting && <CorrectForm bet={bet} onDone={() => { setCorrecting(false); onChanged(); }} />}
    </div>
  );
}

/* The price at kickoff, typed in by hand (there is no odds feed). Beating
 * it consistently is the best sign of judgement there is. */
function ClosingPrice({ bet, leg, onChanged }) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(leg.closingOdds ? String(leg.closingOdds) : '');
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try { await api.setClosingOdds(bet.id, leg.id, value); setOpen(false); onChanged(); } catch (err) { setError(err.message); }
  };
  if (open) {
    return (
      <form className="closing-form" onSubmit={save}>
        <label className="check">Price at kickoff, as your app showed it
          <input value={value} inputMode="text" autoCapitalize="off" autoCorrect="off" placeholder="e.g. 1.95 or 68%" autoFocus onChange={(e) => setValue(e.target.value)} />
        </label>
        <button className="primary" type="submit">Save</button>
        <button type="button" className="link-button" onClick={() => setOpen(false)}>Cancel</button>
        {error && <span className="danger">{error}</span>}
      </form>
    );
  }
  return (
    <div className="bet-figures">
      {leg.closingOdds ? (
        <span className={leg.clv > 0 ? 'profit-up' : 'profit-down'}>
          Price at kickoff {leg.closingOdds.toFixed(2)}; yours {leg.odds.toFixed(2)} —{' '}
          {leg.clv > 0 ? `better than the close by ${(leg.clv * 100).toFixed(1)}%` : leg.clv < 0 ? `worse than the close by ${(-leg.clv * 100).toFixed(1)}%` : 'the same as the close'}
          {Math.abs(leg.clv) > 1 && <span className="danger"> · check the two prices are in the same format</span>}
        </span>
      ) : null}
      <button className="link-button" onClick={() => setOpen(true)}>{leg.closingOdds ? 'Change price at kickoff' : 'Add price at kickoff (optional)'}</button>
    </div>
  );
}

/* Betting apps settle some cases differently; the app's result wins. */
function CorrectForm({ bet, onDone }) {
  const [outcome, setOutcome] = useState(bet.outcome === 'pending' ? 'won' : bet.outcome);
  const [profit, setProfit] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    try { await api.correctSettlement(bet.id, { outcome, profit, reason }); onDone(); } catch (err) { setError(err.message); }
  };
  return (
    <form className="inline-form" onSubmit={save}>
      <ErrorBanner error={error} />
      <div className="slip-row">
        <label className="slip-field">Result in your app
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}>
            {Object.entries(OUTCOME_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="slip-field">Profit or loss ({bet.currency}, optional)
          <input value={profit} inputMode="decimal" placeholder="Worked out if empty" onChange={(e) => setProfit(e.target.value)} />
        </label>
      </div>
      <label className="slip-field">Why
        <input value={reason} placeholder="e.g. The app voided it: player did not start" onChange={(e) => setReason(e.target.value)} />
      </label>
      <div><button className="primary" type="submit" disabled={!reason.trim()}>Save correction</button></div>
      <p className="subtle">The automatic result is kept in the history; your correction takes its place from now on.</p>
    </form>
  );
}
