import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { kickoff, longDate } from '../format.js';
import { formatMoney, currencyLabel } from '../odds.js';
import { OUTCOME_LABEL } from '../markets.js';
import { useApi, Page, Loading, ErrorBanner, Empty, Tabs, OutcomeBadge, Profit, DecisionBadge, MoneyInput } from '../components/ui.jsx';
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
  const m = (x) => formatMoney(x, bet.currency);
  const remove = async () => {
    if (!window.confirm('Are you sure you want to delete this bet?\n\nIt stops counting in your history, profit and bankroll.')) return;
    try { await api.deleteBet(bet.id); onChanged(); } catch (e) { setError(e.message); }
  };
  const single = bet.legs.length === 1 ? bet.legs[0] : null;
  const charges = bet.feeMinor + bet.commissionMinor;
  const settled = bet.outcome !== 'pending' && bet.profitMinor !== null;

  return (
    <div className="card bet-card">
      {/* What, where, and how it ended — the one line to read first. */}
      <div className="bet-top">
        <div className="bet-what">
          <div className="bet-title">{single ? single.label : `Parlay of ${bet.legs.length}`}</div>
          {single && (
            <a className="subtle" href={href('match', single.matchId, { tab: 'analysis' })}>
              {single.home} v {single.away} · {single.score ?? kickoff(single.kickoffUtc)} · {single.competition}
            </a>
          )}
          <div className="subtle">{bet.sportsbook.name} · placed {longDate(bet.placedAt)}</div>
        </div>
        <div className="bet-headline">
          <div className="bet-icons">
            <button className="icon-button" onClick={() => slip.edit(bet)} aria-label="Edit this bet" title="Edit"><EditIcon /></button>
            <button className="icon-button danger" onClick={remove} aria-label="Delete this bet" title="Delete"><TrashIcon /></button>
          </div>
          <OutcomeBadge outcome={bet.outcome} />
          {settled
            ? <span className="bet-big"><Profit minor={bet.profitMinor} currency={bet.currency} format={formatMoney} /></span>
            : <span className="bet-big subtle">Pays {m(bet.potentialPayoutMinor)} if it wins</span>}
        </div>
      </div>

      <div className="bet-sections">
        <section>
          <h4>The order</h4>
          <Facts rows={bet.contracts ? [
            bet.orderAmountMinor && ['Entered amount', m(bet.orderAmountMinor)],
            ['Filled quantity', `${bet.contracts} contract${bet.contracts === 1 ? '' : 's'}`],
            bet.limitPrice && ['Limit price', m(Math.round(bet.limitPrice * 100))],
            ['Avg filled price', m(Math.round(bet.stakeMinor / bet.contracts))],
            ['Filled notional', m(bet.stakeMinor)],
            ['Commissions and fees', m(charges)],
            ['Total cost', m(bet.totalCostMinor), 'strong'],
          ] : [
            ['Bet', m(bet.stakeMinor)],
            [single ? 'Odds' : 'Total odds', single ? `${single.oddsText}${single.oddsFormat !== 'decimal' ? ` (pays ${single.odds.toFixed(2)})` : ''}` : bet.totalOdds.toFixed(2)],
            charges > 0 && ['Fees', m(charges)],
            charges > 0 && ['Total cost', m(bet.totalCostMinor), 'strong'],
          ]} />
        </section>

        <section>
          <h4>The result</h4>
          {settled ? (
            <Facts rows={[
              ['Paid out', m(bet.profitMinor + bet.totalCostMinor)],
              bet.contracts && charges > 0 && ['Realized profit',
                <Profit key="r" minor={bet.profitMinor + charges} currency={bet.currency} format={formatMoney} />],
              charges > 0 && ['Commissions and fees', `−${m(charges)}`],
              [charges > 0 ? 'Profit after fees' : 'Profit', <Profit key="p" minor={bet.profitMinor} currency={bet.currency} format={formatMoney} />, 'strong'],
            ]} />
          ) : (
            <Facts rows={[['Status', 'Waiting for the result'], ['Pays if it wins', m(bet.potentialPayoutMinor)],
              ['Profit if it wins', m(bet.potentialPayoutMinor - bet.totalCostMinor)]]} />
          )}
          {bet.settledBy === 'manual' && (
            <p className="subtle">
              Corrected by hand ·{' '}
              <button className="link-button" onClick={async () => {
                try { await api.useCalculatedResult(bet.id); onChanged(); } catch (e) { setError(e.message); }
              }}>Use the calculated result</button>
            </p>
          )}
        </section>

        {single && (
          <section>
            <h4>The model's view</h4>
            <ModelView leg={single} />
            <ClosingPrice bet={bet} leg={single} onChanged={onChanged} />
          </section>
        )}
      </div>

      {!single && (
        <section className="bet-parlay">
          <h4>Selections</h4>
          {bet.legs.map((l) => (
            <div key={l.id} className="bet-leg">
              <div className="bet-leg-main">
                <span>{l.label} <span className="subtle">at {l.oddsText}{l.oddsFormat !== 'decimal' ? ` (pays ${l.odds.toFixed(2)})` : ''}</span>
                  {' '}<OutcomeBadge outcome={l.outcome} /></span>
                <a className="subtle" href={href('match', l.matchId, { tab: 'analysis' })}>
                  {l.home} v {l.away} · {l.score ?? kickoff(l.kickoffUtc)} · {l.competition}
                </a>
              </div>
              <div><ModelView leg={l} /><ClosingPrice bet={bet} leg={l} onChanged={onChanged} /></div>
            </div>
          ))}
        </section>
      )}

      {bet.notes && <p className="subtle">{bet.notes}</p>}
      <ErrorBanner error={error} />
      <div className="bet-actions">
        <button className="link-button" onClick={() => setCorrecting((c) => !c)}>Correct the result</button>
      </div>
      {correcting && <CorrectForm bet={bet} onDone={() => { setCorrecting(false); onChanged(); }} />}
    </div>
  );
}

const EditIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M11.2 2.3a1.6 1.6 0 0 1 2.3 2.3L5.6 12.5 2.5 13.5l1-3.1z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    <path d="M10 3.5l2.5 2.5" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M2.5 4h11M6 4V2.5h4V4M3.8 4l.7 9.5h7l.7-9.5M6.5 6.5v4.5M9.5 6.5v4.5" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* Label / value rows; falsy rows are skipped. */
function Facts({ rows }) {
  return (
    <dl className="facts">
      {rows.filter(Boolean).map(([k, v, tone]) => (
        <div key={k} className={tone === 'strong' ? 'facts-total' : ''}><dt>{k}</dt><dd>{v}</dd></div>
      ))}
    </dl>
  );
}

/* What the model thought, and whether the price taken beat it. */
function ModelView({ leg: l }) {
  if (l.modelProbability === null) return <p className="subtle">No analysis was made before this bet.</p>;
  return (
    <>
      <Facts rows={[
        ['Model gave it', `${(l.modelProbability * 100).toFixed(1)}%`],
        ['Worth', `${l.fairOdds.toFixed(2)} or better`],
        ['Your price', l.odds.toFixed(2)],
        ['Edge', <span key="e" className={l.edge > 0 ? 'profit-up' : 'profit-down'}>
          {l.edge > 0 ? `+${(l.edge * 100).toFixed(1)} pts` : `None (${(l.edge * 100).toFixed(1)} pts)`}</span>],
        l.followedRecommendation !== null && ['Recommendation',
          <DecisionBadge key="d" decision={l.followedRecommendation ? 'recommend' : 'pass'} />],
      ]} />
      {l.edge > 0.25 && <p className="danger">An edge this big usually means the odds were typed wrongly — check them with Edit.</p>}
    </>
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
          Price at kickoff {leg.closingOdds.toFixed(2)} —{' '}
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
        <label className="slip-field">Profit or loss ({currencyLabel(bet.currency)}, optional)
          <MoneyInput currency={bet.currency} value={profit} placeholder="Worked out if empty" onChange={(e) => setProfit(e.target.value)} />
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
