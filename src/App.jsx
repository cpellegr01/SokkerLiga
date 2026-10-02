import { useEffect, useRef, useState } from 'react';
import * as api from './api.js';
import { useRoute, href, go } from './router.js';
import { VERSION } from './version.js';
import { Crest } from './components/ui.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Matches from './pages/Matches.jsx';
import MatchCenter from './pages/MatchCenter.jsx';
import Team from './pages/Team.jsx';
import Player from './pages/Player.jsx';
import League from './pages/League.jsx';
import Settings from './pages/Settings.jsx';
import Later from './pages/Later.jsx';
import Predictions from './pages/Predictions.jsx';
import Bets from './pages/Bets.jsx';
import History from './pages/History.jsx';
import { BetSlipProvider } from './components/BetSlip.jsx';
import { Teams, Players, Leagues } from './pages/Lists.jsx';

const NAV = [
  ['dashboard', 'Dashboard'], ['matches', 'Matches'], ['predictions', 'Predictions'], ['bets', 'My Bets'],
  ['history', 'Betting History'], ['performance', 'Model Performance'], ['teams', 'Teams'], ['players', 'Players'],
  ['leagues', 'Leagues'], ['settings', 'Settings'],
];
/* Which nav item a detail page belongs to. */
const SECTION = { match: 'matches', team: 'teams', player: 'players', league: 'leagues' };

export default function App() {
  const route = useRoute();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    api.getMe().then(setMe).catch((e) => setError(e.message));
  }, []);
  useEffect(() => setMenuOpen(false), [route.page, route.id]);

  const onFavourite = async (type, id, on) => {
    const favourites = await api.setFavourite(type, id, on);
    setMe((m) => ({ ...m, favourites }));
  };

  if (error) return <div className="boot"><div className="banner error">{error}</div></div>;
  if (!me) return <div className="boot subtle">Loading…</div>;

  const section = SECTION[route.page] ?? route.page;
  const props = { id: route.id, params: route.params, me, onFavourite };

  return (
    <BetSlipProvider>
    <div className="shell">
      <header className="topbar">
        <button className="menu-button" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>☰</button>
        <a className="brand" href={href('dashboard')}>SokkerLiga</a>
        <GlobalSearch />
        <div className="topbar-right">
          <span className="subtle hide-sm">{me.user.display_name}</span>
          <a className="subtle" href={me.frontDoor} title="Back to the Conforza menu">Apps</a>
        </div>
      </header>
      <div className="body">
        <nav className={menuOpen ? 'sidenav open' : 'sidenav'} aria-label="Main">
          {NAV.map(([key, label]) => (
            <a key={key} href={href(key)} className={section === key ? 'active' : ''}>{label}</a>
          ))}
          <span className="version subtle small">v{VERSION}</span>
        </nav>
        <main className="content">
          <Routed page={route.page} props={props} />
        </main>
      </div>
    </div>
    </BetSlipProvider>
  );
}

function Routed({ page, props }) {
  switch (page) {
    case 'dashboard': return <Dashboard {...props} />;
    case 'matches': return <Matches {...props} />;
    case 'match': return <MatchCenter key={props.id} {...props} />;
    case 'teams': return <Teams {...props} />;
    case 'team': return <Team key={props.id} {...props} />;
    case 'players': return <Players {...props} />;
    case 'player': return <Player key={props.id} {...props} />;
    case 'leagues': return <Leagues {...props} />;
    case 'league': return <League key={props.id} {...props} />;
    case 'settings': return <Settings {...props} />;
    case 'predictions': return <Predictions {...props} />;
    case 'bets': return <Bets {...props} />;
    case 'history': return <History {...props} />;
    case 'performance': return <Later page={page} />;
    default: return <Dashboard {...props} />;
  }
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const box = useRef(null);

  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); return undefined; }
    const t = setTimeout(() => api.search(q).then(setResults).catch(() => setResults(null)), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const close = (e) => { if (box.current && !box.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const pick = (page, id) => { setOpen(false); setQ(''); go(page, id); };
  const total = results ? results.teams.length + results.players.length + results.competitions.length + results.matches.length : 0;

  return (
    <div className="search" ref={box}>
      <input type="search" placeholder="Search teams, players, leagues" value={q} aria-label="Search"
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }} />
      {open && results && (
        <div className="search-results card">
          {!total && <p className="subtle pad">Nothing found.</p>}
          {results.competitions.length > 0 && <h4>Leagues</h4>}
          {results.competitions.map((c) => (
            <button key={`c${c.id}`} onClick={() => pick('league', c.id)}><Crest src={c.logo} name={c.name} size={18} /> {c.name}</button>
          ))}
          {results.teams.length > 0 && <h4>Teams</h4>}
          {results.teams.map((t) => (
            <button key={`t${t.id}`} onClick={() => pick('team', t.id)}><Crest src={t.logo} name={t.name} size={18} /> {t.name}</button>
          ))}
          {results.players.length > 0 && <h4>Players</h4>}
          {results.players.map((p) => (
            <button key={`p${p.id}`} onClick={() => pick('player', p.id)}>
              <Crest src={p.photo} name={p.name} size={18} round /> {p.name}{p.team && <span className="subtle"> · {p.team}</span>}
            </button>
          ))}
          {results.matches.length > 0 && <h4>Matches</h4>}
          {results.matches.map((m) => (
            <button key={`m${m.id}`} onClick={() => pick('match', m.id)}>
              {m.home.name} {m.score ? `${m.score.home}–${m.score.away}` : 'v'} {m.away.name}
              <span className="subtle"> · {new Date(m.kickoffUtc).toLocaleDateString()}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
