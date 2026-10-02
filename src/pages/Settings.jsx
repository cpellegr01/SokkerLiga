import { useEffect } from 'react';
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
                      <td><strong>{j.name}</strong><div className="subtle small">{j.description}</div></td>
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

      <h2>Competitions</h2>
      <p className="subtle">Switched-off competitions are not refreshed and are hidden from match lists. Their history is kept.</p>
      <ErrorBanner error={comps.error} />
      {!comps.data ? <Loading /> : (
        <div className="card">
          {comps.data.map((c) => (
            <label key={c.id} className="setting-row">
              <span className="team-cell"><Crest src={c.logo} name={c.name} size={20} /> {c.name}
                <span className="subtle small"> {c.country}{c.season ? ` · ${c.season.label}` : ''}</span></span>
              <input type="checkbox" checked={c.isEnabled} onChange={() => toggle(c)} />
            </label>
          ))}
        </div>
      )}
    </Page>
  );
}
