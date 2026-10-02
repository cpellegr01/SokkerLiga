/* API-Football (api-sports.io, v3) — the football data provider.
 *
 * Two halves, kept apart on purpose:
 *  - createClient(): the only code that talks to the network. It stores every
 *    response in raw_payloads, counts quota, paces requests and retries.
 *  - normalise*(): pure functions turning the provider's JSON into SokkerLiga
 *    records. They never touch the database, so they are tested against
 *    sample responses without a key or a network.
 *
 * Response envelope: { get, parameters, errors, results, paging, response }.
 * `errors` is [] when fine and an object ({ plan: "...", token: "..." }) when
 * not — with HTTP 200, so the status code alone is not enough.
 */

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const SOURCE_KEY = 'api-football';
const BASE_URL = 'https://v3.football.api-sports.io';

/* The Pro plan allows 300 requests a minute; pacing at 250ms stays well
 * under it without making a backfill crawl. */
const MIN_INTERVAL_MS = 250;
const MAX_ATTEMPTS = 3;

export class ProviderError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const today = (now) => now().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {string} opts.apiKey
 * @param {typeof fetch} [opts.fetchImpl]  replaced in tests
 * @param {() => Date} [opts.now]
 * @param {number} [opts.minIntervalMs]
 */
export function createClient({ db, apiKey, fetchImpl = fetch, now = () => new Date(),
  minIntervalMs = MIN_INTERVAL_MS } = {}) {
  if (!apiKey) throw new ProviderError('No API-Football key is configured. Add API_FOOTBALL_KEY to the environment file.');

  let lastRequestAt = 0;
  let requestsThisRun = 0;

  const recordPayload = db.prepare(`
    INSERT INTO raw_payloads (source_key, endpoint, params_json, fetched_at, http_status, body_gz, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const bumpQuota = db.prepare(`
    INSERT INTO provider_quota (source_key, day, requests_used, daily_limit, remaining)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(source_key, day) DO UPDATE SET
      requests_used = requests_used + 1,
      daily_limit = COALESCE(excluded.daily_limit, daily_limit),
      remaining = COALESCE(excluded.remaining, remaining)`);

  /* The provider reports what is left for the day on every response; when
   * it says nothing is left, stop rather than burn requests on refusals. */
  function remainingToday() {
    const row = db.prepare('SELECT remaining FROM provider_quota WHERE source_key = ? AND day = ?')
      .get(SOURCE_KEY, today(now));
    return row?.remaining ?? null;
  }

  async function once(endpoint, params) {
    const wait = lastRequestAt + minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();

    const url = new URL(endpoint, BASE_URL);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    let res;
    try {
      res = await fetchImpl(url, { headers: { 'x-apisports-key': apiKey, accept: 'application/json' } });
    } catch (error) {
      throw new ProviderError(`Could not reach API-Football: ${error.message}`, { retryable: true });
    }
    requestsThisRun += 1;

    const text = await res.text();
    const fetchedAt = now().toISOString();
    recordPayload.run(SOURCE_KEY, endpoint, JSON.stringify(params), fetchedAt, res.status,
      gzipSync(text), createHash('sha256').update(text).digest('hex'));
    const header = (name) => {
      const value = Number(res.headers.get(name));
      return Number.isFinite(value) && res.headers.get(name) !== null ? value : null;
    };
    bumpQuota.run(SOURCE_KEY, today(now),
      header('x-ratelimit-requests-limit'), header('x-ratelimit-requests-remaining'));

    if (res.status === 429 || res.status >= 500) {
      throw new ProviderError(`API-Football answered ${res.status}.`, { status: res.status, retryable: true });
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('API-Football refused the key. Check API_FOOTBALL_KEY.', { status: res.status });
    }
    if (!res.ok) throw new ProviderError(`API-Football answered ${res.status}.`, { status: res.status });

    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new ProviderError('API-Football returned something that is not JSON.', { retryable: true });
    }
    const errors = body.errors;
    if (errors && !Array.isArray(errors) && Object.keys(errors).length) {
      const message = Object.values(errors).join(' ');
      /* "Too many requests" arrives as an error object with HTTP 200. */
      const retryable = /too many requests|rate ?limit/i.test(message);
      throw new ProviderError(`API-Football: ${message}`, { retryable });
    }
    return { body, fetchedAt };
  }

  async function request(endpoint, params = {}) {
    const remaining = remainingToday();
    if (remaining !== null && remaining <= 0) {
      throw new ProviderError('The API-Football daily quota is used up; waiting for tomorrow.');
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(endpoint, params);
      } catch (error) {
        if (!(error instanceof ProviderError) || !error.retryable || attempt >= MAX_ATTEMPTS) throw error;
        await sleep(1000 * 2 ** attempt);
      }
    }
  }

  /** Fetch every page of a paged endpoint; returns { items, fetchedAt }. */
  async function all(endpoint, params = {}) {
    const first = await request(endpoint, params);
    const items = [...(first.body.response ?? [])];
    const total = first.body.paging?.total ?? 1;
    for (let page = 2; page <= total; page += 1) {
      const next = await request(endpoint, { ...params, page });
      items.push(...(next.body.response ?? []));
    }
    return { items, fetchedAt: first.fetchedAt };
  }

  return {
    sourceKey: SOURCE_KEY,
    get requestsUsed() { return requestsThisRun; },

    leagues: (leagueId) => all('/leagues', { id: leagueId }),
    teams: (leagueId, season) => all('/teams', { league: leagueId, season }),
    fixtures: (leagueId, season) => all('/fixtures', { league: leagueId, season }),
    /* Up to 20 fixtures, each with its events, lineups, statistics and
     * player statistics included — the cheapest way to get match detail. */
    fixturesByIds: (ids) => all('/fixtures', { ids: ids.join('-') }),
    standings: (leagueId, season) => all('/standings', { league: leagueId, season }),
    squad: (teamId) => all('/players/squads', { team: teamId }),
    playerProfile: (playerId) => all('/players/profiles', { player: playerId }),
    injuries: (leagueId, season) => all('/injuries', { league: leagueId, season }),
  };
}

/* ------------------------------------------------------------ normalising */

const ref = (id) => (id === null || id === undefined ? null : String(id));
const int = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Math.trunc(Number(v)));
const blank = (v) => (v === null || v === undefined || v === '' ? null : v);

/* The provider's short status codes, grouped into ours. */
const STATUS = {
  TBD: 'scheduled', NS: 'scheduled',
  '1H': 'live', HT: 'live', '2H': 'live', ET: 'live', BT: 'live', P: 'live', LIVE: 'live', INT: 'live',
  FT: 'finished', AET: 'finished', PEN: 'finished',
  PST: 'postponed', SUSP: 'suspended', CANC: 'cancelled', ABD: 'abandoned', AWD: 'awarded', WO: 'awarded',
};

export function statusKey(short) {
  return STATUS[short] ?? 'scheduled';
}

/** '2026' for calendar-year leagues, '2026/27' for split seasons. */
export function seasonLabel(year, start, end) {
  if (start && end && start.slice(0, 4) !== end.slice(0, 4)) {
    return `${year}/${String(Number(year) + 1).slice(2)}`;
  }
  return String(year);
}

export function normaliseLeague(item) {
  return {
    sourceRef: ref(item.league?.id),
    name: item.league?.name,
    type: item.league?.type,
    logoUrl: blank(item.league?.logo),
    countryName: item.country?.name ?? null,
    flagUrl: blank(item.country?.flag),
    seasons: (item.seasons ?? []).map((s) => ({
      year: s.year,
      label: seasonLabel(s.year, s.start, s.end),
      start: s.start ?? null,
      end: s.end ?? null,
      current: !!s.current,
      coverage: s.coverage ?? {},
    })),
  };
}

export function normaliseTeam(item) {
  const t = item.team ?? {};
  const v = item.venue ?? {};
  return {
    team: {
      sourceRef: ref(t.id),
      name: t.name,
      code: blank(t.code),
      countryName: blank(t.country),
      founded: int(t.founded),
      isNational: t.national ? 1 : 0,
      logoUrl: blank(t.logo),
    },
    venue: v.id ? {
      sourceRef: ref(v.id),
      name: v.name,
      address: blank(v.address),
      city: blank(v.city),
      capacity: int(v.capacity),
      surface: blank(v.surface),
      imageUrl: blank(v.image),
    } : null,
  };
}

const EVENT_TYPES = [
  [(t, d) => t === 'goal' && /own goal/.test(d), 'own_goal'],
  [(t, d) => t === 'goal' && /missed penalty/.test(d), 'missed_penalty'],
  [(t, d) => t === 'goal' && /penalty/.test(d), 'penalty_goal'],
  [(t) => t === 'goal', 'goal'],
  [(t, d) => t === 'card' && /second yellow/.test(d), 'second_yellow'],
  [(t, d) => t === 'card' && /red/.test(d), 'red'],
  [(t, d) => t === 'card' && /yellow/.test(d), 'yellow'],
  [(t) => t === 'subst', 'sub'],
  [(t) => t === 'var', 'var'],
];

export function eventTypeKey(type, detail) {
  const t = String(type ?? '').toLowerCase();
  const d = String(detail ?? '').toLowerCase();
  return EVENT_TYPES.find(([test]) => test(t, d))?.[1] ?? 'other';
}

/** A statistic value as a number: '32%' → 32, '1.23' → 1.23, null stays null. */
export function statValue(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return value;
  const n = Number(String(value).replace('%', '').trim());
  return Number.isFinite(n) ? n : null;
}

const person = (p) => (p?.id ? { sourceRef: ref(p.id), name: p.name ?? null, photoUrl: blank(p.photo) } : null);

/** A /fixtures item. Details (events, lineups, statistics, players) are
 *  present only when fetched by id, and come back as null otherwise. */
export function normaliseFixture(item) {
  const f = item.fixture ?? {};
  const score = item.score ?? {};
  const hasDetails = Array.isArray(item.events) || Array.isArray(item.lineups)
    || Array.isArray(item.statistics) || Array.isArray(item.players);

  return {
    sourceRef: ref(f.id),
    leagueRef: ref(item.league?.id),
    seasonYear: item.league?.season ?? null,
    round: item.league?.round === undefined || item.league?.round === null ? null : String(item.league.round),
    kickoffUtc: f.timestamp ? new Date(f.timestamp * 1000).toISOString() : new Date(f.date).toISOString(),
    referee: blank(f.referee),
    venue: f.venue?.id ? { sourceRef: ref(f.venue.id), name: f.venue.name ?? null, city: f.venue.city ?? null }
      : { sourceRef: null, name: f.venue?.name ?? null, city: f.venue?.city ?? null },
    statusKey: statusKey(f.status?.short),
    statusDetail: f.status?.short ?? null,
    elapsed: int(f.status?.elapsed),
    home: { sourceRef: ref(item.teams?.home?.id), name: item.teams?.home?.name, logoUrl: blank(item.teams?.home?.logo) },
    away: { sourceRef: ref(item.teams?.away?.id), name: item.teams?.away?.name, logoUrl: blank(item.teams?.away?.logo) },
    /* goals = the score at the end of play, including any extra time but
     * not a shoot-out (live while the match is on). Regular time is goals
     * minus the extra-time goals, stored separately below. */
    homeGoals: int(item.goals?.home),
    awayGoals: int(item.goals?.away),
    homeHt: int(score.halftime?.home),
    awayHt: int(score.halftime?.away),
    homeEt: int(score.extratime?.home),
    awayEt: int(score.extratime?.away),
    homePens: int(score.penalty?.home),
    awayPens: int(score.penalty?.away),
    details: hasDetails ? {
      events: (item.events ?? []).map((e, seq) => ({
        seq,
        minute: int(e.time?.elapsed),
        extraMinute: int(e.time?.extra),
        teamRef: ref(e.team?.id),
        player: person(e.player),
        assist: person(e.assist),
        typeKey: eventTypeKey(e.type, e.detail),
        detail: blank(e.detail),
        comments: blank(e.comments),
      })),
      lineups: (item.lineups ?? []).map((l) => ({
        teamRef: ref(l.team?.id),
        formation: blank(l.formation),
        coach: person(l.coach),
        players: [
          ...(l.startXI ?? []).map((p) => ({ ...lineupPlayer(p.player), role: 'starter' })),
          ...(l.substitutes ?? []).map((p) => ({ ...lineupPlayer(p.player), role: 'sub' })),
        ].filter((p) => p.sourceRef),
      })),
      teamStats: (item.statistics ?? []).map((s) => ({
        teamRef: ref(s.team?.id),
        stats: (s.statistics ?? []).map((st) => ({ label: st.type, value: statValue(st.value) })),
      })),
      playerStats: (item.players ?? []).flatMap((block) => (block.players ?? []).map((p) => {
        const s = p.statistics?.[0] ?? {};
        return {
          teamRef: ref(block.team?.id),
          player: person(p.player),
          minutes: int(s.games?.minutes),
          position: blank(s.games?.position),
          rating: s.games?.rating ? Number(s.games.rating) : null,
          isCaptain: s.games?.captain ? 1 : 0,
          isSubstitute: s.games?.substitute ? 1 : 0,
          goals: int(s.goals?.total),
          assists: int(s.goals?.assists),
          goalsConceded: int(s.goals?.conceded),
          saves: int(s.goals?.saves),
          shots: int(s.shots?.total),
          shotsOnTarget: int(s.shots?.on),
          passes: int(s.passes?.total),
          keyPasses: int(s.passes?.key),
          passAccuracy: statValue(s.passes?.accuracy),
          tackles: int(s.tackles?.total),
          interceptions: int(s.tackles?.interceptions),
          duels: int(s.duels?.total),
          duelsWon: int(s.duels?.won),
          dribbles: int(s.dribbles?.attempts),
          dribblesWon: int(s.dribbles?.success),
          foulsDrawn: int(s.fouls?.drawn),
          foulsCommitted: int(s.fouls?.committed),
          yellow: int(s.cards?.yellow),
          red: int(s.cards?.red),
          offsides: int(s.offsides),
          penaltiesScored: int(s.penalty?.scored),
          penaltiesMissed: int(s.penalty?.missed),
          penaltiesSaved: int(s.penalty?.saved),
        };
      }).filter((p) => p.player)),
    } : null,
  };
}

function lineupPlayer(p = {}) {
  return {
    sourceRef: ref(p.id),
    name: p.name ?? null,
    shirtNumber: int(p.number),
    position: blank(p.pos),
    grid: blank(p.grid),
  };
}

export function normaliseStandings(item) {
  const league = item.league ?? {};
  return {
    leagueRef: ref(league.id),
    seasonYear: league.season ?? null,
    rows: (league.standings ?? []).flatMap((group) => group.map((r) => ({
      groupName: r.group && r.group !== league.name ? r.group : '',
      teamRef: ref(r.team?.id),
      team: { sourceRef: ref(r.team?.id), name: r.team?.name, logoUrl: blank(r.team?.logo) },
      asOf: r.update ? new Date(r.update).toISOString() : null,
      position: int(r.rank),
      points: int(r.points),
      goalDiff: int(r.goalsDiff),
      form: blank(r.form),
      description: blank(r.description),
      all: wdl(r.all),
      home: wdl(r.home),
      away: wdl(r.away),
    }))),
  };
}

function wdl(x = {}) {
  return {
    played: int(x.played), won: int(x.win), drawn: int(x.draw), lost: int(x.lose),
    goalsFor: int(x.goals?.for), goalsAgainst: int(x.goals?.against),
  };
}

export function normaliseSquad(item) {
  return {
    teamRef: ref(item.team?.id),
    players: (item.players ?? []).map((p) => ({
      sourceRef: ref(p.id),
      name: p.name,
      shirtNumber: int(p.number),
      position: blank(p.position),
      photoUrl: blank(p.photo),
    })).filter((p) => p.sourceRef),
  };
}

/** '185 cm' → 185 */
export function heightCm(value) {
  const n = int(String(value ?? '').replace(/[^0-9]/g, ''));
  return n && n > 100 && n < 230 ? n : null;
}

export function normalisePlayerProfile(item) {
  const p = item.player ?? {};
  return {
    sourceRef: ref(p.id),
    name: p.name,
    firstName: blank(p.firstname),
    lastName: blank(p.lastname),
    birthDate: blank(p.birth?.date),
    nationality: blank(p.nationality),
    heightCm: heightCm(p.height),
    position: blank(p.position),
    photoUrl: blank(p.photo),
  };
}

/** An /injuries item: a player reported missing or doubtful for a fixture. */
export function normaliseInjury(item) {
  const type = String(item.player?.type ?? '').toLowerCase();
  return {
    player: { sourceRef: ref(item.player?.id), name: item.player?.name, photoUrl: blank(item.player?.photo) },
    teamRef: ref(item.team?.id),
    fixtureRef: ref(item.fixture?.id),
    status: type.includes('question') || type.includes('doubt') ? 'doubtful' : 'missing',
    reason: blank(item.player?.reason),
  };
}
