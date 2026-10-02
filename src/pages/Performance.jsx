import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { ago, longDate } from '../format.js';
import { MARKET_OPTIONS } from '../markets.js';
import { useApi, Page, Loading, ErrorBanner, Empty, Crest } from '../components/ui.jsx';

const pct = (x, d = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(d)}%`);
const n3 = (x) => (x === null || x === undefined ? '—' : x.toFixed(3));
const count = (x) => Math.round(x ?? 0).toLocaleString();
const monthsAgo = (n) => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
const PERIODS = [['', 'All time'], ['12', 'Last 12 months'], ['3', 'Last 3 months']];
const CONF = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence' };

export default function Performance() {
  const [f, setF] = useState({ source: '', competition: '', market: '', confidence: '', model: '', period: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const comps = useApi(() => api.listCompetitions(), []);
  const params = { ...f, period: undefined, from: f.period ? monthsAgo(Number(f.period)) : '' };
  const { data, error, loading } = useApi(() => api.getPerformance(params), [JSON.stringify(f)]);

  return (
    <Page title="Model Performance"
      subtitle="Were the predictions right? Every graded selection, from live analyses and from the backtest — the model re-run on past matches as it would have seen them on the morning of each match day.">
      <div className="filters">
        <select value={f.source} onChange={(e) => set({ source: e.target.value })} aria-label="Source">
          <option value="">Live and backtest</option><option value="live">Live analyses only</option><option value="backtest">Backtest only</option>
        </select>
        <select value={f.competition} onChange={(e) => set({ competition: e.target.value })} aria-label="Competition">
          <option value="">All competitions</option>
          {(comps.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.market} onChange={(e) => set({ market: e.target.value })} aria-label="Market">
          <option value="">All markets</option>
          {MARKET_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
        <select value={f.confidence} onChange={(e) => set({ confidence: e.target.value })} aria-label="Confidence">
          <option value="">Any confidence</option>
          {Object.entries(CONF).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        {data?.options.models.length > 1 && (
          <select value={f.model} onChange={(e) => set({ model: e.target.value })} aria-label="Model version">
            <option value="">All model versions</option>
            {data.options.models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        )}
        <select value={f.period} onChange={(e) => set({ period: e.target.value })} aria-label="Period">
          {PERIODS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          <BacktestNote b={data.backtest} />
          {!data.total.n ? <Empty>No graded selections match these filters yet.</Empty> : (
            <>
              <Headline t={data.total} />
              <div className="breakdowns">
                <div className="card pad">
                  <h3>Calibration</h3>
                  <p className="subtle">Does a 70% call come in 70% of the time? Each point is a group of calls; on the diagonal is perfect.</p>
                  <Reliability buckets={data.total.reliability} />
                </div>
                <Breakdown title="By confidence" note="Confidence should mean something: higher bands should score better." rows={data.byConfidence}
                  label={(r) => CONF[r.key] ?? r.key} />
              </div>
              <div className="breakdowns">
                <Breakdown title="By market" rows={data.byMarket} label={(r) => r.label} />
                <Breakdown title="By competition" rows={data.byCompetition} label={(r) => r.label} />
                {data.bySource.length > 1 && <Breakdown title="Live and backtest" rows={data.bySource} label={(r) => (r.key === 'live' ? 'Live analyses' : 'Backtest')} />}
                {data.byModel.length > 1 && <Breakdown title="By model version" rows={data.byModel} label={(r) => r.key} />}
                <Breakdown title="By month" rows={data.byMonth} label={(r) => r.key} />
                <Teams teams={data.teams} />
              </div>
            </>
          )}
          <Calibration rows={data.calibration} />
          <Challenger c={data.challenger} />
        </>
      )}
    </Page>
  );
}

function BacktestNote({ b }) {
  if (!b) return null;
  if (!b.matches && !b.remaining) {
    return <div className="banner warn">The backtest has not started yet. It runs in the background every ten minutes (Settings → Data sync → Backtest).</div>;
  }
  return (
    <p className="subtle">
      Backtest: {b.priced.toLocaleString()} past matches priced{b.first ? `, ${b.first.slice(0, 10)} to ${b.last.slice(0, 10)}` : ''}.
      {b.remaining > 0 && ` ${b.remaining.toLocaleString()} more to go — it works through them in the background.`}
      {b.waitingForDetails > 0 && ` ${b.waitingForDetails.toLocaleString()} wait for their match details (corners, cards, scorers) to arrive.`}
    </p>
  );
}

function Headline({ t }) {
  const diff = t.saidPct - t.hitPct;
  return (
    <div className="kpis">
      <Kpi label="Graded selections" value={count(t.n)} />
      <Kpi label="Said on average" value={pct(t.saidPct)} />
      <Kpi label="Came in" value={pct(t.hitPct)}
        note={Math.abs(diff) < 0.015 ? 'About right' : diff > 0 ? 'The model was too confident' : 'The model was too cautious'} />
      <Kpi label="Brier score (lower is better)" value={n3(t.brier)} note={`Naive guess ${n3(t.naiveBrier)}`} />
      <Kpi label="Skill over the naive guess" value={<span className={t.skill > 0 ? 'profit-up' : 'profit-down'}>{pct(t.skill)}</span>} />
      <Kpi label="Log loss (lower is better)" value={n3(t.logLoss)} />
      <Kpi label="Average calibration error" value={pct(t.ece)} />
    </div>
  );
}

const Kpi = ({ label, value, note }) => (
  <div className="kpi"><span className="kpi-value">{value}</span><span className="kpi-label">{label}</span>
    {note && <span className="kpi-label">{note}</span>}</div>
);

/* Said (x) against happened (y), one dot per 10% bucket, sized by count.
 * Axis labels are HTML so they stay 12px at any width. */
function Reliability({ buckets }) {
  const S = 200;
  const max = Math.max(...buckets.map((b) => b.n));
  return (
    <>
      <div className="reliability">
        <span className="reliability-y subtle">Came in</span>
        <svg viewBox={`0 0 ${S} ${S}`} className="reliability-chart" role="img"
          aria-label={`Calibration: ${buckets.map((b) => `said ${pct(b.said, 0)}, came in ${pct(b.happened, 0)}`).join('; ')}`}>
          {[0.25, 0.5, 0.75].map((g) => (
            <g key={g}>
              <line className="grid" x1={g * S} x2={g * S} y1={0} y2={S} vectorEffect="non-scaling-stroke" />
              <line className="grid" y1={g * S} y2={g * S} x1={0} x2={S} vectorEffect="non-scaling-stroke" />
            </g>
          ))}
          <line className="diagonal" x1={0} y1={S} x2={S} y2={0} vectorEffect="non-scaling-stroke" />
          <polyline className="line" vectorEffect="non-scaling-stroke"
            points={buckets.map((b) => `${b.said * S},${S - b.happened * S}`).join(' ')} />
          {buckets.map((b) => (
            <circle key={b.bucket} className="dot" cx={b.said * S} cy={S - b.happened * S} r={2.5 + 5 * Math.sqrt(b.n / max)} />
          ))}
        </svg>
        <span className="reliability-x subtle">The model said · 0% to 100%</span>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Model said</th><th className="num">Came in</th><th className="num">Selections</th></tr></thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.bucket}>
                <td>{b.bucket * 10}–{b.bucket * 10 + 10}% <span className="subtle">(average {pct(b.said)})</span></td>
                <td className={`num ${Math.abs(b.said - b.happened) > 0.05 ? 'profit-down' : ''}`}>{pct(b.happened)}</td>
                <td className="num">{count(b.n)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Breakdown({ title, note, rows, label }) {
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h3 className="pad-x">{title}</h3>
      {note && <p className="subtle pad-x">{note}</p>}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{' '}</th><th className="num">Selections</th><th className="num">Said</th><th className="num">Came in</th>
            <th className="num">Brier</th><th className="num hide-sm">Naive</th><th className="num">Skill</th>
            <th className="num hide-sm">Calibration error</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{label(r)}</td>
                <td className="num">{count(r.n)}</td>
                <td className="num">{pct(r.saidPct)}</td>
                <td className="num">{pct(r.hitPct)}</td>
                <td className="num">{n3(r.brier)}</td>
                <td className="num hide-sm">{n3(r.naiveBrier)}</td>
                <td className={`num ${r.skill > 0 ? 'profit-up' : 'profit-down'}`}>{pct(r.skill)}</td>
                <td className="num hide-sm">{pct(r.ece)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Teams({ teams }) {
  if (!teams?.worst.length) return null;
  return (
    <div className="card">
      <h3 className="pad-x">Teams the model reads worst</h3>
      <p className="subtle pad-x">Match-result log loss in their matches, against the average of {n3(teams.average)}. Teams with 15 or more graded matches.</p>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Team</th><th className="num">Matches</th><th className="num">Log loss</th><th className="num">Above average</th></tr></thead>
          <tbody>
            {teams.worst.map((t) => (
              <tr key={t.teamId}>
                <td><a className="team-cell" href={href('team', t.teamId)}><Crest src={t.logo} name={t.name} size={18} /> {t.name}</a></td>
                <td className="num">{t.matches}</td>
                <td className="num">{n3(t.logLoss)}</td>
                <td className="num profit-down">+{n3(t.excess)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Calibration({ rows }) {
  return (
    <>
      <h2>Calibration layer</h2>
      <p className="subtle">
        Each night, every market's probabilities are compared with how often such calls came in, and a monotone correction is
        fitted. It is tried on the oldest 80% and scored on the newest 20%; it is applied to new analyses only if it improved
        that newest 20%. Confidence also drops for markets whose calls have been off.
      </p>
      {!rows.length ? <Empty>No calibration yet: each market needs 400 graded selections. The backtest provides them.</Empty> : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Market</th><th className="num">Fitted on</th><th className="num hide-sm">Held out</th>
                <th className="num">Log loss before → after</th><th className="num">Calibration error before → after</th><th>Status</th>
                <th className="hide-sm">Fitted</th></tr></thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.market}>
                    <td>{c.label}</td>
                    <td className="num">{count(c.n)}</td>
                    <td className="num hide-sm">{count(c.holdoutN)}</td>
                    <td className="num">{n3(c.raw.logLoss)} → {n3(c.calibrated.logLoss)}</td>
                    <td className="num">{pct(c.raw.ece)} → {pct(c.calibrated.ece)}</td>
                    <td>{c.applied ? <span className="pill outcome-good">Applied</span> : <span className="pill outcome-mixed">Not needed</span>}</td>
                    <td className="hide-sm subtle">{ago(c.fittedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Challenger({ c }) {
  return (
    <>
      <h2>Learned challenger</h2>
      <p className="subtle">
        A second model for the match result, trained each night on the backtest: Dixon–Coles' own view plus recent form, rest,
        fixture congestion, league position and continental matches. It runs in the shadow — its view is shown on each
        analysis and scored here, but recommendations still come from Dixon–Coles.
      </p>
      {!c ? <Empty>Not trained yet: it needs 600 backtest matches.</Empty> : (
        <div className="card pad">
          <p>
            Version {c.version}, trained {longDate(c.trainedAt)} on {c.nTrain.toLocaleString()} matches, scored on the
            newest {c.nTest.toLocaleString()}.{' '}
            {c.holdout.challenger.logLoss < c.holdout.dixonColes.logLoss - 0.002
              ? <span className="pill outcome-good">Better than Dixon–Coles on held-out matches</span>
              : c.holdout.challenger.logLoss <= c.holdout.dixonColes.logLoss + 0.002
                ? <span className="pill outcome-mixed">About the same as Dixon–Coles</span>
                : <span className="pill outcome-bad">Worse than Dixon–Coles</span>}
          </p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>{' '}</th><th className="num">Challenger</th><th className="num">Dixon–Coles</th></tr></thead>
              <tbody>
                <tr><td>Held-out log loss</td><td className="num">{n3(c.holdout.challenger.logLoss)}</td><td className="num">{n3(c.holdout.dixonColes.logLoss)}</td></tr>
                <tr><td>Held-out Brier (three outcomes)</td><td className="num">{n3(c.holdout.challenger.brier)}</td><td className="num">{n3(c.holdout.dixonColes.brier)}</td></tr>
                {c.live && <tr><td>Live, {c.live.matches} finished matches: log loss</td><td className="num">{n3(c.live.challenger.logLoss)}</td><td className="num">{n3(c.live.dixonColes.logLoss)}</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
