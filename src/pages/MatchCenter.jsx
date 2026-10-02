import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { longDate, kickoff, shortDate, ago, num, STATUS_LABEL } from '../format.js';
import {
  useApi, Page, Loading, ErrorBanner, Crest, FormStrip, Tabs, CompareBar, StandingsTable, Record, MatchRow, StatusPill,
} from '../components/ui.jsx';

/* Statistics worth comparing side by side, in this order. */
const AVERAGE_KEYS = ['xg', 'shots', 'shots_on_target', 'possession', 'corners', 'fouls', 'yellow_cards', 'saves'];

export default function MatchCenter({ id, params }) {
  const { data, error, loading } = useApi(() => api.getMatch(id), [id]);
  const [tab, setTab] = useState(params.tab ?? 'overview');

  if (loading && !data) return <Page><Loading /></Page>;
  if (error) return <Page><ErrorBanner error={error} /></Page>;

  const { match } = data;
  const played = match.status !== 'scheduled' && match.score;
  const tabs = [
    { key: 'overview', label: 'Overview' },
    ...(played ? [{ key: 'match', label: 'Match' }] : []),
    { key: 'h2h', label: 'Head-to-head' },
    { key: 'lineups', label: 'Lineups & availability' },
    { key: 'players', label: 'Players' },
    { key: 'analysis', label: 'Analysis' },
  ];

  return (
    <Page>
      <MatchHeader data={data} />
      <Tabs tabs={tabs} active={tab} onChange={setTab} />
      {tab === 'overview' && <Overview data={data} />}
      {tab === 'match' && <MatchFacts data={data} />}
      {tab === 'h2h' && <HeadToHead data={data} />}
      {tab === 'lineups' && <Lineups data={data} />}
      {tab === 'players' && <Players data={data} />}
      {tab === 'analysis' && (
        <div className="card pad soon">
          <h3>Analysis</h3>
          <p className="subtle">
            Analyze Match — the statistical model's probabilities, fair odds, factors for and against, and
            Recommend / Pass — arrives in Phase 2.
          </p>
        </div>
      )}
    </Page>
  );
}

