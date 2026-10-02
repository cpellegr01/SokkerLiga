import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { longDate, ago } from '../format.js';
import { CONFIDENCE_LABEL } from '../markets.js';
import { useApi, Loading, ErrorBanner, StanceBadge, DecisionBadge } from '../components/ui.jsx';

const pct = (p) => `${(p * 100).toFixed(1)}%`;

/** The Analysis tab of the Match Center. */
export default function Analysis({ match }) {
  const { data, error, reload } = useApi(() => api.getAnalysis(match.id), [match.id]);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const started = Date.parse(match.kickoffUtc) <= Date.now();

  /* While a run is queued or running, check every two seconds. */
  const pending = data?.pending;
  useEffect(() => {
    if (!pending) return undefined;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [pending, reload]);

  const run = async () => {
    setBusy(true);
    setRequestError(null);
    try { await api.analyze(match.id); reload(); } catch (e) { setRequestError(e.message); } finally { setBusy(false); }
  };

  if (error) return <ErrorBanner error={error} />;
  if (!data) return <Loading />;
  const latest = data.latest;

  const button = !started && (
    <button className="primary" onClick={run} disabled={busy || !!pending}>
      {pending ? 'Analysing…' : latest ? 'Analyse again' : 'Analyse match'}
    </button>
  );

  return (
    <div className="analysis">
      <ErrorBanner error={requestError} />
      {!latest && (
        <div className="card pad">
          <h3>Analyse this match</h3>
          <p className="subtle">
            SokkerLiga's statistical model works out a probability and fair odds for each market, from its own
            database as it stands now. Claude then reads the same evidence and explains what supports and what
            undermines each pick. Your thresholds decide Recommend or Pass. Predictions are saved and can't be
            changed afterwards.
          </p>
          {started ? <p className="subtle">This match has kicked off, so no new analysis can be made.</p> : button}
          {pending && <p className="subtle">{pending.status === 'queued' ? 'Waiting to start…' : 'Working — this usually takes under a minute.'}</p>}
          <FailedRun runs={data.runs} />
        </div>
      )}

      {latest && (
        <>
          <RunHeader latest={latest} button={button} pending={pending} started={started} />
          <FailedRun runs={data.runs.filter((r) => r.requested_at > latest.run.requested_at)} />
          <ModelView latest={latest} match={match} />
          <Explanation latest={latest} />
          <TopPicks predictions={latest.predictions} />
          <AllMarkets predictions={latest.predictions} />
        </>
      )}
    </div>
  );
}

function FailedRun({ runs }) {
  const failed = runs.find((r) => r.status === 'failed');
  return failed ? <div className="banner error">The last analysis failed: {failed.error}</div> : null;
}

function RunHeader({ latest, button, pending, started }) {
  const { run, freshness, thresholds } = latest;
  return (
    <div className="card pad run-header">
      <div>
        <p><strong>Analysed {longDate(run.as_of)}</strong> <span className="subtle">({ago(run.as_of)})</span></p>
        <p className="subtle">
          Model: Dixon–Coles v{run.prob_model_version}
          {run.ai_status === 'explained' && ` · Explained by ${run.ai_model} (prompt v${run.prompt_version})`}
          {run.cost_cents !== null && ` · ${run.cost_cents.toFixed(1)}¢`}
          {freshness && ` · ${freshness.resultsKnown.toLocaleString()} results known, latest ${freshness.latestResultUsed?.slice(0, 10) ?? '—'}`}
          {freshness && (freshness.lineupsConfirmed ? ' · Lineups confirmed' : ' · Lineups not yet known')}
        </p>
        {thresholds && (
          <p className="subtle">
            Thresholds used: confidence {thresholds.minConfidence} or better, probability ≥ {Math.round(thresholds.minProbability * 100)}%,
            fair odds {thresholds.minFairOdds ? `${thresholds.minFairOdds}–` : '≤ '}{thresholds.maxFairOdds} · <a href={href('settings')}>Change</a>
          </p>
        )}
      </div>
      <div className="run-actions">
        {button}
        {pending && <span className="subtle">{pending.status === 'queued' ? 'Waiting to start…' : 'Working…'}</span>}
        {started && <span className="subtle">Kicked off — this analysis is final.</span>}
      </div>
    </div>
  );
}

function ModelView({ latest, match }) {
  const g = latest.goalsModel;
  if (!g) return null;
  return (
    <div className="card pad">
      <h3>The model's view</h3>
      <div className="kpis compact">
        <div className="kpi"><span className="kpi-value">{g.expectedHome.toFixed(2)}</span><span className="kpi-label">{match.home.name} expected goals</span></div>
        <div className="kpi"><span className="kpi-value">{g.expectedAway.toFixed(2)}</span><span className="kpi-label">{match.away.name} expected goals</span></div>
        <div className="kpi"><span className="kpi-value">{g.fittedOn.toLocaleString()}</span><span className="kpi-label">Matches the model learned from</span></div>
      </div>
      <p className="subtle">
        Most likely scores:{' '}
        {g.likelyScores.map((s) => `${s.home}–${s.away} (${pct(s.p)})`).join(' · ')}
      </p>
    </div>
  );
}

function Explanation({ latest }) {
  const { run, explanation } = latest;
  if (!explanation) {
    return (
      <div className="card pad soon">
        <h3>Claude's explanation</h3>
        <p className="subtle">
          {run.ai_status === 'skipped' ? 'Not available: no Anthropic API key is configured on the server. The model\'s predictions below stand on their own.'
            : `Not available this time: ${run.ai_error}`}
        </p>
      </div>
    );
  }
  return (
    <div className="card pad">
      <h3>Claude's explanation</h3>
      <p><strong>{explanation.summary}</strong></p>
      {explanation.narrative.split(/\n{2,}/).map((para, i) => <p key={i}>{para}</p>)}
      {explanation.keyFactors.length > 0 && (
        <>
          <h4>Key factors</h4>
          <ul className="factors">
            {explanation.keyFactors.map((f, i) => (
              <li key={i}><strong>{f.label}</strong> <span className="pill">{FAVOURS[f.favours] ?? f.favours}</span> — {f.evidence}</li>
            ))}
          </ul>
        </>
      )}
      {explanation.dataGaps.length > 0 && (
        <>
          <h4>Missing from the data</h4>
          <ul className="factors">{explanation.dataGaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
        </>
      )}
    </div>
  );
}

const FAVOURS = { home: 'Home', away: 'Away', more_goals: 'More goals', fewer_goals: 'Fewer goals', neutral: 'Neutral' };

/* The strongest recommendation in each market. */
function TopPicks({ predictions }) {
  const best = new Map();
  for (const p of predictions.filter((x) => x.decision === 'recommend')) {
    const cur = best.get(p.market);
    if (!cur || p.probability > cur.probability) best.set(p.market, p);
  }
  const picks = [...best.values()].sort((a, b) => b.probability - a.probability);
  return (
    <div className="card pad">
      <h3>Recommendations</h3>
      <p className="subtle">
        The strongest pick in each market that passed your thresholds. Fair odds are what the model thinks the
        selection is worth: it is only good value in your betting app at a <strong>higher</strong> price.
      </p>
      {!picks.length && <p>Nothing passed your thresholds — every selection is a Pass for this match.</p>}
      <div className="pick-grid">
        {picks.map((p) => (
          <div key={p.id} className="pick">
            <div className="pick-title">{p.label}</div>
            <div className="subtle">{p.marketName}</div>
            <div className="pick-numbers">
              <span><strong>{pct(p.probability)}</strong> probability</span>
              <span><strong>{p.fairOdds.toFixed(2)}</strong> fair odds</span>
              <span className={`pill conf-${p.confidence}`}>{CONFIDENCE_LABEL[p.confidence]} confidence</span>
              <StanceBadge stance={p.aiStance} prefix="Claude: " />
            </div>
            <Factors factors={p.factors} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Factors({ factors }) {
  if (!factors.length) return null;
  const forF = factors.filter((f) => f.direction === 'for');
  const against = factors.filter((f) => f.direction === 'against');
  return (
    <div className="pick-factors">
      {forF.map((f, i) => <div key={`f${i}`} className="factor for">+ <strong>{f.label}</strong>: {f.evidence}</div>)}
      {against.map((f, i) => <div key={`a${i}`} className="factor against">− <strong>{f.label}</strong>: {f.evidence}</div>)}
    </div>
  );
}

function AllMarkets({ predictions }) {
  const [open, setOpen] = useState(false);
  const groups = new Map();
  for (const p of predictions) {
    if (!groups.has(p.marketName)) groups.set(p.marketName, []);
    groups.get(p.marketName).push(p);
  }
  return (
    <div className="card">
      <div className="pad-x section-toggle">
        <h3>All markets ({predictions.length} selections)</h3>
        <button onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Selection</th><th className="num">Probability</th><th className="num">Fair odds</th>
              <th>Confidence</th><th>Decision</th><th className="hide-sm">Claude</th></tr></thead>
            <tbody>
              {[...groups].map(([name, rows]) => [
                <tr key={name} className="group-row"><td colSpan={6}>{name}</td></tr>,
                ...rows.map((p) => (
                  <tr key={p.id}>
                    <td>{p.label}</td>
                    <td className="num">{pct(p.probability)}</td>
                    <td className="num">{p.fairOdds.toFixed(2)}</td>
                    <td>{CONFIDENCE_LABEL[p.confidence]}</td>
                    <td title={p.passReasons.join('\n')}>
                      <DecisionBadge decision={p.decision} reasons={p.passReasons} />
                    </td>
                    <td className="hide-sm"><StanceBadge stance={p.aiStance} /></td>
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
