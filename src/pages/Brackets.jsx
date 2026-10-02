import { useState } from 'react';
import * as api from '../api.js';
import { href, go } from '../router.js';
import { kickoff } from '../format.js';

/* "Tue, Mar 4" for a played leg; with the kickoff time when it is still to come. */
const legDate = (iso, withTime) => new Date(iso).toLocaleString(undefined, withTime
  ? { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }
  : { weekday: 'short', day: 'numeric', month: 'short' });

const longDay = (iso) => new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)
  .toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
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
            {data.note && (
              <div className="banner warn">
                {data.note.season} is still in its group or league phase
                {data.note.groupPhaseEnds ? <>, which ends on <span className="nowrap">{longDay(data.note.groupPhaseEnds)}</span></> : ''}.
                {' '}Its knockout dates have not been published yet
                {data.note.seasonEnds ? <> (the season runs until <span className="nowrap">{longDay(data.note.seasonEnds)}</span>)</> : ''}; they
                appear here as soon as they are. Showing {data.note.showing} meanwhile.
              </div>
            )}
            <div className="bracket-head">
              <Crest src={data.competition.logo} name={data.competition.name} size={28} />
              <h2>{data.competition.name} <span className="subtle">{data.season.label}</span></h2>
              {data.startsAt && (
                <span className="subtle">
                  {Date.parse(data.startsAt) > Date.now() ? 'Knockouts start' : 'Knockouts started'} <span className="nowrap">{longDay(data.startsAt)}</span>
                </span>
              )}
            </div>
            <div className="bracket" role="region" aria-label={`${data.competition.name} bracket`}>
              <BracketColumns rounds={[...(qualifying ? data.qualifying : []), ...data.rounds]} />
            </div>
            {data.sideRounds.length > 0 && (
              <>
                <h3>Promotion and relegation play-offs</h3>
                <div className="bracket">
                  {data.sideRounds.map((r) => (
                    <div key={r.name} className="bracket-round">
                      <h4>{r.name}</h4>
                      <div className="bracket-ties">{r.ties.map((t) => <Tie key={t.key} tie={t} />)}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
            {data.thirdPlace && (
              <div className="bracket-extra">
                <h4>{data.thirdPlace.name}</h4>
                {data.thirdPlace.ties.map((t) => <Tie key={t.key} tie={t} />)}
              </div>
            )}
          </>
        )
      )}
    </Page>
  );
}

/* The rounds as columns. Where a round has twice as many ties as the next,
 * each pair of ties is joined to the tie it feeds with an elbow line:
 * right, then down (or up) to meet its partner, then right into the next
 * box. Every column is the same height and each tie sits in an equal slot,
 * so the lines meet exactly between the two ties they join. */
function BracketColumns({ rounds }) {
  /* "MLS Cup - Round 1" → "Round 1" when every round shares the prefix. */
  const prefix = commonPrefix(rounds.map((r) => r.name));
  return rounds.map((r, i) => {
    const next = rounds[i + 1];
    const prev = rounds[i - 1];
    const feeds = next && Math.ceil(r.ties.length / 2) === next.ties.length && r.ties.length > 1;
    const fed = prev && Math.ceil(prev.ties.length / 2) === r.ties.length && prev.ties.length > 1;
    /* One tie into one tie (the Champions League's round of 32 into the
     * round of 16): a straight line where the winner goes on at the same row. */
    const straight = next && next.ties.length === r.ties.length;
    const straightIn = prev && prev.ties.length === r.ties.length;
    const pairs = [];
    for (let j = 0; j < r.ties.length; j += feeds ? 2 : 1) pairs.push(r.ties.slice(j, feeds ? j + 2 : j + 1));
    return (
      <div key={r.name} className="bracket-round">
        <h4 title={r.name}>{r.name.slice(prefix.length) || r.name}</h4>
        <div className="bracket-ties">
          {pairs.map((pair) => (
            <div key={pair[0].key} className={`bracket-pair${feeds && pair.length === 2 ? ' joins' : ''}${feeds && pair.length === 1 ? ' joins-one' : ''}`}>
              {pair.map((t) => {
                const j = r.ties.indexOf(t);
                const out = straight && t.next === j;
                const into = straightIn && prev.ties[j]?.next === j;
                return (
                  <div key={t.key} className={`bracket-slot${fed || into ? ' fed' : ''}${out ? ' out-line' : ''}`}><Tie tie={t} /></div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    );
  });
}

function commonPrefix(names) {
  if (names.length < 2) return '';
  let p = names[0];
  for (const n of names) while (!n.startsWith(p)) p = p.slice(0, -1);
  /* Cut back to the end of a separator, so only whole words go. */
  const m = p.match(/^(.*[-–:·])\s*/);
  return m ? m[0] : '';
}

function Tie({ tie }) {
  if (tie.kind === 'projected') {
    return (
      <div className="bracket-tie projected">
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
    <div className="bracket-tie">
      {tie.teams.map((t) => (
        <div key={t.id} className={`bracket-team${t.winner ? ' winner' : tie.decided ? ' out' : ''}`}>
          <a className="team-cell" href={href('team', t.id)}><Crest src={t.logo} name={t.name} size={16} /> <span className="team-name">{t.name}</span></a>
          <span className="bracket-score">{scoreOf(t)}{t.pens !== null ? <span className="subtle"> ({t.pens})</span> : null}
            {t.winner && <span className="bracket-through" aria-label="Through"> ✓</span>}</span>
        </div>
      ))}
      <div className="bracket-legs subtle">
        {tie.kind === 'two-legs' && <div>Aggregate over two legs</div>}
        {tie.kind === 'series' && <div>Series: games won</div>}
        {tie.legs.map((l) => {
          const upcoming = !l.score;
          return (
            <a key={l.matchId} className="bracket-leg" href={href('match', l.matchId)} title={`${l.home} v ${l.away}`}>
              <span className="nowrap">{legDate(l.kickoffUtc, upcoming)}</span>
              <span className="bracket-leg-result">{upcoming ? 'Upcoming' : `${l.home} ${l.score}${l.pens ? ` (pens ${l.pens})` : ''}`}</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}
