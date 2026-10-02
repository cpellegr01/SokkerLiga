import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { useApi, Page, Loading, ErrorBanner, Crest, Empty } from '../components/ui.jsx';

export function Teams() {
  const [q, setQ] = useState('');
  const [competition, setCompetition] = useState('');
  const comps = useApi(() => api.listCompetitions(), []);
  const { data, error, loading } = useApi(() => api.listTeams({ q, competition }), [q, competition]);
  return (
    <Page title="Teams">
      <div className="filters">
        <input type="search" placeholder="Filter teams" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={competition} onChange={(e) => setCompetition(e.target.value)} aria-label="Competition">
          <option value="">All competitions</option>
          {(comps.data ?? []).filter((c) => c.isEnabled).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data?.length ? (
        <div className="tile-grid">
          {data.map((t) => (
            <a key={t.id} className="tile card" href={href('team', t.id)}>
              <Crest src={t.logo} name={t.name} size={40} />
              <span className="tile-name">{t.name}</span>
              <span className="subtle small">{t.competitions}</span>
            </a>
          ))}
        </div>
      ) : <Empty>No teams yet — they arrive with the first data sync.</Empty>}
    </Page>
  );
}

export function Players() {
  const [q, setQ] = useState('');
  const { data, error, loading } = useApi(() => api.listPlayers({ q }), [q]);
  return (
    <Page title="Players" subtitle="Current squad members; type a name to search everyone.">
      <div className="filters">
        <input type="search" placeholder="Search players" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data?.length ? (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Player</th><th className="hide-sm">Position</th><th className="hide-sm">Nationality</th><th>Team</th></tr></thead>
              <tbody>
                {data.map((p) => (
                  <tr key={p.id}>
                    <td><a className="team-cell" href={href('player', p.id)}><Crest src={p.photo} name={p.name} size={22} round /> {p.name}</a></td>
                    <td className="hide-sm">{p.position ?? '—'}</td>
                    <td className="hide-sm">{p.nationality ?? '—'}</td>
                    <td>{p.team ? <a className="team-cell" href={href('team', p.team.id)}><Crest src={p.team.logo} name={p.team.name} size={18} /> {p.team.name}</a> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : <Empty>{q ? 'No players match.' : 'No players yet — squads arrive with the first data sync.'}</Empty>}
    </Page>
  );
}

export function Leagues({ me, onFavourite }) {
  const { data, error, loading } = useApi(() => api.listCompetitions(), []);
  return (
    <Page title="Leagues" subtitle="Competitions can be switched on and off in Settings.">
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : (
        <div className="tile-grid">
          {data.filter((c) => c.isEnabled).map((c) => {
            const fav = me.favourites.some((f) => f.type === 'competition' && f.id === c.id);
            return (
              <div key={c.id} className="tile card">
                <a href={href('league', c.id)} className="tile-link">
                  <Crest src={c.logo} name={c.name} size={44} />
                  <span className="tile-name">{c.name}</span>
                  <span className="subtle small">{c.country}{c.season ? ` · ${c.season.label}` : ''}</span>
                  <span className="subtle small">{c.teams} teams · {c.matches} matches</span>
                </a>
                <button className={`star small${fav ? ' on' : ''}`} onClick={() => onFavourite('competition', c.id, !fav)}
                  aria-pressed={fav} title={fav ? 'Remove from favourites' : 'Add to favourites'}>{fav ? '★' : '☆'}</button>
              </div>
            );
          })}
        </div>
      )}
    </Page>
  );
}
