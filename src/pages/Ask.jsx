import { useState } from 'react';
import * as api from '../api.js';
import { formatMoney } from '../odds.js';
import { Page, ErrorBanner, Profit } from '../components/ui.jsx';

const EXAMPLES = [
  'How accurate have our Premier League Over 2.5 predictions been?',
  'How does the model perform on Bundesliga home favourites?',
  'Which markets have the best-calibrated predictions?',
  'Do high-confidence recommendations outperform lower-confidence ones?',
  'Which teams consistently produce prediction errors?',
  'Did we beat the closing price?',
  'How have my La Liga bets done this season?',
];

const pct = (x) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(1)}%`);
const n3 = (x) => (x === null || x === undefined ? '—' : x.toFixed(3));

const STORE = 'sokkerliga.questions';
const recent = () => { try { return JSON.parse(localStorage.getItem(STORE)) ?? []; } catch { return []; } };

export default function Ask() {
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [history, setHistory] = useState(recent);

  const run = async (q) => {
    const text = (q ?? question).trim();
    if (!text) return;
    setQuestion(text);
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await api.ask(text));
      const next = [text, ...history.filter((h) => h !== text)].slice(0, 8);
      setHistory(next);
      try { localStorage.setItem(STORE, JSON.stringify(next)); } catch { /* private window */ }
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Page title="Ask"
      subtitle="Ask about SokkerLiga's own record — its predictions, the selections that passed your thresholds, and your bets. Claude only reads the question; every number comes from SokkerLiga's database.">
      <form className="card pad ask-form" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <textarea rows={2} value={question} placeholder="e.g. How accurate have our Premier League Over 2.5 predictions been?"
          aria-label="Your question" onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); } }} />
        <div className="bet-actions">
          <button className="primary" type="submit" disabled={busy || !question.trim()}>{busy ? 'Working…' : 'Ask'}</button>
        </div>
        <div className="ask-examples">
          {(history.length ? history : EXAMPLES).map((q) => (
            <button key={q} type="button" className="chip" onClick={() => run(q)} disabled={busy}>{q}</button>
          ))}
        </div>
      </form>
      <ErrorBanner error={error} />
      {result && <Answer r={result} />}
    </Page>
  );
}

function Answer({ r }) {
  if (!r.understood) {
    return <div className="card pad"><h3>Not something SokkerLiga can measure</h3><p>{r.clarification}</p></div>;
  }
  return (
    <div className="card pad">
      <h3>{r.filter.restatement || 'Answer'}</h3>
      <div className="chips">{r.filter.chips.map((c) => <span key={c} className="pill">{c}</span>)}</div>
      {r.filter.notes.map((n) => <p key={n} className="subtle">{n}</p>)}
      <p>{r.answer}</p>
      {r.kind === 'predictions' ? <PredictionTable rows={r.breakdown} /> : <BetTable rows={r.breakdown} currency={r.currency} />}
    </div>
  );
}

function PredictionTable({ rows }) {
  if (!rows?.length) return null;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>{' '}</th><th className="num">Selections</th><th className="num">Said</th><th className="num">Came in</th>
          <th className="num">Brier</th><th className="num">Skill</th><th className="num hide-sm">Log loss</th><th className="num hide-sm">Calibration error</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key}>
              <td>{b.label}</td><td className="num">{Math.round(b.n).toLocaleString()}</td>
              <td className="num">{pct(b.saidPct)}</td><td className="num">{pct(b.hitPct)}</td>
              <td className="num">{n3(b.brier)}</td>
              <td className={`num ${b.skill > 0 ? 'profit-up' : 'profit-down'}`}>{pct(b.skill)}</td>
              <td className="num hide-sm">{n3(b.logLoss)}</td><td className="num hide-sm">{pct(b.ece)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BetTable({ rows, currency }) {
  if (!rows?.length) return null;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>{' '}</th><th className="num">Bets</th><th className="num">Wins</th><th className="num">Losses</th>
          <th className="num">Profit</th><th className="num">ROI</th></tr></thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key}>
              <td>{b.key}</td><td className="num">{b.bets}</td><td className="num">{b.won}</td><td className="num">{b.lost}</td>
              <td className="num"><Profit minor={b.profitMinor} currency={currency} format={formatMoney} /></td>
              <td className="num">{pct(b.roi)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
