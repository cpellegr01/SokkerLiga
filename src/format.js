/* Dates are stored in UTC and shown in the browser's own time zone. */

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()
  && a.getDate() === b.getDate();

export function kickoffTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function kickoffDay(iso) {
  const d = new Date(iso);
  const today = new Date();
  const tomorrow = new Date(Date.now() + 86400_000);
  const yesterday = new Date(Date.now() - 86400_000);
  if (sameDay(d, today)) return 'Today';
  if (sameDay(d, tomorrow)) return 'Tomorrow';
  if (sameDay(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

export const kickoff = (iso) => `${kickoffDay(iso)} · ${kickoffTime(iso)}`;

export function longDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function shortDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ago(iso) {
  if (!iso) return 'Never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  const future = s < 0;
  const a = Math.abs(s);
  const text = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)} min` : a < 86400 ? `${Math.round(a / 3600)} h`
    : `${Math.round(a / 86400)} d`;
  return future ? `In ${text}` : `${text} ago`;
}

/** Midnight to midnight in the browser's time zone, as UTC ISO strings. */
export function localDayRange(offsetDays = 0) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { from: start.toISOString(), to: end.toISOString() };
}

export const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
export const num = (v, digits = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(digits));

export const STATUS_LABEL = {
  scheduled: 'Scheduled', live: 'Live', finished: 'Full time', postponed: 'Postponed',
  suspended: 'Suspended', abandoned: 'Abandoned', cancelled: 'Cancelled', awarded: 'Awarded',
};
