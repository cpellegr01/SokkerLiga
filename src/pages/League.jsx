import { useState } from 'react';
import * as api from '../api.js';
import { href } from '../router.js';
import { shortDate } from '../format.js';
import { useApi, Page, Loading, ErrorBanner, Crest, StandingsTable, MatchRow, FavouriteStar } from '../components/ui.jsx';

export default function League({ id, me, onFavourite }) {
  const [season, setSeason] = useState('');
  const { data, error, loading } = useApi(() => api.getCompetition(id, season), [id, season]);
  if (loading && !data) return <Page><Loading /></Page>;
  if (error) return <Page><ErrorBanner error={error} /></Page>;
  const { competition, seasons, table, results, fixtures } = data;
  const fav = me.favourites.some((f) => f.type === 'competition' && f.id === competition.id);

  return (
    <Page>
      <div className="profile-header card">
        <Crest src={competition.logo} name={competition.name} size={64} />
        <div className="profile-title">
          <h1>{competition.name}</h1>
          <p className="subtle">{competition.country}</p>
          {seasons.length > 0 && (
            <select value={data.season?.id ?? ''} onChange={(e) => setSeason(e.target.value)} aria-label="Season">
              {seasons.map((s) => <option key={s.id} value={s.id}>{s.label}{s.isCurrent ? ' (current)' : ''}{s.matches ? '' : ' — no data yet'}</option>)}
            </select>
          )}
        </div>
        <a className="link-button" href={href('brackets', competition.id, data.season ? { season: data.season.id } : undefined)}>Bracket</a>
        <FavouriteStar on={fav} label={competition.name} onToggle={() => onFavourite('competition', competition.id, !fav)} />
      </div>

      {table.groups.length ? table.groups.map((g) => (
        <div key={g.name} className="card">
          <h3 className="pad-x">{g.name || 'Table'} <span className="subtle small">as of {shortDate(table.asOf)}</span></h3>
          <StandingsTable group={g} />
        </div>
      )) : <p className="subtle">No table yet for this season.</p>}

      <div className="grid-2">
        <div className="card">
          <h3 className="pad-x">Fixtures</h3>
          {fixtures.length ? fixtures.map((m) => <MatchRow key={m.id} match={m} showDay />) : <p className="subtle pad">No upcoming fixtures.</p>}
        </div>
        <div className="card">
          <h3 className="pad-x">Results</h3>
          {results.length ? results.map((m) => <MatchRow key={m.id} match={m} showDay />) : <p className="subtle pad">No results yet.</p>}
        </div>
      </div>
    </Page>
  );
}
