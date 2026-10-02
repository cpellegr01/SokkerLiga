import { useEffect, useState } from 'react';
import * as api from '../api.js';
import { ago } from '../format.js';
import { useApi, Page, Loading, ErrorBanner, Crest } from '../components/ui.jsx';

const STATUS = { ok: 'OK', partial: 'Partly done', failed: 'Failed', running: 'Running', skipped: 'Skipped' };
const every = (m) => (!m ? 'By hand' : m < 60 ? `Every ${m} min` : m < 1440 ? `Every ${m / 60} h`
  : m === 1440 ? 'Daily' : m === 10080 ? 'Weekly' : `Every ${Math.round(m / 1440)} days`);

export default function Settings() {
  const sync = useApi(() => api.getSync(), []);
  const comps = useApi(() => api.listCompetitions(), []);

  /* While anything is running or queued, refresh every few seconds. */
  const busy = sync.data?.jobs.some((j) => j.running || j.runRequested);
  useEffect(() => {
    if (!busy) return undefined;
    const t = setInterval(() => sync.reload(), 5000);
    return () => clearInterval(t);
  }, [busy, sync.reload]);

  const run = async (key) => { await api.runJob(key); sync.reload(); };
  const toggle = async (c) => { await api.setCompetitionEnabled(c.id, !c.isEnabled); comps.reload(); };

  return (
    <Page title="Settings">
      <h2>Data sync</h2>
      <ErrorBanner error={sync.error} />
      {!sync.data ? <Loading /> : (
        <>
          <div className="card pad">
            <p>
              API-Football:{' '}
              {sync.data.providerConfigured
                ? <span className="pill finished">Key configured</span>
                : <span className="pill failed">No key</span>}
              {sync.data.quota && (
                <span className="subtle">
                  {' '}· {sync.data.quota.requests_used.toLocaleString()} requests used on {sync.data.quota.day}
                  {sync.data.quota.remaining !== null && `, ${sync.data.quota.remaining.toLocaleString()} left of ${sync.data.quota.daily_limit?.toLocaleString() ?? '?'}`}
                </span>
              )}
            </p>
            <p>
              Claude (match explanations):{' '}
              {sync.data.explainerConfigured
                ? <span className="pill finished">Key configured</span>
                : <span className="pill failed">No key</span>}
              {!sync.data.explainerConfigured && <span className="subtle"> · Analyses still run, without the written explanation. Add ANTHROPIC_API_KEY to the same file.</span>}
            </p>
            <p className="subtle">
              Requests are planned around the daily quota: {sync.data.quotaReserve.toLocaleString()} are kept each day for results and
              lineups. Below that, league tables and injury reports wait for tomorrow; below twice that, squads, player profiles and
              the history backfill do. Tables are only checked after a matchday, injuries only before one. "Run now" always runs.
            </p>
            {!sync.data.providerConfigured && (
              <p className="subtle small">The key lives on the server in /etc/sokkerliga/sokkerliga.env as API_FOOTBALL_KEY. It is never shown here.</p>
            )}
          </div>
          <div className="card">
            <div className="table-wrap">
              <table className="data sync">
                <thead><tr><th>Job</th><th className="hide-sm">Schedule</th><th>Last success</th><th>Last run</th>
                  <th className="num hide-sm">In / written</th><th className="num hide-sm">Requests</th><th className="hide-sm">Next</th><th /></tr></thead>
                <tbody>
                  {sync.data.jobs.map((j) => (
                    <tr key={j.key}>
                      <td><strong>{j.name}</strong><div className="subtle small">{j.description}</div>
                        {j.quotaPriority === 'deferrable' && <div className="subtle small">Waits when requests run low.</div>}</td>
                      <td className="hide-sm">{every(j.intervalMinutes)}</td>
                      <td>{ago(j.lastSuccessAt)}</td>
                      <td>
                        {j.running ? <span className="pill live">Running</span> : j.lastRun ? (
                          <>
                            <span className={`pill ${j.lastRun.status}`}>{STATUS[j.lastRun.status] ?? j.lastRun.status}</span>
                            <div className="subtle small">{ago(j.lastRun.finished_at ?? j.lastRun.started_at)}</div>
                            {j.lastRun.message && <div className="subtle small clamp" title={j.lastRun.errors.join('\n')}>{j.lastRun.message}</div>}
                          </>
                        ) : <span className="subtle">Never</span>}
                      </td>
                      <td className="num hide-sm">{j.lastRun ? `${j.lastRun.records_in} / ${j.lastRun.records_written}` : '—'}</td>
                      <td className="num hide-sm">{j.lastRun?.requests_used ?? '—'}</td>
                      <td className="hide-sm">{j.runRequested ? 'Queued' : j.nextRunAt ? ago(j.nextRunAt) : '—'}</td>
                      <td><button onClick={() => run(j.key)} disabled={j.running || j.runRequested}>Run now</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <Thresholds />

      <BettingApps />

      <h2>Competitions</h2>
      <p className="subtle">Switched-off competitions are not refreshed and are hidden from match lists. Their history is kept.
        Switching one on fetches its season, teams, fixtures, table and squads straight away; run "Past seasons" above to add its
        history, which the backtest and the model then use.</p>
      <ErrorBanner error={comps.error} />
      {!comps.data ? <Loading /> : (
        <div className="card">
          {comps.data.filter((c) => c.isEnabled).map((c) => (
            <label key={c.id} className="setting-row">
              <span className="team-cell"><Crest src={c.logo} name={c.name} size={20} /> {c.name}
                <span className="subtle small"> {c.country}{c.season ? ` · ${c.season.label}` : ''}</span></span>
              <input type="checkbox" checked={c.isEnabled} onChange={() => toggle(c)} />
            </label>
          ))}
        </div>
      )}
      <LeagueCatalog onChanged={comps.reload} />
    </Page>
  );
}

function Thresholds() {
  const current = useApi(() => api.getThresholds(), []);
  const markets = useApi(() => api.listMarketTypes(), []);
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (current.data && !form) setForm({ ...current.data, minProbability: Math.round(current.data.minProbability * 100) });
  }, [current.data, form]);
  if (!form || !markets.data) return <Loading />;

  const toggle = (key) => {
    const all = markets.data.map((m) => m.key);
    const on = form.markets.length ? form.markets : all;
    const next = on.includes(key) ? on.filter((k) => k !== key) : [...on, key];
    setForm({ ...form, markets: next.length === all.length ? [] : next });
  };
  const enabled = (key) => !form.markets.length || form.markets.includes(key);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.setThresholds({ ...form, minProbability: Number(form.minProbability) / 100, minFairOdds: Number(form.minFairOdds), maxFairOdds: Number(form.maxFairOdds) });
      setSaved(new Date());
    } catch (err) { setError(err.message); }
  };

  return (
    <>
      <h2>Recommendation thresholds</h2>
      <p className="subtle">A selection is recommended only if it passes all of these. Changes apply to new analyses;
        each past recommendation keeps the thresholds it was made with.</p>
      <form className="card pad thresholds" onSubmit={save}>
        <ErrorBanner error={error} />
        <label>Minimum confidence
          <select value={form.minConfidence} onChange={(e) => setForm({ ...form, minConfidence: e.target.value })}>
            <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
          </select>
        </label>
        <label>Minimum probability (%)
          <input type="number" min="1" max="99" step="1" value={form.minProbability}
            onChange={(e) => setForm({ ...form, minProbability: e.target.value })} />
        </label>
        <label>Minimum fair odds
          <input type="number" min="1" step="0.05" value={form.minFairOdds}
            onChange={(e) => setForm({ ...form, minFairOdds: e.target.value })} />
          <span className="subtle">Skips near-certainties: at fair odds of 1.30 or less, no price on offer is likely to be worth it.</span>
        </label>
        <label>Maximum fair odds
          <input type="number" min="1.01" step="0.05" value={form.maxFairOdds}
            onChange={(e) => setForm({ ...form, maxFairOdds: e.target.value })} />
        </label>
        <fieldset>
          <legend>Markets</legend>
          {markets.data.map((m) => (
            <label key={m.key} className="check"><input type="checkbox" checked={enabled(m.key)} onChange={() => toggle(m.key)} /> {m.name}</label>
          ))}
        </fieldset>
        <div><button className="primary" type="submit">Save thresholds</button>{saved && <span className="subtle"> Saved.</span>}</div>
      </form>
    </>
  );
}

function BettingApps() {
  const { data, error, reload } = useApi(() => api.listSportsbooks(), []);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [err, setErr] = useState(null);
  const save = async (book) => {
    setErr(null);
    try { await api.saveSportsbook(book); reload(); } catch (e) { setErr(e.message); }
  };
  return (
    <>
      <h2>Betting apps</h2>
      <p className="subtle">The apps you bet with. Each bet is kept in its app's currency; amounts in different currencies are never added together.</p>
      <ErrorBanner error={error ?? err} />
      <div className="card">
        {(data ?? []).map((b) => (
          <div key={b.key} className="setting-row">
            <span>{b.name} <span className="subtle">{b.currency}</span></span>
            <label className="check">
              <input type="checkbox" checked={b.isActive} onChange={() => save({ ...b, isActive: !b.isActive })} /> In use
            </label>
          </div>
        ))}
        <form className="setting-row" onSubmit={(e) => { e.preventDefault(); save({ name, currency }).then(() => setName('')); }}>
          <input placeholder="Add a betting app, e.g. DraftKings" value={name} onChange={(e) => setName(e.target.value)} />
          <input aria-label="Currency" value={currency} maxLength={3} size={4} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
          <button type="submit" disabled={!name.trim()}>Add</button>
        </form>
      </div>
    </>
  );
}

/* Every league and cup API-Football covers, by country, with a search. */
function LeagueCatalog({ onChanged }) {
  const { data, error, reload } = useApi(() => api.leagueCatalog(), []);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState(null);
  const toggle = async (l) => {
    setBusy(l.apiId);
    setErr(null);
    try {
      if (l.isEnabled) await api.setCompetitionEnabled(l.competitionId, false);
      else if (l.competitionId) await api.setCompetitionEnabled(l.competitionId, true);
      else await api.enableFromCatalog(l.apiId);
      reload();
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };
  const term = q.trim().toLowerCase();
  const shown = (data ?? []).filter((l) => !term || `${l.name} ${l.country}`.toLowerCase().includes(term));
  const byCountry = new Map();
  for (const l of shown) {
    if (!byCountry.has(l.country)) byCountry.set(l.country, []);
    byCountry.get(l.country).push(l);
  }
  return (
    <>
      <h2>All leagues and cups</h2>
      <p className="subtle">Everything API-Football covers{data ? ` — ${data.length.toLocaleString()} competitions` : ''}. Each one switched on
        uses a few more requests a day.</p>
      <ErrorBanner error={error ?? err} />
      {!data ? <Loading /> : !data.length ? (
        <p className="subtle">The list has not been fetched yet: run "League catalogue" under Data sync above.</p>
      ) : (
        <div className="card pad">
          <input type="search" placeholder="Search by league or country, e.g. Nations League or Brazil" value={q}
            onChange={(e) => setQ(e.target.value)} aria-label="Search leagues" className="catalog-search" />
          {[...byCountry].map(([country, leagues]) => (
            <details key={country} className="catalog-country" open={!!term && byCountry.size <= 8}>
              <summary>
                <span className="team-cell"><Crest src={leagues[0].flag} name={country} size={16} /> {country}</span>
                <span className="subtle">{leagues.filter((l) => l.isEnabled).length ? `${leagues.filter((l) => l.isEnabled).length} on · ` : ''}{leagues.length}</span>
              </summary>
              {leagues.map((l) => (
                <label key={l.apiId} className="setting-row">
                  <span className="team-cell"><Crest src={l.logo} name={l.name} size={18} /> {l.name}
                    <span className="subtle small"> {l.type === 'Cup' ? 'Cup' : 'League'}</span></span>
                  <input type="checkbox" checked={l.isEnabled} disabled={busy === l.apiId} onChange={() => toggle(l)} />
                </label>
              ))}
            </details>
          ))}
          {!shown.length && <p className="subtle">Nothing matches "{q}".</p>}
        </div>
      )}
    </>
  );
}
