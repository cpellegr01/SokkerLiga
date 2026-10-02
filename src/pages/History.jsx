import { useState } from 'react';
import * as api from '../api.js';
import { formatMoney } from '../odds.js';
import { MARKET_OPTIONS } from '../markets.js';
import DatePicker from '../components/DatePicker.jsx';
import { useApi, Page, Loading, ErrorBanner, Empty, Profit } from '../components/ui.jsx';

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);

export default function History() {
  const [f, setF] = useState({ from: '', to: '', sportsbook: '', competition: '', market: '', followed: '', kind: '', currency: '' });
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  const books = useApi(() => api.listSportsbooks(), []);
  const comps = useApi(() => api.listCompetitions(), []);
  const params = { ...f, from: f.from ? new Date(f.from).toISOString() : '', to: f.to ? new Date(`${f.to}T23:59:59`).toISOString() : '' };
  const { data, error, loading } = useApi(() => api.getHistory(params), [JSON.stringify(f)]);

  const money = (m) => formatMoney(m, data?.currency);
  return (
    <Page title="Betting History" subtitle="How your recorded bets have done. Luck and judgement are shown apart: a bet with an edge can lose, and one without can win.">
      <div className="filters">
        <span className="check">From <DatePicker label="From" value={f.from} placeholder="Any date" onChange={(v) => set({ from: v })} /></span>
        <span className="check">To <DatePicker label="To" value={f.to} placeholder="Any date" onChange={(v) => set({ to: v })} /></span>
        <select value={f.sportsbook} onChange={(e) => set({ sportsbook: e.target.value })} aria-label="Betting app">
          <option value="">All betting apps</option>
          {(books.data ?? []).map((b) => <option key={b.key} value={b.key}>{b.name}</option>)}
        </select>
        <select value={f.competition} onChange={(e) => set({ competition: e.target.value })} aria-label="Competition">
          <option value="">All competitions</option>
          {(comps.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={f.market} onChange={(e) => set({ market: e.target.value })} aria-label="Market">
          <option value="">All markets</option>
          {MARKET_OPTIONS.map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
        <select value={f.kind} onChange={(e) => set({ kind: e.target.value })} aria-label="Bet type">
          <option value="">Singles and parlays</option><option value="single">Singles</option><option value="parlay">Parlays</option>
        </select>
        <select value={f.followed} onChange={(e) => set({ followed: e.target.value })} aria-label="Recommendation">
          <option value="">With or without a recommendation</option>
          <option value="yes">Followed a recommendation</option><option value="no">Did not follow one</option>
        </select>
        {data?.currencies?.length > 1 && (
          <select value={data.currency} onChange={(e) => set({ currency: e.target.value })} aria-label="Currency">
            {data.currencies.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : !data?.totals.bets ? <Empty>No bets match these filters yet.</Empty> : (
        <>
          <Totals t={data.totals} money={money} currency={data.currency} />
          <div className="card pad">
            <h3>Profit over time</h3>
            <ProfitChart points={data.overTime} money={money} />
          </div>
          <div className="breakdowns">
            <Breakdown title="By edge when placed" note="Judgement, not luck: did the model see value at your price?" rows={data.byEdge} money={money} currency={data.currency} />
            <Breakdown title="Following recommendations" rows={data.byFollowed} money={money} currency={data.currency} />
            <Breakdown title="By competition" note="Singles only" rows={data.byCompetition} money={money} currency={data.currency} />
            <Breakdown title="By market" rows={data.byMarket} money={money} currency={data.currency} />
            <Breakdown title="By team" note="Singles only; a bet counts for both teams" rows={data.byTeam} money={money} currency={data.currency} />
            <Breakdown title="By betting app" rows={data.bySportsbook} money={money} currency={data.currency} />
            <Breakdown title="By confidence" note="Singles only" rows={data.byConfidence} money={money} currency={data.currency} />
            <Breakdown title="By odds" rows={data.byOdds} money={money} currency={data.currency} />
            <Breakdown title="By month" rows={data.byMonth} money={money} currency={data.currency} />
          </div>
        </>
      )}
    </Page>
  );
}

function Totals({ t, money, currency }) {
  return (
    <div className="kpis">
      <Kpi label="Bets" value={`${t.bets}${t.open ? ` (${t.open} open)` : ''}`} />
      <Kpi label="Wins / losses / pushes" value={`${t.won} / ${t.lost} / ${t.pushed}`} />
      <Kpi label="Win rate" value={pct(t.winRate)} />
      <Kpi label="Staked" value={money(t.stakedMinor)} />
      <Kpi label="Returned" value={money(t.returnedMinor)} />
      <Kpi label="Net profit" value={<Profit minor={t.profitMinor} currency={currency} format={formatMoney} />} />
      <Kpi label="ROI" value={pct(t.roi)} />
      <Kpi label="Average odds" value={t.averageOdds ? t.averageOdds.toFixed(2) : '—'} />
      <Kpi label="Average edge" value={t.averageEdge === null ? '—' : `${(t.averageEdge * 100).toFixed(1)} pts`} />
    </div>
  );
}

const Kpi = ({ label, value }) => (
  <div className="kpi"><span className="kpi-value">{value}</span><span className="kpi-label">{label}</span></div>
);

function Breakdown({ title, note, rows, money, currency }) {
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h3 className="pad-x">{title}</h3>
      {note && <p className="subtle pad-x">{note}</p>}
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{' '}</th><th className="num">Bets</th><th className="num">Wins</th><th className="num">Losses</th>
            <th className="num hide-sm">Pushes</th><th className="num hide-sm">Staked</th><th className="num">Profit</th><th className="num">ROI</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.key}</td><td className="num">{r.bets}</td><td className="num">{r.won}</td><td className="num">{r.lost}</td>
                <td className="num hide-sm">{r.pushed}</td><td className="num hide-sm">{money(r.stakedMinor)}</td>
                <td className="num"><Profit minor={r.profitMinor} currency={currency} format={formatMoney} /></td>
                <td className="num">{pct(r.roi)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* Running profit after each settled bet, as a plain SVG line. */
function ProfitChart({ points, money }) {
  if (points.length < 2) return <p className="subtle">The chart appears after two settled bets.</p>;
  const W = 600; const H = 180; const P = 28;
  const ys = points.map((p) => p.profitMinor);
  const lo = Math.min(0, ...ys); const hi = Math.max(0, ...ys);
  const x = (i) => P + (i / (points.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.profitMinor).toFixed(1)}`).join(' ');
  /* Labels sit outside the SVG so they stay 12px at any width. */
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
        aria-label={`Profit over time, ending at ${money(ys[ys.length - 1])}`}>
        <line className="zero" x1={P} x2={W - P} y1={y(0)} y2={y(0)} vectorEffect="non-scaling-stroke" />
        <path className="line" d={d} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="chart-labels subtle">
        <span>{points[0].at.slice(0, 10)}</span>
        <span>High {money(hi)} · now {money(ys[ys.length - 1])} · low {money(lo)}</span>
        <span>{points[points.length - 1].at.slice(0, 10)}</span>
      </div>
    </>
  );
}
