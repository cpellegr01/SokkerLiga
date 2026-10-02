import { useCallback, useEffect, useState } from 'react';
import { href } from '../router.js';
import { kickoffTime, kickoffDay, STATUS_LABEL } from '../format.js';
import { STANCE_LABEL } from '../markets.js';

/* ----------------------------------------------------------- data hook */

/** Load data for a page; re-run when deps change. */
export function useApi(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    loader()
      .then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((error) => alive && setState({ data: null, error: error.message, loading: false }));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

export function Page({ title, subtitle, actions, children }) {
  return (
    <section className="page">
      {(title || actions) && (
        <header className="page-header">
          <div>
            {title && <h1>{title}</h1>}
            {subtitle && <p className="subtle">{subtitle}</p>}
          </div>
          {actions && <div className="page-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Loading() {
  return <p className="subtle loading">Loading…</p>;
}

export function ErrorBanner({ error }) {
  return error ? <div className="banner error">{error}</div> : null;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

/* -------------------------------------------------------------- pieces */

/** A logo or photo, with an initials badge when there is none or it fails. */
export function Crest({ src, name, size = 24, round = false }) {
  const [failed, setFailed] = useState(false);
  const initials = String(name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const style = { width: size, height: size };
  if (!src || failed) {
    return <span className={`crest crest-fallback${round ? ' round' : ''}`} style={{ ...style, fontSize: size * 0.4 }}>{initials}</span>;
  }
  return <img className={`crest${round ? ' round' : ''}`} src={src} alt="" style={style} loading="lazy" onError={() => setFailed(true)} />;
}

const RESULT_WORD = { W: 'Win', D: 'Draw', L: 'Loss' };

/* "1 win", "2 wins" — counts in words, never W/D/L. */
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function FormStrip({ form }) {
  if (!form) return <span className="subtle">—</span>;
  return (
    <span className="form-strip" aria-label={`Form: ${form.split("").map((r) => RESULT_WORD[r] ?? r).join(", ")}`}>
      {form.split('').map((r, i) => (
        <span key={i} className={`form form-${r}`} title={RESULT_WORD[r] ?? r}>{r}</span>
      ))}
    </span>
  );
}

export function StatusPill({ match }) {
  if (match.status === 'live') {
    return <span className="pill live">{match.statusDetail === 'HT' ? 'HT' : `${match.elapsed ?? ''}′`}</span>;
  }
  if (match.status === 'scheduled') return null;
  return <span className={`pill ${match.status}`}>{STATUS_LABEL[match.status] ?? match.status}</span>;
}

/** One match as a clickable row. */
export function MatchRow({ match, showCompetition = false, showDay = false }) {
  const played = match.score && match.status !== 'scheduled';
  return (
    <a className={`match-row${match.status === 'live' ? ' is-live' : ''}${showDay ? ' with-day' : ''}`} href={href('match', match.id)}>
      <span className="match-time">
        {showDay && <span className="match-day">{kickoffDay(match.kickoffUtc)}</span>}
        {kickoffTime(match.kickoffUtc)}
      </span>
      <span className="match-team home">
        <span className="team-name">{match.home.name}</span>
        <Crest src={match.home.logo} name={match.home.name} size={20} />
      </span>
      <span className="match-score">
        {played ? `${match.score.home} – ${match.score.away}` : 'v'}
      </span>
      <span className="match-team away">
        <Crest src={match.away.logo} name={match.away.name} size={20} />
        <span className="team-name">{match.away.name}</span>
      </span>
      <span className="match-meta">
        <StatusPill match={match} />
        {showCompetition && <span className="subtle">{match.competition.name}</span>}
      </span>
    </a>
  );
}

/** Matches grouped by competition, favourites' competitions first. */
export function MatchesByCompetition({ matches, showDay = false }) {
  const groups = new Map();
  for (const m of matches) {
    const key = m.competition.id;
    if (!groups.has(key)) groups.set(key, { competition: m.competition, matches: [], favourite: false });
    const g = groups.get(key);
    g.matches.push(m);
    if (m.isFavourite) g.favourite = true;
  }
  const ordered = [...groups.values()].sort((a, b) => Number(b.favourite) - Number(a.favourite));
  return ordered.map((g) => (
    <div key={g.competition.id} className="card match-group">
      <a className="match-group-title" href={href('league', g.competition.id)}>
        <Crest src={g.competition.logo} name={g.competition.name} size={18} />
        {g.competition.name}
        <span className="subtle">{g.competition.country}</span>
      </a>
      {g.matches.map((m) => <MatchRow key={m.id} match={m} showDay={showDay} />)}
    </div>
  ));
}

export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.key} role="tab" aria-selected={active === t.key}
          className={active === t.key ? 'tab active' : 'tab'} onClick={() => onChange(t.key)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function FavouriteStar({ on, onToggle, label }) {
  return (
    <button className={`star${on ? ' on' : ''}`} onClick={onToggle} aria-pressed={on}
      title={on ? `Remove ${label} from favourites` : `Add ${label} to favourites`}>
      {on ? '★' : '☆'} <span className="star-label">{on ? 'Favourite' : 'Add to favourites'}</span>
    </button>
  );
}

/** Two numbers side by side with a split bar — home on the left. */
export function CompareBar({ label, home, away, unit, digits = 0 }) {
  const h = home ?? 0;
  const a = away ?? 0;
  const total = h + a;
  const share = total ? (h / total) * 100 : 50;
  const fmt = (v) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}${unit === 'percent' ? '%' : ''}`);
  return (
    <div className="compare">
      <div className="compare-values">
        <span>{fmt(home)}</span>
        <span className="compare-label">{label}</span>
        <span>{fmt(away)}</span>
      </div>
      <div className="compare-bar" aria-hidden="true">
        <span className="compare-home" style={{ width: `${share}%` }} />
        <span className="compare-away" style={{ width: `${100 - share}%` }} />
      </div>
    </div>
  );
}

export function StandingsTable({ group, highlight = [] }) {
  return (
    <div className="table-wrap">
      <table className="standings">
        <thead>
          <tr>
            <th className="num">#</th><th>Team</th><th className="num">P</th><th className="num">Wins</th>
            <th className="num">Draws</th><th className="num">Losses</th><th className="num hide-sm">GF</th>
            <th className="num hide-sm">GA</th><th className="num">GD</th><th className="num">Pts</th>
            <th className="hide-sm">Team Form</th>
          </tr>
        </thead>
        <tbody>
          {group.rows.map((r) => (
            <tr key={r.teamId} className={highlight.includes(r.teamId) ? 'highlight' : ''}>
              <td className="num">{r.position}</td>
              <td>
                <a className="team-cell" href={href('team', r.teamId)}>
                  <Crest src={r.teamLogo} name={r.teamName} size={18} /> {r.teamName}
                </a>
              </td>
              <td className="num">{r.played}</td><td className="num">{r.won}</td><td className="num">{r.drawn}</td>
              <td className="num">{r.lost}</td><td className="num hide-sm">{r.goalsFor}</td>
              <td className="num hide-sm">{r.goalsAgainst}</td>
              <td className="num">{r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff}</td>
              <td className="num strong">{r.points}</td>
              <td className="hide-sm"><FormStrip form={r.form} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** W–D–L record with goals, as one line. */
export function Record({ r }) {
  if (!r || !r.played) return <span className="subtle">No matches yet</span>;
  return (
    <span>
      {plural(r.won, 'win', 'wins')}, {plural(r.drawn, 'draw', 'draws')}, {plural(r.lost, 'loss', 'losses')}
      <span className="subtle"> · {r.goalsFor}–{r.goalsAgainst}</span>
    </span>
  );
}

/** Claude's verdict on a selection: green Supports, yellow Cautious, red Disagrees. */
export function StanceBadge({ stance, prefix = '' }) {
  if (!stance) return null;
  return <span className={`pill stance-${stance}`}>{prefix}{STANCE_LABEL[stance] ?? stance}</span>;
}

/** Recommend (green) or Pass (red); a Pass explains itself on hover. */
export function DecisionBadge({ decision, reasons = [] }) {
  if (!decision) return null;
  return decision === 'recommend'
    ? <span className="pill decision-recommend">Recommend</span>
    : <span className="pill decision-pass" title={reasons.join('\n')}>Pass</span>;
}
