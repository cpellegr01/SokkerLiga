import * as api from '../api.js';
import { localDayRange } from '../format.js';
import { href } from '../router.js';
import { useApi, Page, Loading, ErrorBanner, Empty, MatchesByCompetition, MatchRow } from '../components/ui.jsx';

export default function Dashboard() {
  const today = localDayRange(0);
  const { data, error, loading } = useApi(() => api.getDashboard({ dayStart: today.from, dayEnd: today.to }), []);

  if (loading && !data) return <Page title="Dashboard"><Loading /></Page>;
  if (error) return <Page title="Dashboard"><ErrorBanner error={error} /></Page>;

  const empty = !data.counts.matches;
  return (
    <Page title="Dashboard" subtitle="Today's matches, the week ahead and the latest results.">
      {empty && (
        <Empty>
          <p><strong>No football data yet.</strong></p>
          <p>The worker fills the database from API-Football once the key is configured. Progress is in{' '}
            <a href={href('settings')}>Settings → Data sync</a>.</p>
        </Empty>
      )}

      <div className="kpis">
        <div className="kpi"><span className="kpi-value">{data.today.length}</span><span className="kpi-label">Matches today</span></div>
        <div className="kpi"><span className="kpi-value">{data.upcoming.length}</span><span className="kpi-label">In the next 7 days</span></div>
        <div className="kpi"><span className="kpi-value">{data.counts.matches.toLocaleString()}</span><span className="kpi-label">Matches in the database</span></div>
        <div className="kpi"><span className="kpi-value">{data.counts.players.toLocaleString()}</span><span className="kpi-label">Players</span></div>
      </div>

      <div className="columns">
        <div>
          <h2>Today</h2>
          {data.today.length ? <MatchesByCompetition matches={data.today} /> : <p className="subtle">No matches today.</p>}
          <h2>Next 7 days</h2>
          {data.upcoming.length
            ? <MatchesByCompetition matches={data.upcoming} showDay />
            : <p className="subtle">Nothing scheduled in the coming week.</p>}
        </div>
        <aside>
          <h2>Recent results</h2>
          <div className="card">
            {data.recentResults.length
              ? data.recentResults.map((m) => <MatchRow key={m.id} match={m} showDay showCompetition />)
              : <p className="subtle pad">No results in the last three days.</p>}
          </div>
          <div className="card pad soon">
            <h3>Recommendations</h3>
            <p className="subtle">Match analysis, predictions and recommendations arrive in Phase 2.</p>
          </div>
        </aside>
      </div>
    </Page>
  );
}
