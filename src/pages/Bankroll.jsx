import { useState } from 'react';
import * as api from '../api.js';
import { formatMoney, currencyLabel } from '../odds.js';
import { shortDate } from '../format.js';
import DatePicker from '../components/DatePicker.jsx';
import { useApi, Page, Loading, ErrorBanner, Empty, Profit } from '../components/ui.jsx';

const METHOD = {
  flat: ['Flat bet', 'The same amount every bet.'],
  percent: ['Percent of balance', 'A fixed share of the current balance, so bets shrink after losses and grow after wins.'],
  unit: ['Units', 'A fixed unit; the suggestion is one unit.'],
};

export default function Bankroll() {
  const { data, error, loading, reload } = useApi(() => api.getBankroll(), []);
  const [adding, setAdding] = useState(null);
  return (
    <Page title="Bankroll"
      subtitle="Optional. Set a starting amount and a staking plan, and the bet slip suggests how much to bet and warns when too much is riding on open bets. Nothing here ever raises a bet to chase a loss.">
      <ErrorBanner error={error} />
      {loading && !data ? <Loading /> : data && (
        <>
          {!data.bankrolls.length && !adding && <Empty>No bankroll set up yet.</Empty>}
          {data.bankrolls.map((b) => <BankrollCard key={b.currency} b={b} onChanged={reload} />)}
          {adding ? <SettingsForm currency={adding} onDone={() => { setAdding(null); reload(); }} onCancel={() => setAdding(null)} />
            : (
              <div className="bet-actions">
                {data.unconfigured.map((c) => <button key={c} onClick={() => setAdding(c)}>Set up a {c} bankroll</button>)}
                {!data.unconfigured.length && (
                  <button onClick={() => setAdding('USD')}>{data.bankrolls.length ? 'Set up another currency' : 'Set up a bankroll'}</button>
                )}
              </div>
            )}
        </>
      )}
    </Page>
  );
}