function MatchHeader({ data }) {
  const { match, positions } = data;
  const played = match.status !== 'scheduled' && match.score;
  const position = (p) => (p ? `${ordinal(p.position)}${p.group ? ` · ${p.group}` : ''} · ${p.points} pts` : null);
  return (
    <div className="match-header card">
      <a className="match-header-comp" href={href('league', match.competition.id)}>
        <Crest src={match.competition.logo} name={match.competition.name} size={18} />
        {match.competition.name} · {match.season.label}{match.round ? ` · ${match.round}` : ''}
      </a>
      <div className="match-header-teams">
        <a className="side" href={href('team', match.home.id)}>
          <Crest src={match.home.logo} name={match.home.name} size={64} />
          <span className="side-name">{match.home.name}</span>
          <span className="subtle">{position(positions.home)}</span>
        </a>
        <div className="centre">
          {played ? (
            <>
              <span className="big-score">{match.score.home} – {match.score.away}</span>
              {match.score.homeHt !== null && <span className="subtle">HT {match.score.homeHt}–{match.score.awayHt}</span>}
              {match.score.homePens !== null && <span className="subtle">Pens {match.score.homePens}–{match.score.awayPens}</span>}
              <StatusPill match={match} />
            </>
          ) : (
            <>
              <span className="big-time">{kickoff(match.kickoffUtc)}</span>
              {match.status !== 'scheduled' && <span className="pill">{STATUS_LABEL[match.status]}</span>}
            </>
          )}
        </div>
        <a className="side" href={href('team', match.away.id)}>
          <Crest src={match.away.logo} name={match.away.name} size={64} />
          <span className="side-name">{match.away.name}</span>
          <span className="subtle">{position(positions.away)}</span>
        </a>
      </div>
      <p className="match-header-meta subtle">
        {longDate(match.kickoffUtc)}
        {match.venue && ` · ${match.venue}${match.venueCity ? `, ${match.venueCity}` : ''}`}
        {match.referee && ` · Referee ${match.referee}`}
      </p>
    </div>
  );
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/* ---------------------------------------------------------- Overview */

function Overview({ data }) {
  const { match, home, away } = data;
  const avg = (side, key) => side.averages.find((a) => a.key === key);
  return (
    <div className="grid-2">
      <div className="card pad">
        <h3>Form</h3>
        <table className="kv">
          <thead><tr><th /><th>{match.home.name}</th><th>{match.away.name}</th></tr></thead>
          <tbody>
            <tr><td>Last 5</td><td><FormStrip form={home.form.form} /></td><td><FormStrip form={away.form.form} /></td></tr>
            <tr><td>Points, last 5</td><td>{home.form.points}</td><td>{away.form.points}</td></tr>
            <tr><td>Last 10</td><td><Record r={home.last10} /></td><td><Record r={away.last10} /></td></tr>
            <tr><td>{match.home.name} at home / {match.away.name} away, last 10</td>
              <td><Record r={home.venueForm} /></td><td><Record r={away.venueForm} /></td></tr>
            <tr><td>Season, home</td><td><Record r={home.seasonHome} /></td><td><Record r={away.seasonHome} /></td></tr>
            <tr><td>Season, away</td><td><Record r={home.seasonAway} /></td><td><Record r={away.seasonAway} /></td></tr>
            <tr><td>Clean sheets (season)</td><td>{home.season.cleanSheets}</td><td>{away.season.cleanSheets}</td></tr>
            <tr><td>Failed to score (season)</td><td>{home.season.failedToScore}</td><td>{away.season.failedToScore}</td></tr>
            <tr><td>Days since last match</td><td>{home.restDays ?? '—'}</td><td>{away.restDays ?? '—'}</td></tr>
            <tr><td>Matches in the last 14 days</td><td>{home.matchesLast14Days}</td><td>{away.matchesLast14Days}</td></tr>
          </tbody>
        </table>
      </div>

      <div className="card pad">
        <h3>Season averages per match</h3>
        <p className="subtle small">Each team's own average this season, before this match.</p>
        <CompareBar label="Goals scored" home={perMatch(home.season.goalsFor, home.season.played)}
          away={perMatch(away.season.goalsFor, away.season.played)} digits={2} />
        <CompareBar label="Goals conceded" home={perMatch(home.season.goalsAgainst, home.season.played)}
          away={perMatch(away.season.goalsAgainst, away.season.played)} digits={2} />
        {AVERAGE_KEYS.map((key) => {
          const h = avg(home, key);
          const a = avg(away, key);
          if (!h && !a) return null;
          return <CompareBar key={key} label={(h ?? a).name} home={h?.for} away={a?.for}
            unit={(h ?? a).unit} digits={(h ?? a).unit === 'decimal' ? 2 : 1} />;
        })}
        {!home.averages.length && !away.averages.length && (
          <p className="subtle">No match statistics yet this season.</p>
        )}
      </div>

      <div className="card">
        <h3 className="pad-x">{match.home.name}: recent matches</h3>
        {home.recent.length ? home.recent.slice(0, 6).map((m) => <MatchRow key={m.id} match={m} showDay />)
          : <p className="subtle pad">No earlier matches in the database.</p>}
      </div>
      <div className="card">
        <h3 className="pad-x">{match.away.name}: recent matches</h3>
        {away.recent.length ? away.recent.slice(0, 6).map((m) => <MatchRow key={m.id} match={m} showDay />)
          : <p className="subtle pad">No earlier matches in the database.</p>}
      </div>

      {data.positions.asOf && <TableSnippet data={data} />}
    </div>
  );
}

const perMatch = (total, played) => (played ? total / played : null);

function TableSnippet({ data }) {
  /* Only the group the teams are in, around their positions. */
  const comp = useApi(() => api.getCompetition(data.match.competition.id, data.match.season.id), [data.match.id]);
  if (!comp.data) return null;
  const ids = [data.match.home.id, data.match.away.id];
  const group = comp.data.table.groups.find((g) => g.rows.some((r) => ids.includes(r.teamId)));
  if (!group) return null;
  return (
    <div className="card span-2">
      <h3 className="pad-x">Table <span className="subtle small">as of {shortDate(data.positions.asOf)}</span></h3>
      <StandingsTable group={group} highlight={ids} />
    </div>
  );
}

/* ------------------------------------------------------- Match facts */

const EVENT_ICON = { goal: '⚽', penalty_goal: '⚽ (pen)', own_goal: '⚽ (og)', missed_penalty: '✕ pen',
  yellow: '🟨', red: '🟥', second_yellow: '🟨🟥', sub: '⇄', var: 'VAR', other: '•' };

function MatchFacts({ data }) {
  const { match, events, stats } = data;
  return (
    <div className="grid-2">
      <div className="card pad">
        <h3>Events</h3>
        {events.length ? (
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.seq} className={e.teamId === match.home.id ? 'ev home' : 'ev away'}>
                <span className="ev-min">{e.minute}{e.extraMinute ? `+${e.extraMinute}` : ''}′</span>
                <span className="ev-icon">{EVENT_ICON[e.type] ?? '•'}</span>
                <span className="ev-text">
                  {e.playerId ? <a href={href('player', e.playerId)}>{e.playerName}</a> : e.playerName}
                  {e.assistName && <span className="subtle"> {e.type === 'sub' ? '/' : '· assist'} {e.assistName}</span>}
                  {e.type === 'var' && e.detail && <span className="subtle"> · {e.detail}</span>}
                </span>
              </li>
            ))}
          </ol>
        ) : <p className="subtle">No events recorded.</p>}
      </div>
      <div className="card pad">
        <h3>Statistics</h3>
        {stats.length ? stats.map((s) => (
          <CompareBar key={s.key} label={s.name} home={s.home} away={s.away} unit={s.unit}
            digits={s.unit === 'decimal' ? 2 : 0} />
        )) : <p className="subtle">No statistics recorded.</p>}
        {data.revisions.length > 0 && (
          <p className="subtle small">Corrected by the provider {data.revisions.length} time{data.revisions.length > 1 ? 's' : ''};
            earlier values are kept.</p>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------ Head-to-head */

function HeadToHead({ data }) {
  const { match, headToHead } = data;
  const s = headToHead.summary;
  if (!s.played) return <p className="subtle">No earlier meetings in the database.</p>;
  return (
    <div className="grid-2">
      <div className="card pad">
        <h3>Last {s.played} meetings</h3>
        <div className="kpis compact">
          <div className="kpi"><span className="kpi-value">{s.homeTeamWins}</span><span className="kpi-label">{match.home.name} wins</span></div>
          <div className="kpi"><span className="kpi-value">{s.draws}</span><span className="kpi-label">Draws</span></div>
          <div className="kpi"><span className="kpi-value">{s.awayTeamWins}</span><span className="kpi-label">{match.away.name} wins</span></div>
        </div>
        <table className="kv">
          <tbody>
            <tr><td>Goals per match</td><td>{num(s.goals / s.played, 2)}</td></tr>
            <tr><td>Both teams scored</td><td>{s.bothScored} of {s.played}</td></tr>
            <tr><td>Over 2.5 goals</td><td>{s.over25} of {s.played}</td></tr>
          </tbody>
        </table>
      </div>
      <div className="card">
        {headToHead.matches.map((m) => <MatchRow key={m.id} match={m} showDay showCompetition />)}
      </div>
    </div>
  );
}

/* ------------------------------------------- Lineups and availability */

function Lineups({ data }) {
  const { match, lineups, availability } = data;
  const sides = [match.home, match.away];
  return (
    <div className="grid-2">
      {sides.map((team) => {
        const l = lineups.find((x) => x.teamId === team.id);
        const out = availability.filter((a) => a.teamId === team.id);
        return (
          <div key={team.id} className="card pad">
            <h3><Crest src={team.logo} name={team.name} size={20} /> {team.name}</h3>
            {l ? (
              <>
                <p className="subtle small">
                  {l.status === 'confirmed' ? 'Confirmed lineup' : 'Probable lineup'}
                  {l.formation ? ` · ${l.formation}` : ''}{l.manager ? ` · Manager ${l.manager.name}` : ''}
                  {` · updated ${ago(l.fetchedAt)}`}
                </p>
                <h4>Starting XI</h4>
                <PlayerList players={l.players.filter((p) => p.role === 'starter')} />
                <h4>Substitutes</h4>
                <PlayerList players={l.players.filter((p) => p.role === 'sub')} />
              </>
            ) : <p className="subtle">Lineups are published about an hour before kickoff.</p>}
            <h4>Unavailable</h4>
            {out.length ? (
              <ul className="plain">
                {out.map((p) => (
                  <li key={p.id}>
                    <a href={href('player', p.id)}>{p.name}</a>
                    <span className={`pill ${p.status}`}>{p.status === 'doubtful' ? 'Doubtful' : 'Out'}</span>
                    {p.reason && <span className="subtle"> {p.reason}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="subtle">No reported injuries or suspensions.</p>}
          </div>
        );
      })}
    </div>
  );
}

function PlayerList({ players }) {
  if (!players.length) return <p className="subtle">—</p>;
  return (
    <ul className="plain lineup">
      {players.map((p) => (
        <li key={p.id}>
          <span className="shirt">{p.number ?? ''}</span>
          <a href={href('player', p.id)}>{p.name}</a>
          <span className="subtle">{p.position}</span>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------- Players */

function Players({ data }) {
  const { match, home, away, playerStats } = data;
  const played = playerStats.length > 0;
  return (
    <div className="grid-2">
      {[[match.home, home], [match.away, away]].map(([team, side]) => (
        <div key={team.id} className="card">
          <h3 className="pad-x">{team.name}: key players this season</h3>
          {side.keyPlayers.length ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Player</th><th className="num">Apps</th><th className="num">Min</th>
                  <th className="num">G</th><th className="num">A</th><th className="num hide-sm">Shots</th>
                  <th className="num hide-sm">On tgt</th><th className="num">Rating</th></tr></thead>
                <tbody>
                  {side.keyPlayers.map((p) => (
                    <tr key={p.id}>
                      <td><a className="team-cell" href={href('player', p.id)}><Crest src={p.photo} name={p.name} size={20} round /> {p.name}</a></td>
                      <td className="num">{p.appearances}</td><td className="num">{p.minutes}</td>
                      <td className="num">{p.goals}</td><td className="num">{p.assists}</td>
                      <td className="num hide-sm">{p.shots}</td><td className="num hide-sm">{p.shotsOnTarget}</td>
                      <td className="num">{p.rating ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="subtle pad">No player statistics yet this season.</p>}
          {played && (
            <>
              <h3 className="pad-x">In this match</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Player</th><th className="num">Min</th><th className="num">G</th><th className="num">A</th>
                    <th className="num">Shots</th><th className="num">Rating</th></tr></thead>
                  <tbody>
                    {playerStats.filter((p) => p.team_id === team.id).map((p) => (
                      <tr key={p.player_id}>
                        <td><a href={href('player', p.player_id)}>{p.name}</a></td>
                        <td className="num">{p.minutes ?? '—'}</td><td className="num">{p.goals ?? 0}</td>
                        <td className="num">{p.assists ?? 0}</td><td className="num">{p.shots ?? 0}</td>
                        <td className="num">{p.rating ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
