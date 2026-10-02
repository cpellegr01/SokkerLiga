import * as api from '../api.js';
import { href } from '../router.js';
import { kickoff, shortDate } from '../format.js';
import { useApi, Page, Loading, ErrorBanner, Crest } from '../components/ui.jsx';

export default function Player({ id }) {
  const { data, error, loading } = useApi(() => api.getPlayer(id), [id]);
  if (loading && !data) return <Page><Loading /></Page>;
  if (error) return <Page><ErrorBanner error={error} /></Page>;
  const { player, teams, seasons, history, availability } = data;
  const current = seasons[0];

  return (
    <Page>
      <div className="profile-header card">
        <Crest src={player.photo} name={player.name} size={88} round />
        <div className="profile-title">
          <h1>{player.name}</h1>
          <p className="subtle">
            {[player.position, player.age !== null && `Age ${player.age}`, player.nationality,
              player.heightCm && `${player.heightCm} cm`].filter(Boolean).join(' · ')}
          </p>
          <p>
            {teams.map((t) => (
              <a key={t.id} className="team-cell" href={href('team', t.id)}>
                <Crest src={t.logo} name={t.name} size={18} /> {t.name}{t.number ? ` · #${t.number}` : ''}
              </a>
            ))}
          </p>
        </div>
      </div>

      {availability.length > 0 && (
        <div className="banner warn">
          {availability.map((a) => (
            <div key={a.matchId}>
              {a.status === 'doubtful' ? 'Doubtful' : 'Out'} for{' '}
              <a href={href('match', a.matchId)}>{a.home} v {a.away}</a> ({kickoff(a.kickoffUtc)}){a.reason ? ` — ${a.reason}` : ''}
            </div>
          ))}
        </div>
      )}

      {current && (
        <div className="kpis">
          <div className="kpi"><span className="kpi-value">{current.appearances}</span><span className="kpi-label">Appearances</span></div>
          <div className="kpi"><span className="kpi-value">{current.minutes}</span><span className="kpi-label">Minutes</span></div>
          <div className="kpi"><span className="kpi-value">{current.goals}</span><span className="kpi-label">Goals</span></div>
          <div className="kpi"><span className="kpi-value">{current.assists}</span><span className="kpi-label">Assists</span></div>
          <div className="kpi"><span className="kpi-value">{current.shots}</span><span className="kpi-label">Shots</span></div>
          <div className="kpi"><span className="kpi-value">{current.shotsOnTarget}</span><span className="kpi-label">On target</span></div>
          <div className="kpi"><span className="kpi-value">{current.yellow}/{current.red}</span><span className="kpi-label">Cards (Y/R)</span></div>
        </div>
      )}

      <div className="card">
        <h3 className="pad-x">By season</h3>
        {seasons.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Season</th><th>Competition</th><th className="hide-sm">Team</th><th className="num">Apps</th>
                <th className="num">Min</th><th className="num">G</th><th className="num">A</th><th className="num hide-sm">Shots</th>
                <th className="num hide-sm">On tgt</th><th className="num hide-sm">Y/R</th><th className="num">Rating</th></tr></thead>
              <tbody>
                {seasons.map((s) => (
                  <tr key={`${s.seasonId}-${s.team}`}>
                    <td>{s.season}</td><td>{s.competition.name}</td><td className="hide-sm">{s.team}</td>
                    <td className="num">{s.appearances}</td><td className="num">{s.minutes}</td><td className="num">{s.goals}</td>
                    <td className="num">{s.assists}</td><td className="num hide-sm">{s.shots}</td>
                    <td className="num hide-sm">{s.shotsOnTarget}</td><td className="num hide-sm">{s.yellow}/{s.red}</td>
                    <td className="num">{s.rating ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="subtle pad">No match statistics yet.</p>}
      </div>

      <div className="card">
        <h3 className="pad-x">Recent matches</h3>
        {history.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Date</th><th>Match</th><th className="num">Min</th><th className="num">G</th>
                <th className="num">A</th><th className="num hide-sm">Shots</th><th className="num">Rating</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.matchId}>
                    <td>{shortDate(h.kickoffUtc)}</td>
                    <td><a href={href('match', h.matchId)}>{h.home} {h.score ?? 'v'} {h.away}</a></td>
                    <td className="num">{h.minutes ?? '—'}</td><td className="num">{h.goals ?? 0}</td>
                    <td className="num">{h.assists ?? 0}</td><td className="num hide-sm">{h.shots ?? 0}</td>
                    <td className="num">{h.rating ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="subtle pad">No matches yet.</p>}
      </div>
      <p className="subtle small">Source: API-Football · profile {player.profiledAt ? `updated ${shortDate(player.profiledAt)}` : 'not fetched yet'}</p>
    </Page>
  );
}
