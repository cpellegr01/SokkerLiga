import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { kickoff } from '../format.js';
import { CONFIDENCE_LABEL, STANCE_LABEL } from '../markets.js';
import { useApi, Page, Loading, ErrorBanner, Empty, Crest } from '../components/ui.jsx';

export default function Predictions() {
  const [decision, setDecision] = useState('recommend');
  const [market, setMarket] = useState('');
  const [competition, setCompetition] = useState('');
  const [when, setWhen] = useState('upcoming');
  const markets = useApi(() => api.listMarketTypes(), []);
  const comps = useApi(() => api.listCompetitions(), []);
  const now = new Date().toISOString();
  const range = when === 'upcoming' ? { from: now } : when === 'past' ? { to: now } : {};
  const { data, error, loading } = useApi(() => api.listPredictions({ decision, market, competition, ...range }),
    [decision, market, competition, when]);

  return (
    <Page title="Predictions" subtitle="Every saved prediction, from the latest analysis of each match. Earlier analyses are kept but hidden.">
      <div className="filters">
        <select value={when} onChange={(e) => setWhen(e.target.value)} aria-label="When">
          <option value="upcoming">Upcoming matches</option>
          <option value="past">Played matches</option>
          <option value="">All</option>
        </select>
        <select value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Decision">
          <option value="recommend">Recommended</option>
          <option value="pass">Passed</option>
          <option value="">Recommended and passed</option>
        </select>
        <select value={market} onChange={(e) => setMarket(e.target.value)} aria-label="Market">
          <option value="">All markets</option>
          {(markets.data ?? []).map((m) => <option key={m.key} value={m.key}>{m.name}</option>)}
        </select>
        <select value={competition} onChange={(e) => setCompetition(e.target.value)} aria-label="Competition">
          <option value="">All competitions</option>
          {(comps.data ?? []).filter((c) => c.isEnabled).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data?.length ? (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Kickoff</th><th>Match</th><th>Selection</th><th className="num">Probability</th>
                <th className="num">Fair odds</th><th className="hide-sm">Confidence</th><th>Decision</th>
                <th className="hide-sm">Claude</th><th className="hide-sm">Result</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td>{kickoff(p.kickoffUtc)}</td>
                    <td>
                      <a className="team-cell" href={href('match', p.matchId, { tab: 'analysis' })}>
                        <Crest src={p.homeLogo} name={p.home} size={16} /> {p.home} v {p.away}
                      </a>
                    </td>
                    <td>{p.label}</td>
                    <td className="num">{(p.probability * 100).toFixed(1)}%</td>
                    <td className="num">{p.fairOdds.toFixed(2)}</td>
                    <td className="hide-sm">{CONFIDENCE_LABEL[p.confidence]}</td>
                    <td title={p.passReasons.join('\n')}>{p.decision === 'recommend' ? <span className="pill finished">Recommend</span> : <span className="subtle">Pass</span>}</td>
                    <td className="hide-sm">{p.aiStance ? STANCE_LABEL[p.aiStance] : ''}</td>
                    <td className="hide-sm">{p.homeGoals !== null && p.status === 'finished' ? `${p.homeGoals}–${p.awayGoals}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <Empty>No predictions match. Open a match and use <strong>Analyse match</strong> on its Analysis tab.</Empty>}
      <p className="subtle">Whether each prediction came in is graded from the result in Phase 3.</p>
    </Page>
  );
}
