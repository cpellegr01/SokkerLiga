import * as api from '../api.js';
import { href } from '../router.js';
import { shortDate } from '../format.js';
import {
  useApi, Page, Loading, ErrorBanner, Crest, FormStrip, Record, MatchRow, FavouriteStar, CompareBar,
} from '../components/ui.jsx';

const POSITIONS = ['Goalkeeper', 'Defender', 'Midfielder', 'Attacker'];

export default function Team({ id, me, onFavourite }) {
  const { data, error, loading } = useApi(() => api.getTeam(id), [id]);
  if (loading && !data) return <Page><Loading /></Page>;
  if (error) return <Page><ErrorBanner error={error} /></Page>;
  const { team, manager, competitions, roster, recent, upcoming, form } = data;
  const isFav = me.favourites.some((f) => f.type === 'team' && f.id === team.id);

  return (
    <Page>
      <div className="profile-header card">
        <Crest src={team.logo} name={team.name} size={72} />
        <div className="profile-title">
          <h1>{team.name}</h1>
          <p className="subtle">
            {[team.country, team.founded && `Founded ${team.founded}`, team.venue && `${team.venue.name}${team.venue.capacity ? ` (${team.venue.capacity.toLocaleString()})` : ''}`,
              manager && `Manager ${manager.name}`].filter(Boolean).join(' · ')}
          </p>
          <p>Form <FormStrip form={form.form} /></p>
        </div>
        <FavouriteStar on={isFav} label={team.name} onToggle={() => onFavourite('team', team.id, !isFav)} />
      </div>

      {competitions.map((c) => (
        <div key={c.season.id} className="card pad">
          <h3>
            <a href={href('league', c.competition.id)}><Crest src={c.competition.logo} name={c.competition.name} size={18} /> {c.competition.name}</a>
            <span className="subtle"> · {c.season.label}</span>
          </h3>
          <div className="kpis compact">
            <div className="kpi"><span className="kpi-value">{c.standing ? c.standing.position : '—'}</span><span className="kpi-label">Position</span></div>
            <div className="kpi"><span className="kpi-value">{c.standing ? c.standing.points : '—'}</span><span className="kpi-label">Points</span></div>
            <div className="kpi"><span className="kpi-value">{c.record.played ? (c.record.goalsFor / c.record.played).toFixed(2) : '—'}</span><span className="kpi-label">Goals for per match</span></div>
            <div className="kpi"><span className="kpi-value">{c.record.played ? (c.record.goalsAgainst / c.record.played).toFixed(2) : '—'}</span><span className="kpi-label">Goals against per match</span></div>
          </div>
          <table className="kv">
            <tbody>
              <tr><td>Overall</td><td><Record r={c.record} /></td></tr>
              <tr><td>Home</td><td><Record r={c.home} /></td></tr>
              <tr><td>Away</td><td><Record r={c.away} /></td></tr>
              <tr><td>Clean sheets</td><td>{c.record.cleanSheets}</td></tr>
            </tbody>
          </table>
          {c.averages.length > 0 && (
            <>
              <h4>Per match: {team.name} / opponents</h4>
              {c.averages.filter((a) => ['xg', 'shots', 'shots_on_target', 'possession', 'corners', 'yellow_cards'].includes(a.key))
                .map((a) => <CompareBar key={a.key} label={a.name} home={a.for} away={a.against} unit={a.unit}
                  digits={a.unit === 'decimal' ? 2 : 1} />)}
            </>
          )}
        </div>
      ))}

      <div className="grid-2">
        <div className="card">
          <h3 className="pad-x">Upcoming</h3>
          {upcoming.length ? upcoming.map((m) => <MatchRow key={m.id} match={m} showDay showCompetition />)
            : <p className="subtle pad">No upcoming matches.</p>}
        </div>
        <div className="card">
          <h3 className="pad-x">Recent</h3>
          {recent.length ? recent.map((m) => <MatchRow key={m.id} match={m} showDay showCompetition />)
            : <p className="subtle pad">No results yet.</p>}
        </div>
      </div>

      <div className="card">
        <h3 className="pad-x">Squad</h3>
        {roster.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th className="num">#</th><th>Player</th><th className="hide-sm">Position</th>
                <th className="hide-sm">Nationality</th><th className="num">Apps</th><th className="num">G</th><th className="num">A</th></tr></thead>
              <tbody>
                {roster.map((p) => (
                  <tr key={p.id}>
                    <td className="num">{p.number ?? ''}</td>
                    <td><a className="team-cell" href={href('player', p.id)}><Crest src={p.photo} name={p.name} size={22} round /> {p.name}</a></td>
                    <td className="hide-sm">{POSITIONS.includes(p.position) ? p.position : (p.position ?? '—')}</td>
                    <td className="hide-sm">{p.nationality ?? '—'}</td>
                    <td className="num">{p.appearances}</td><td className="num">{p.goals ?? 0}</td><td className="num">{p.assists ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="subtle pad">The squad has not been imported yet.</p>}
      </div>

      <p className="subtle small">Source: API-Football · updated {shortDate(team.fetchedAt)}</p>
    </Page>
  );
}
