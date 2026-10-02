/* Thin wrapper over the API. Failures surface the server's own message,
 * which is written to be shown to a person as-is. */

async function request(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error ?? 'The request failed.');
  return body;
}

const query = (params) => {
  const s = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return s ? `?${s}` : '';
};

export const getMe = () => request('/me');
export const getDashboard = (params) => request(`/dashboard${query(params)}`);
export const search = (q) => request(`/search${query({ q })}`);
export const listMatches = (params) => request(`/matches${query(params)}`);
export const getMatch = (id) => request(`/matches/${id}`);
export const listTeams = (params = {}) => request(`/teams${query(params)}`);
export const getTeam = (id) => request(`/teams/${id}`);
export const listPlayers = (params = {}) => request(`/players${query(params)}`);
export const getPlayer = (id) => request(`/players/${id}`);
export const listCompetitions = () => request('/competitions');
export const getCompetition = (id, season) => request(`/competitions/${id}${query({ season })}`);
export const setCompetitionEnabled = (id, isEnabled) =>
  request(`/competitions/${id}`, { method: 'PATCH', body: JSON.stringify({ isEnabled }) });
export const setFavourite = (type, id, on) =>
  request(`/favourites/${type}/${id}`, { method: on ? 'PUT' : 'DELETE' });
export const getSync = () => request('/sync');
export const runJob = (key) => request(`/sync/${key}/run`, { method: 'POST' });