function BankrollCard({ b, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [entry, setEntry] = useState(false);
  const money = (m) => formatMoney(m, b.currency);
  const s = b.settings;
  return (
    <div className="card pad">
      <div className="section-toggle">
        <h3>{b.currency} bankroll</h3>
        <div className="bet-actions">
          <button className="link-button" onClick={() => setEntry((x) => !x)}>Deposit or withdrawal</button>
          <button className="link-button" onClick={() => setEditing((x) => !x)}>Change plan</button>
        </div>
      </div>
      <div className="kpis compact">
        <Kpi label="Balance" value={money(b.balanceMinor)} />
        <Kpi label="Profit from bets" value={<Profit minor={b.profitMinor} currency={b.currency} format={formatMoney} />} />
        <Kpi label={`Open bets (${b.openBets})`} value={money(b.exposureMinor)}
          note={b.exposurePct === null ? null : `${b.exposurePct.toFixed(1)}% of balance; limit ${s.maxExposurePct}%`} />
        <Kpi label="Suggested bet" value={money(b.suggestedStakeMinor)}
          note={b.cappedByExposure ? 'Reduced: open bets are near your limit' : describePlan(s, b.currency)} />
      </div>
      <p className="subtle">
        Started {shortDate(s.startedAt)} with {money(s.startingMinor)} · deposits {money(b.depositsMinor)} · withdrawals {money(b.withdrawalsMinor)}.
        Bets placed before the start date do not count.
      </p>
      {editing && <SettingsForm currency={b.currency} current={s} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />}
      {entry && <LedgerForm currency={b.currency} onDone={() => { setEntry(false); onChanged(); }} />}
      <BalanceChart points={b.overTime} money={money} />
      {b.ledger.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Date</th><th>Entry</th><th className="num">Amount</th><th className="hide-sm">Note</th></tr></thead>
            <tbody>
              {b.ledger.slice().reverse().map((e) => (
                <tr key={e.id}>
                  <td>{shortDate(e.at)}</td>
                  <td>{e.kind === 'deposit' ? 'Deposit' : 'Withdrawal'}</td>
                  <td className={`num ${e.kind === 'deposit' ? 'profit-up' : 'profit-down'}`}>{e.kind === 'deposit' ? '+' : '−'}{money(e.amountMinor)}</td>
                  <td className="hide-sm subtle">{e.note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const describePlan = (s, currency) => (s.method === 'percent' ? `${s.amount}% of balance`
  : s.method === 'flat' ? `Flat ${formatMoney(s.amount, currency)}` : `1 unit of ${formatMoney(s.amount, currency)}`);

const Kpi = ({ label, value, note }) => (
  <div className="kpi"><span className="kpi-value">{value}</span><span className="kpi-label">{label}</span>
    {note && <span className="kpi-label">{note}</span>}</div>
);

function SettingsForm({ currency, current, onDone, onCancel }) {
  const [form, setForm] = useState({
    currency, starting: current ? (current.startingMinor / 100).toFixed(2) : '',
    method: current?.method ?? 'percent',
    amount: current ? (current.method === 'percent' ? String(current.amount) : (current.amount / 100).toFixed(2)) : '2',
    maxExposurePct: current?.maxExposurePct ?? 25,
    startedAt: current ? current.startedAt.slice(0, 10) : '',
  });
  const [error, setError] = useState(null);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.saveBankroll({ ...form, startedAt: form.startedAt ? new Date(`${form.startedAt}T00:00:00`).toISOString() : undefined });
      onDone();
    } catch (err) { setError(err.message); }
  };
  return (
    <form className="inline-form" onSubmit={save}>
      <ErrorBanner error={error} />
      <div className="slip-row">
        <label className="slip-field">Currency
          <input value={form.currency} maxLength={3} disabled={!!current} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} />
        </label>
        <label className="slip-field">Starting amount ({currencyLabel(form.currency || 'USD')})
          <input value={form.starting} inputMode="decimal" placeholder="1000.00" onChange={(e) => set({ starting: e.target.value })} />
        </label>
        <div className="slip-field">Counting bets from
          <DatePicker label="Counting bets from" value={form.startedAt} placeholder="Today" onChange={(v) => set({ startedAt: v })} clearable={false} />
        </div>
      </div>
      <div className="slip-row">
        <label className="slip-field">Staking plan
          <select value={form.method} onChange={(e) => set({ method: e.target.value, amount: e.target.value === 'percent' ? '2' : '' })}>
            {Object.entries(METHOD).map(([k, [name]]) => <option key={k} value={k}>{name}</option>)}
          </select>
          <span className="subtle">{METHOD[form.method][1]}</span>
        </label>
        <label className="slip-field">{form.method === 'percent' ? 'Percent of balance' : form.method === 'flat' ? `Bet amount (${currencyLabel(form.currency || 'USD')})` : `Unit size (${currencyLabel(form.currency || 'USD')})`}
          <input value={form.amount} inputMode="decimal" placeholder={form.method === 'percent' ? '2' : '10.00'} onChange={(e) => set({ amount: e.target.value })} />
        </label>
        <label className="slip-field">Limit on open bets (% of balance)
          <input value={form.maxExposurePct} inputMode="decimal" onChange={(e) => set({ maxExposurePct: e.target.value })} />
        </label>
      </div>
      <div className="bet-actions">
        <button className="primary" type="submit">Save plan</button>
        <button type="button" className="link-button" onClick={onCancel}>Cancel</button>
      </div>
      <p className="subtle">Changing the plan keeps the old one on record; past suggestions are not rewritten.</p>
    </form>
  );
}

function LedgerForm({ currency, onDone }) {
  const [form, setForm] = useState({ kind: 'deposit', amount: '', note: '', at: '' });
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.addLedger({ ...form, currency, at: form.at ? new Date(`${form.at}T12:00:00`).toISOString() : undefined });
      onDone();
    } catch (err) { setError(err.message); }
  };
  return (
    <form className="inline-form" onSubmit={save}>
      <ErrorBanner error={error} />
      <div className="slip-row">
        <label className="slip-field">Entry
          <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
            <option value="deposit">Deposit</option><option value="withdrawal">Withdrawal</option>
          </select>
        </label>
        <label className="slip-field">Amount ({currencyLabel(currency)})
          <input value={form.amount} inputMode="decimal" onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        </label>
        <div className="slip-field">Date
          <DatePicker label="Date" value={form.at} placeholder="Today" onChange={(v) => setForm({ ...form, at: v })} />
        </div>
      </div>
      <label className="slip-field">Note
        <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
      </label>
      <div><button className="primary" type="submit" disabled={!form.amount}>Add entry</button></div>
      <p className="subtle">Entries can't be edited or deleted; to fix one, add the opposite entry.</p>
    </form>
  );
}

/* The balance as steps over time: it changes only when money moves or a
 * bet settles, so it is drawn flat between those moments. */
function BalanceChart({ points, money }) {
  if (points.length < 2) return null;
  const W = 600; const H = 140; const P = 10;
  const t0 = Date.parse(points[0].at);
  const t1 = Math.max(Date.now(), Date.parse(points.at(-1).at));
  const ys = points.map((p) => p.balanceMinor);
  const lo = Math.min(...ys); const hi = Math.max(...ys);
  const x = (at) => P + ((Date.parse(at) - t0) / (t1 - t0 || 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P);
  let d = `M${x(points[0].at).toFixed(1)},${y(points[0].balanceMinor).toFixed(1)}`;
  for (let i = 1; i < points.length; i += 1) {
    d += ` H${x(points[i].at).toFixed(1)} V${y(points[i].balanceMinor).toFixed(1)}`;
  }
  d += ` H${(W - P).toFixed(1)}`;
  return (
    <>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Balance over time, now ${money(ys.at(-1))}`}>
        <path className="line" vectorEffect="non-scaling-stroke" d={d} />
      </svg>
      <div className="chart-labels subtle">
        <span>{shortDate(points[0].at)}</span>
        <span>High {money(hi)} · low {money(lo)}</span>
        <span>Today</span>
      </div>
    </>
  );
}
