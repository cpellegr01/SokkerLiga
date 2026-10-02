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

/* Analysis and predictions */
export const getAnalysis = (matchId) => request(`/matches/${matchId}/analysis`);
export const analyze = (matchId) => request(`/matches/${matchId}/analyze`, { method: 'POST' });
export const getSnapshot = (runId) => request(`/analysis-runs/${runId}/snapshot`);
export const listPredictions = (params = {}) => request(`/predictions${query(params)}`);
export const getThresholds = () => request('/settings/thresholds');
export const setThresholds = (t) => request('/settings/thresholds', { method: 'PUT', body: JSON.stringify(t) });
export const listMarketTypes = () => request('/market-types');

/* Betting apps, bets, settlement, history */
export const listSportsbooks = () => request('/sportsbooks');
export const saveSportsbook = (s) => (s.key
  ? request(`/sportsbooks/${s.key}`, { method: 'PUT', body: JSON.stringify(s) })
  : request('/sportsbooks', { method: 'POST', body: JSON.stringify(s) }));
export const listBets = (params = {}) => request(`/bets${query(params)}`);
export const getBet = (id) => request(`/bets/${id}`);
export const createBet = (bet) => request('/bets', { method: 'POST', body: JSON.stringify(bet) });
export const updateBet = (id, bet) => request(`/bets/${id}`, { method: 'PUT', body: JSON.stringify(bet) });
export const deleteBet = (id) => request(`/bets/${id}`, { method: 'DELETE' });
export const correctSettlement = (id, body) => request(`/bets/${id}/settlements`, { method: 'POST', body: JSON.stringify(body) });
export const getHistory = (params = {}) => request(`/history${query(params)}`);

/* Phase 4 and 5 */
export const getPerformance = (params = {}) => request(`/performance${query(params)}`);
export const getBankroll = () => request('/bankroll');
export const saveBankroll = (body) => request('/bankroll/settings', { method: 'PUT', body: JSON.stringify(body) });
export const addLedger = (body) => request('/bankroll/ledger', { method: 'POST', body: JSON.stringify(body) });
export const setClosingOdds = (betId, legId, closingOdds) =>
  request(`/bets/${betId}/legs/${legId}/closing`, { method: 'PUT', body: JSON.stringify({ closingOdds }) });
export const ask = (question) => request('/ask', { method: 'POST', body: JSON.stringify({ question }) });
export const matchPlayers = (id) => request(`/matches/${id}/players`);
export const useCalculatedResult = (id) => request(`/bets/${id}/calculated`, { method: 'POST' });
