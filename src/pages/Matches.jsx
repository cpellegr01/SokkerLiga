import { useState } from 'react';
import * as api from '../api.js';
import { localDayRange, kickoffDay } from '../format.js';
import { useApi, Page, Loading, ErrorBanner, MatchesByCompetition } from '../components/ui.jsx';

const STATUSES = [['', 'Any status'], ['scheduled', 'Scheduled'], ['live', 'Live'], ['finished', 'Finished'],
  ['postponed', 'Postponed']];

export default function Matches({ params }) {
  const [offset, setOffset] = useState(Number(params.day ?? 0));
  const [competition, setCompetition] = useState(params.competition ?? '');
  const [country, setCountry] = useState('');
  const [status, setStatus] = useState('');
  const [team, setTeam] = useState(params.team ?? '');
  const [favourites, setFavourites] = useState(false);

  const comps = useApi(() => api.listCompetitions(), []);
  const teams = useApi(() => api.listTeams(competition ? { competition } : {}), [competition]);
  const range = localDayRange(offset);
  const { data, error, loading } = useApi(
    () => api.listMatches({ ...range, competition, country, status, team, favourites: favourites ? 1 : '' }),
    [offset, competition, country, status, team, favourites],
  );

  const enabled = (comps.data ?? []).filter((c) => c.isEnabled);
  const countries = [...new Set(enabled.map((c) => c.country))].sort();
  const days = [-3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7];

  return (
    <Page title="Matches">
      <div className="day-strip" role="tablist" aria-label="Day">
        {days.map((d) => {
          const r = localDayRange(d);
          return (
            <button key={d} role="tab" aria-selected={d === offset} className={d === offset ? 'day active' : 'day'}
              onClick={() => setOffset(d)}>
              {kickoffDay(new Date(Date.parse(r.from) + 12 * 3600_000).toISOString())}
            </button>
          );
        })}
      </div>

      <div className="filters">
        <select value={competition} onChange={(e) => { setCompetition(e.target.value); setTeam(''); }} aria-label="Competition">
          <option value="">All competitions</option>
          {enabled.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
          <option value="">All teams</option>
          {(teams.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={country} onChange={(e) => setCountry(e.target.value)} aria-label="Country">
          <option value="">All countries</option>
          {countries.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <label className="check">
          <input type="checkbox" checked={favourites} onChange={(e) => setFavourites(e.target.checked)} /> Favourites only
        </label>
      </div>

      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data && (data.length
        ? <MatchesByCompetition matches={data} />
        : <p className="subtle">No matches for this day and these filters.</p>)}
    </Page>
  );
}
