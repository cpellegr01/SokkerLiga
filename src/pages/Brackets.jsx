import { useState } from 'react';
import * as api from '../api.js';
import { href, go } from '../router.js';
import { kickoff } from '../format.js';
import { useApi, Page, Loading, ErrorBanner, Empty, Crest } from '../components/ui.jsx';

/** Knockout brackets: pick a competition, see its rounds side by side. */
export default function Brackets({ id, params }) {
  const list = useApi(() => api.bracketCompetitions(), []);
  const [qualifying, setQualifying] = useState(false);
  const season = params?.season ?? '';
  const { data, error, loading } = useApi(() => (id ? api.getBracket(id, season) : Promise.resolve(null)), [id, season]);
  const current = list.data?.find((c) => String(c.id) === String(id));

  return (
    <Page title="Brackets" subtitle="The knockout rounds of each competition, from the fixtures and results SokkerLiga has. Two-legged ties show the aggregate.">
      <ErrorBanner error={list.error ?? error} />
      {!list.data ? <Loading /> : !list.data.length ? (
        <Empty>No competition you follow has knockout rounds yet. Cups, the Champions League, the Nations League and the MLS play-offs appear here once their knockout fixtures are known.</Empty>
      ) : (
        <div className="filters">
          <select value={id ?? ''} onChange={(e) => go('brackets', e.target.value || undefined)} aria-label="Competition">
            <option value="">Choose a competition</option>
            {list.data.map((c) => <option key={c.id} value={c.id}>{c.name}{c.country ? ` · ${c.country}` : ''}</option>)}
          </select>
          {current && current.seasons.length > 1 && (
            <select value={season || data?.season?.id || ''} onChange={(e) => go('brackets', id, { season: e.target.value })} aria-label="Season">
              {current.seasons.map((s) => <option key={s.id} value={s.id}>{s.label}{s.isCurrent ? ' (current)' : ''}</option>)}
            </select>
          )}
          {data?.qualifying.length > 0 && (
            <label className="check"><input type="checkbox" checked={qualifying} onChange={(e) => setQualifying(e.target.checked)} /> Show qualifying rounds</label>
          )}
        </div>
      )}
      {id && loading && !data && <Loading />}
      {data && (
        !data.rounds.length && !data.qualifying.length && !data.sideRounds.length ? <Empty>{data.competition?.name ?? 'This competition'} has no knockout rounds in {data.season?.label ?? 'this season'}.</Empty> : (
          <>
            {data.note && <div className="banner warn">{data.note}</div>}
            <div className="bracket-head">
              <Crest src={data.competition.logo} name={data.competition.name} size={28} />
              <h2>{data.competition.name} <span className="subtle">{data.season.label}</span></h2>
            </div>
            <div className="bracket" role="region" aria-label={`${data.competition.name} bracket`}>
              {[...(qualifying ? data.qualifying : []), ...data.rounds].map((r, i, all) => (
                <div key={r.name} className="bracket-round">
                  <h4>{r.name}</h4>
                  <div className="bracket-ties">
                    {r.ties.map((t) => <Tie key={t.key} tie={t} last={i === all.length - 1} />)}
                  </div>
                </div>
              ))}
            </div>
            {data.sideRounds.length > 0 && (
              <>
                <h3>Promotion and relegation play-offs</h3>
                <div className="bracket">
                  {data.sideRounds.map((r) => (
                    <div key={r.name} className="bracket-round">
                      <h4>{r.name}</h4>
                      <div className="bracket-ties">{r.ties.map((t) => <Tie key={t.key} tie={t} last />)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {data.thirdPlace && (
              <div className="bracket-extra">
                <h4>{data.thirdPlace.name}</h4>
                {data.thirdPlace.ties.map((t) => <Tie key={t.key} tie={t} last />)}
              </div>
            )}
          </>
        )
      )}
    </Page>
  );
}

function Tie({ tie, last }) {
  if (tie.kind === 'projected') {
    return (
      <div className={`bracket-tie projected${last ? '' : ' joins'}`}>
        {tie.slots.map((t, i) => (
          <div key={i} className="bracket-team">
            {t.id ? <a className="team-cell" href={href('team', t.id)}><Crest src={t.logo} name={t.name} size={16} /> <span className="team-name">{t.name}</span></a>
              : <span className="subtle team-name" title={t.placeholder}>{t.placeholder}</span>}
          </div>
        ))}
        <div className="bracket-legs subtle">Not drawn yet</div>
      </div>
    );
  }
  const scoreOf = (t) => (tie.kind === 'series' ? t.wins : tie.legs.some((l) => l.score) ? t.goals : '');
  return (
    <div className={`bracket-tie${last ? '' : ' joins'}`}>
      {tie.teams.map((t) => (
        <div key={t.id} className={`bracket-team${t.winner ? ' winner' : tie.decided ? ' out' : ''}`}>
          <a className="team-cell" href={href('team', t.id)}><Crest src={t.logo} name={t.name} size={16} /> <span className="team-name">{t.name}</span></a>
          <span className="bracket-score">{scoreOf(t)}{t.pens !== null ? <span className="subtle"> ({t.pens})</span> : null}</span>
        </div>
      ))}
      <div className="bracket-legs subtle">
        {tie.kind === 'two-legs' && <span>Aggregate · </span>}
        {tie.kind === 'series' && <span>Series, wins · </span>}
        {tie.legs.map((l, i) => (
          <span key={l.matchId}>{i ? ' · ' : ''}
            <a href={href('match', l.matchId)} title={`${l.home} ${l.score ?? 'v'} ${l.away}`}>
              {l.score ? `${l.score}${l.pens ? ` (pens ${l.pens})` : ''}` : `Upcoming ${kickoff(l.kickoffUtc)}`}
            </a>
          </span>
        ))}
      </div>
    </div>
  );
}
