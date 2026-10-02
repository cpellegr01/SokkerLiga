import { useEffect, useMemo, useRef, useState } from 'react';

/* A calendar for every date field.
 *
 *   <DatePicker value="2026-10-04" onChange={…} />                  date: 'YYYY-MM-DD'
 *   <DatePicker mode="datetime" value="2026-10-04T18:30" … />        local date and time
 *
 * Values are local dates as strings, the same shape native date inputs use,
 * so callers convert to ISO exactly as before. A popover on wide screens, a
 * sheet from the bottom on phones. Keyboard: arrows move a day/week, Page
 * Up/Down a month, Enter picks, Escape closes. */

const pad = (n) => String(n).padStart(2, '0');
const toKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromKey = (k) => {
  const [y, m, d] = k.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d, n) => {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), last));
};

export default function DatePicker({ value, onChange, mode = 'date', placeholder = 'Pick a date', label, clearable = true }) {
  const [open, setOpen] = useState(false);
  const datePart = value ? value.slice(0, 10) : '';
  const timePart = mode === 'datetime' ? (value?.slice(11, 16) || '') : '';
  const wrap = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (wrap.current && !wrap.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const text = datePart
    ? fromKey(datePart).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
      + (timePart ? ` · ${new Date(`2000-01-01T${timePart}`).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '')
    : placeholder;

  const emit = (d, t = timePart) => {
    if (!d) return onChange('');
    if (mode === 'datetime') {
      const now = new Date();
      return onChange(`${d}T${t || `${pad(now.getHours())}:${pad(now.getMinutes())}`}`);
    }
    return onChange(d);
  };

  return (
    <span className="datepicker" ref={wrap}>
      <button type="button" className={`datepicker-field${datePart ? '' : ' empty'}`} aria-haspopup="dialog" aria-expanded={open}
        aria-label={label ? `${label}: ${datePart ? text : 'not set'}` : undefined} onClick={() => setOpen((o) => !o)}>
        <CalendarIcon />
        <span className="datepicker-text">{text}</span>
      </button>
      {clearable && datePart && (
        <button type="button" className="datepicker-clear" aria-label={`Clear ${label ?? 'date'}`} onClick={() => emit('')}>×</button>
      )}
      {open && (
        <Calendar
          selected={datePart}
          time={timePart}
          mode={mode}
          label={label}
          onPick={(d) => { emit(d); if (mode === 'date') setOpen(false); }}
          onTime={(t) => emit(datePart || toKey(new Date()), t)}
          onClose={() => setOpen(false)}
          onClear={clearable ? () => { emit(''); setOpen(false); } : null}
        />
      )}
    </span>
  );
}

function Calendar({ selected, time, mode, label, onPick, onTime, onClose, onClear }) {
  const today = toKey(new Date());
  const [focus, setFocus] = useState(selected || today);
  const month = fromKey(focus);
  const grid = useRef(null);

  /* Weeks start on the locale's first day where the browser says so; Sunday otherwise. */
  const firstDay = useMemo(() => {
    try { return new Intl.Locale(navigator.language).weekInfo?.firstDay % 7 || 0; } catch { return 0; }
  }, []);
  const weekdays = useMemo(() => Array.from({ length: 7 }, (_, i) =>
    new Date(2024, 0, 7 + ((firstDay + i) % 7)).toLocaleDateString(undefined, { weekday: 'short' })), [firstDay]);

  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  const lead = (start.getDay() - firstDay + 7) % 7;
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i - lead));

  /* Keep keyboard focus on the focused day as it moves. */
  useEffect(() => {
    grid.current?.querySelector(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  const onKey = (e) => {
    const d = fromKey(focus);
    const move = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
    if (move) { e.preventDefault(); setFocus(toKey(addDays(d, move))); }
    else if (e.key === 'PageUp') { e.preventDefault(); setFocus(toKey(addMonths(d, -1))); }
    else if (e.key === 'PageDown') { e.preventDefault(); setFocus(toKey(addMonths(d, 1))); }
    else if (e.key === 'Home') { e.preventDefault(); setFocus(toKey(new Date())); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <>
      <div className="datepicker-backdrop" onClick={onClose} />
      <div className="datepicker-pop" role="dialog" aria-label={label ?? 'Choose a date'} onKeyDown={onKey}>
        <div className="datepicker-head">
          <button type="button" className="datepicker-nav" aria-label="Previous month" onClick={() => setFocus(toKey(addMonths(month, -1)))}>‹</button>
          <span className="datepicker-month">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</span>
          <button type="button" className="datepicker-nav" aria-label="Next month" onClick={() => setFocus(toKey(addMonths(month, 1)))}>›</button>
        </div>
        <div className="datepicker-grid" role="grid" ref={grid}>
          {weekdays.map((w) => <span key={w} className="datepicker-weekday" role="columnheader">{w}</span>)}
          {cells.map((d) => {
            const k = toKey(d);
            const cls = ['datepicker-day',
              d.getMonth() !== month.getMonth() && 'outside', k === today && 'today', k === selected && 'selected'].filter(Boolean).join(' ');
            return (
              <button key={k} type="button" className={cls} data-day={k} tabIndex={k === focus ? 0 : -1}
                aria-pressed={k === selected} aria-label={d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                onClick={() => { setFocus(k); onPick(k); }}>
                {d.getDate()}
              </button>
            );
          })}
        </div>
        {mode === 'datetime' && (
          <label className="datepicker-time">Time
            <input type="time" value={time} onChange={(e) => onTime(e.target.value)} />
          </label>
        )}
        <div className="datepicker-foot">
          <button type="button" className="link-button" onClick={() => { setFocus(today); onPick(today); }}>Today</button>
          {onClear && <button type="button" className="link-button" onClick={onClear}>Clear</button>}
          <button type="button" className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </>
  );
}

function CalendarIcon() {
  return (
    <svg className="datepicker-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="3" width="13" height="11.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
