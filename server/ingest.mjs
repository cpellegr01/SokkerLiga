/* Writing provider records into the database.
 *
 * Every function here takes records already normalised by a provider module
 * and is idempotent: importing the same records twice changes nothing.
 *
 * History is never overwritten silently. When a provider changes something
 * already stored — a kickoff time, a score, the event list, a statistic —
 * the previous values are copied to match_revisions (or
 * team_match_stats_revisions) before the row changes. Squads open and close
 * dated rows instead of deleting players.
 */

const now = () => new Date().toISOString();

/* ------------------------------------------------------------- identity */

function link(db, entityType, entityId, sourceKey, sourceRef) {
  db.prepare(`INSERT INTO external_ids (entity_type, entity_id, source_key, source_ref)
              VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`)
    .run(entityType, entityId, sourceKey, sourceRef);
}

const idFor = (db, table, sourceKey, sourceRef) =>
  db.prepare(`SELECT id FROM ${table} WHERE source_key = ? AND source_ref = ?`).get(sourceKey, sourceRef)?.id ?? null;

/* COALESCE(excluded.x, x): a provider response that omits a field never
 * blanks out what an earlier, fuller response stored. */
export function upsertVenue(db, sourceKey, v, fetchedAt) {
  if (!v?.sourceRef) return null;
  db.prepare(`
    INSERT INTO venues (name, address, city, capacity, surface, image_url, source_key, source_ref, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_ref) DO UPDATE SET
      name = COALESCE(excluded.name, name), address = COALESCE(excluded.address, address),
      city = COALESCE(excluded.city, city), capacity = COALESCE(excluded.capacity, capacity),
      surface = COALESCE(excluded.surface, surface), image_url = COALESCE(excluded.image_url, image_url),
      fetched_at = excluded.fetched_at`)
    .run(v.name ?? 'Unknown venue', v.address ?? null, v.city ?? null, v.capacity ?? null,
      v.surface ?? null, v.imageUrl ?? null, sourceKey, v.sourceRef, fetchedAt);
  const id = idFor(db, 'venues', sourceKey, v.sourceRef);
  link(db, 'venue', id, sourceKey, v.sourceRef);
  return id;
}

export function upsertTeam(db, sourceKey, t, fetchedAt, venueId = null) {
  if (!t?.sourceRef) return null;
  db.prepare(`
    INSERT INTO teams (name, code, country_name, founded, is_national, logo_url, venue_id, source_key, source_ref, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_ref) DO UPDATE SET
      name = COALESCE(excluded.name, name), code = COALESCE(excluded.code, code),
      country_name = COALESCE(excluded.country_name, country_name),
      founded = COALESCE(excluded.founded, founded),
      is_national = COALESCE(excluded.is_national, is_national),
      logo_url = COALESCE(excluded.logo_url, logo_url),
      venue_id = COALESCE(excluded.venue_id, venue_id),
      fetched_at = excluded.fetched_at`)
    .run(t.name ?? 'Unknown team', t.code ?? null, t.countryName ?? null, t.founded ?? null,
      t.isNational ?? 0, t.logoUrl ?? null, venueId, sourceKey, t.sourceRef, fetchedAt);
  const id = idFor(db, 'teams', sourceKey, t.sourceRef);
  link(db, 'team', id, sourceKey, t.sourceRef);
  return id;
}

export function upsertPlayer(db, sourceKey, p, fetchedAt) {
  if (!p?.sourceRef) return null;
  db.prepare(`
    INSERT INTO players (name, first_name, last_name, birth_date, nationality, height_cm, position, photo_url,
                         source_key, source_ref, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_ref) DO UPDATE SET
      name = COALESCE(excluded.name, name),
      first_name = COALESCE(excluded.first_name, first_name),
      last_name = COALESCE(excluded.last_name, last_name),
      birth_date = COALESCE(excluded.birth_date, birth_date),
      nationality = COALESCE(excluded.nationality, nationality),
      height_cm = COALESCE(excluded.height_cm, height_cm),
      position = COALESCE(excluded.position, position),
      photo_url = COALESCE(excluded.photo_url, photo_url),
      fetched_at = excluded.fetched_at`)
    .run(p.name ?? 'Unknown player', p.firstName ?? null, p.lastName ?? null, p.birthDate ?? null,
      p.nationality ?? null, p.heightCm ?? null, p.position ?? null, p.photoUrl ?? null,
      sourceKey, p.sourceRef, fetchedAt);
  const id = idFor(db, 'players', sourceKey, p.sourceRef);
  link(db, 'player', id, sourceKey, p.sourceRef);
  return id;
}

function upsertManager(db, sourceKey, m, fetchedAt) {
  if (!m?.sourceRef) return null;
  db.prepare(`
    INSERT INTO managers (name, photo_url, source_key, source_ref, fetched_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_key, source_ref) DO UPDATE SET
      name = COALESCE(excluded.name, name), photo_url = COALESCE(excluded.photo_url, photo_url),
      fetched_at = excluded.fetched_at`)
    .run(m.name ?? 'Unknown manager', m.photoUrl ?? null, sourceKey, m.sourceRef, fetchedAt);
  return idFor(db, 'managers', sourceKey, m.sourceRef);
}

/* A manager seen in a lineup opens a spell; a different manager for the
 * same team closes the previous one at that match's kickoff. */
function recordManagerSpell(db, teamId, managerId, at) {
  const open = db.prepare('SELECT manager_id, valid_from FROM team_managers WHERE team_id = ? AND valid_to IS NULL')
    .get(teamId);
  if (open?.manager_id === managerId) return;
  if (open && open.valid_from > at) return; // an older match being backfilled; leave current spells alone
  if (open) {
    db.prepare('UPDATE team_managers SET valid_to = ? WHERE team_id = ? AND manager_id = ? AND valid_from = ?')
      .run(at, teamId, open.manager_id, open.valid_from);
  }
  db.prepare('INSERT OR IGNORE INTO team_managers (team_id, manager_id, valid_from) VALUES (?, ?, ?)')
    .run(teamId, managerId, at);
}

/* --------------------------------------------------------- competitions */

export function importLeague(db, competitionId, league, fetchedAt) {
  db.prepare('UPDATE competitions SET logo_url = COALESCE(?, logo_url), flag_url = COALESCE(?, flag_url) WHERE id = ?')
    .run(league.logoUrl, league.flagUrl, competitionId);
  const upsert = db.prepare(`
    INSERT INTO seasons (competition_id, year, label, start_date, end_date, is_current, coverage_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(competition_id, year) DO UPDATE SET
      label = excluded.label, start_date = excluded.start_date, end_date = excluded.end_date,
      is_current = excluded.is_current, coverage_json = excluded.coverage_json, fetched_at = excluded.fetched_at`);
  for (const s of league.seasons) {
    upsert.run(competitionId, s.year, s.label, s.start, s.end, s.current ? 1 : 0,
      JSON.stringify(s.coverage), fetchedAt);
  }
  return league.seasons.length;
}

export function importTeams(db, sourceKey, seasonId, records, fetchedAt) {
  let written = 0;
  for (const { team, venue } of records) {
    const venueId = upsertVenue(db, sourceKey, venue, fetchedAt);
    const teamId = upsertTeam(db, sourceKey, team, fetchedAt, venueId);
    if (!teamId) continue;
    db.prepare('INSERT OR IGNORE INTO season_teams (season_id, team_id) VALUES (?, ?)').run(seasonId, teamId);
    written += 1;
  }
  return written;
}

/* -------------------------------------------------------------- matches */

/* The fields whose change is recorded as a revision. Elapsed minutes tick
 * every minute of a live match and are not worth a revision each. */
const TRACKED = ['kickoff_utc', 'status_key', 'home_goals', 'away_goals', 'home_ht', 'away_ht',
  'home_et', 'away_et', 'home_pens', 'away_pens', 'referee', 'round', 'venue_name'];

/* A result counts as confirmed once it is final and was seen at least three
 * hours after kickoff — late enough for the provider's own corrections. */
const CONFIRM_AFTER_MS = 3 * 3600_000;

export function importFixture(db, sourceKey, seasonId, f, fetchedAt) {
  const homeId = upsertTeam(db, sourceKey, f.home, fetchedAt);
  const awayId = upsertTeam(db, sourceKey, f.away, fetchedAt);
  if (!homeId || !awayId || !f.sourceRef) return null;
  db.prepare('INSERT OR IGNORE INTO season_teams (season_id, team_id) VALUES (?, ?)').run(seasonId, homeId);
  db.prepare('INSERT OR IGNORE INTO season_teams (season_id, team_id) VALUES (?, ?)').run(seasonId, awayId);
  const venueId = upsertVenue(db, sourceKey, f.venue, fetchedAt);

  const next = {
    season_id: seasonId, round: f.round, kickoff_utc: f.kickoffUtc, venue_id: venueId,
    venue_name: f.venue?.name ?? null, venue_city: f.venue?.city ?? null,
    home_team_id: homeId, away_team_id: awayId, status_key: f.statusKey, status_detail: f.statusDetail,
    elapsed: f.elapsed, home_goals: f.homeGoals, away_goals: f.awayGoals, home_ht: f.homeHt, away_ht: f.awayHt,
    home_et: f.homeEt, away_et: f.awayEt, home_pens: f.homePens, away_pens: f.awayPens, referee: f.referee,
  };

  const isFinal = db.prepare('SELECT is_final FROM match_statuses WHERE key = ?').get(f.statusKey)?.is_final;
  const confirmed = isFinal && Date.parse(fetchedAt) - Date.parse(f.kickoffUtc) >= CONFIRM_AFTER_MS;

  const existing = db.prepare('SELECT * FROM matches WHERE source_key = ? AND source_ref = ?').get(sourceKey, f.sourceRef);
  if (!existing) {
    const cols = Object.keys(next);
    const info = db.prepare(`
      INSERT INTO matches (${cols.join(', ')}, result_confirmed_at, source_key, source_ref, fetched_at)
      VALUES (${cols.map(() => '?').join(', ')}, ?, ?, ?, ?)`)
      .run(...cols.map((c) => next[c]), confirmed ? fetchedAt : null, sourceKey, f.sourceRef, fetchedAt);
    const id = Number(info.lastInsertRowid);
    link(db, 'match', id, sourceKey, f.sourceRef);
    return { id, created: true, changed: true };
  }

  const changed = TRACKED.filter((c) => (existing[c] ?? null) !== (next[c] ?? null));
  if (changed.length) {
    const old = Object.fromEntries(changed.map((c) => [c, existing[c]]));
    db.prepare('INSERT INTO match_revisions (match_id, changed_at, fields, old_json) VALUES (?, ?, ?, ?)')
      .run(existing.id, fetchedAt, changed.join(','), JSON.stringify(old));
  }
  /* A confirmation stands unless the result itself changes afterwards. */
  const resultChanged = changed.some((c) => c.startsWith('home_') || c.startsWith('away_') || c === 'status_key');
  const confirmedAt = resultChanged ? (confirmed ? fetchedAt : null)
    : (existing.result_confirmed_at ?? (confirmed ? fetchedAt : null));

  const cols = Object.keys(next);
  db.prepare(`UPDATE matches SET ${cols.map((c) => `${c} = ?`).join(', ')}, result_confirmed_at = ?, fetched_at = ?
              WHERE id = ?`)
    .run(...cols.map((c) => next[c]), confirmedAt, fetchedAt, existing.id);
  return { id: existing.id, created: false, changed: changed.length > 0 };
}

/* ------------------------------------------------------- match details */

const teamIdByRef = (db, sourceKey, sourceRef) => (sourceRef ? idFor(db, 'teams', sourceKey, sourceRef) : null);

function statKeyFor(db, label) {
  const row = db.prepare('SELECT key FROM stat_types WHERE provider_label = ?').get(label);
  if (row) return row.key;
  /* A statistic the provider has added since the seed was written: keep it
   * under its own label rather than drop it. */
  const key = String(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const ordinal = (db.prepare('SELECT MAX(ordinal) AS m FROM stat_types').get().m ?? 0) + 1;
  db.prepare('INSERT OR IGNORE INTO stat_types (key, name, unit, provider_label, ordinal) VALUES (?, ?, ?, ?, ?)')
    .run(key, label, 'count', label, ordinal);
  return db.prepare('SELECT key FROM stat_types WHERE provider_label = ?').get(label)?.key ?? key;
}

export function importFixtureDetails(db, sourceKey, matchId, d, fetchedAt) {
  const match = db.prepare('SELECT kickoff_utc FROM matches WHERE id = ?').get(matchId);
  let written = 0;

  /* Events: the provider sends the whole list each time. If it differs from
   * what is stored, the old list is kept as a revision and replaced. */
  const oldEvents = db.prepare(`SELECT seq, minute, extra_minute, team_id, player_name, assist_name, type_key, detail
                                FROM match_events WHERE match_id = ? ORDER BY seq`).all(matchId);
  const newEvents = d.events.map((e) => {
    const playerId = upsertPlayer(db, sourceKey, e.player, fetchedAt);
    const assistId = upsertPlayer(db, sourceKey, e.assist, fetchedAt);
    return { ...e, teamId: teamIdByRef(db, sourceKey, e.teamRef), playerId, assistId };
  });
  const comparable = (rows) => JSON.stringify(rows.map((e) => [e.minute, e.extra_minute ?? e.extraMinute ?? null,
    e.team_id ?? e.teamId ?? null, e.player_name ?? e.player?.name ?? null, e.type_key ?? e.typeKey, e.detail ?? null]));
  if (comparable(oldEvents) !== comparable(newEvents)) {
    if (oldEvents.length) {
      db.prepare('INSERT INTO match_revisions (match_id, changed_at, fields, old_json) VALUES (?, ?, ?, ?)')
        .run(matchId, fetchedAt, 'events', JSON.stringify(oldEvents));
    }
    db.prepare('DELETE FROM match_events WHERE match_id = ?').run(matchId);
    const insert = db.prepare(`
      INSERT INTO match_events (match_id, seq, minute, extra_minute, team_id, player_id, player_name,
                                assist_player_id, assist_name, type_key, detail, comments, source_key, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of newEvents) {
      insert.run(matchId, e.seq, e.minute, e.extraMinute, e.teamId, e.playerId, e.player?.name ?? null,
        e.assistId, e.assist?.name ?? null, e.typeKey, e.detail, e.comments, sourceKey, fetchedAt);
      written += 1;
    }
  }

  /* Lineups: one row per team plus its players. */
  for (const l of d.lineups) {
    const teamId = teamIdByRef(db, sourceKey, l.teamRef);
    if (!teamId) continue;
    const managerId = upsertManager(db, sourceKey, l.coach, fetchedAt);
    if (managerId) recordManagerSpell(db, teamId, managerId, match.kickoff_utc);
    db.prepare(`
      INSERT INTO lineups (match_id, team_id, formation, status, manager_id, fetched_at) VALUES (?, ?, ?, 'confirmed', ?, ?)
      ON CONFLICT(match_id, team_id) DO UPDATE SET formation = excluded.formation, status = excluded.status,
        manager_id = COALESCE(excluded.manager_id, manager_id), fetched_at = excluded.fetched_at`)
      .run(matchId, teamId, l.formation, managerId, fetchedAt);
    db.prepare('DELETE FROM lineup_players WHERE match_id = ? AND team_id = ?').run(matchId, teamId);
    const insert = db.prepare(`INSERT OR REPLACE INTO lineup_players
      (match_id, team_id, player_id, role, position, grid, shirt_number) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const p of l.players) {
      const playerId = upsertPlayer(db, sourceKey, { sourceRef: p.sourceRef, name: p.name }, fetchedAt);
      insert.run(matchId, teamId, playerId, p.role, p.position, p.grid, p.shirtNumber);
      written += 1;
    }
  }

  /* Team statistics: a changed value keeps its old value as a revision. */
  for (const block of d.teamStats) {
    const teamId = teamIdByRef(db, sourceKey, block.teamRef);
    if (!teamId) continue;
    for (const s of block.stats) {
      if (!s.label) continue;
      const statKey = statKeyFor(db, s.label);
      const old = db.prepare('SELECT value FROM team_match_stats WHERE match_id = ? AND team_id = ? AND stat_key = ?')
        .get(matchId, teamId, statKey);
      if (old && (old.value ?? null) === (s.value ?? null)) continue;
      if (old) {
        db.prepare(`INSERT INTO team_match_stats_revisions (match_id, team_id, stat_key, old_value, changed_at)
                    VALUES (?, ?, ?, ?, ?)`).run(matchId, teamId, statKey, old.value, fetchedAt);
      }
      db.prepare(`INSERT INTO team_match_stats (match_id, team_id, stat_key, value, source_key, fetched_at)
                  VALUES (?, ?, ?, ?, ?, ?)
                  ON CONFLICT(match_id, team_id, stat_key) DO UPDATE SET value = excluded.value,
                    fetched_at = excluded.fetched_at`)
        .run(matchId, teamId, statKey, s.value, sourceKey, fetchedAt);
      written += 1;
    }
  }

  /* Player statistics: providers revise ratings and minutes after the match,
   * so a changed row keeps its old values as a revision. */
  const PS = ['minutes', 'position', 'rating', 'is_captain', 'is_substitute', 'goals', 'assists', 'goals_conceded',
    'saves', 'shots', 'shots_on_target', 'passes', 'key_passes', 'pass_accuracy', 'tackles', 'interceptions',
    'duels', 'duels_won', 'dribbles', 'dribbles_won', 'fouls_drawn', 'fouls_committed', 'yellow', 'red',
    'offsides', 'penalties_scored', 'penalties_missed', 'penalties_saved'];
  const camel = (c) => c.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
  const fieldFor = { is_captain: 'isCaptain', is_substitute: 'isSubstitute' };
  for (const p of d.playerStats) {
    const teamId = teamIdByRef(db, sourceKey, p.teamRef);
    const playerId = upsertPlayer(db, sourceKey, p.player, fetchedAt);
    if (!teamId || !playerId) continue;
    const values = PS.map((c) => p[fieldFor[c] ?? camel(c)] ?? null);
    const old = db.prepare('SELECT * FROM player_match_stats WHERE match_id = ? AND player_id = ?').get(matchId, playerId);
    if (old && PS.every((c, i) => (old[c] ?? null) === values[i])) continue;
    if (old) {
      db.prepare('INSERT INTO match_revisions (match_id, changed_at, fields, old_json) VALUES (?, ?, ?, ?)')
        .run(matchId, fetchedAt, `player_stats:${playerId}`,
          JSON.stringify(Object.fromEntries(PS.map((c) => [c, old[c]]))));
    }
    db.prepare(`
      INSERT INTO player_match_stats (match_id, player_id, team_id, ${PS.join(', ')}, source_key, fetched_at)
      VALUES (?, ?, ?, ${PS.map(() => '?').join(', ')}, ?, ?)
      ON CONFLICT(match_id, player_id) DO UPDATE SET team_id = excluded.team_id,
        ${PS.map((c) => `${c} = excluded.${c}`).join(', ')}, fetched_at = excluded.fetched_at`)
      .run(matchId, playerId, teamId, ...values, sourceKey, fetchedAt);
    written += 1;
  }

  db.prepare('UPDATE matches SET details_fetched_at = ? WHERE id = ?').run(fetchedAt, matchId);
  return written;
}

/* ------------------------------------------------------------ standings */

/* Rows are only added when the provider's "updated" time is new, so
 * re-importing an unchanged table adds nothing. */
export function importStandings(db, sourceKey, seasonId, rows, fetchedAt) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO standings (season_id, group_name, team_id, as_of, position, played, won, drawn, lost,
      goals_for, goals_against, goal_diff, points, form, description,
      home_played, home_won, home_drawn, home_lost, home_goals_for, home_goals_against,
      away_played, away_won, away_drawn, away_lost, away_goals_for, away_goals_against, source_key, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  let written = 0;
  for (const r of rows) {
    const teamId = upsertTeam(db, sourceKey, r.team, fetchedAt);
    if (!teamId) continue;
    const info = insert.run(seasonId, r.groupName, teamId, r.asOf ?? fetchedAt, r.position,
      r.all.played, r.all.won, r.all.drawn, r.all.lost, r.all.goalsFor, r.all.goalsAgainst, r.goalDiff, r.points,
      r.form, r.description,
      r.home.played, r.home.won, r.home.drawn, r.home.lost, r.home.goalsFor, r.home.goalsAgainst,
      r.away.played, r.away.won, r.away.drawn, r.away.lost, r.away.goalsFor, r.away.goalsAgainst,
      sourceKey, fetchedAt);
    written += Number(info.changes);
  }
  return written;
}

/* --------------------------------------------------------------- squads */

/* The squad as the provider lists it today. Players new to it open a roster
 * row; players no longer in it have theirs closed, never deleted. */
export function importSquad(db, sourceKey, teamId, players, fetchedAt) {
  const seen = new Set();
  let written = 0;
  for (const p of players) {
    const playerId = upsertPlayer(db, sourceKey,
      { sourceRef: p.sourceRef, name: p.name, position: p.position, photoUrl: p.photoUrl }, fetchedAt);
    if (!playerId) continue;
    seen.add(playerId);
    const open = db.prepare('SELECT id, shirt_number, position FROM team_rosters WHERE team_id = ? AND player_id = ? AND valid_to IS NULL')
      .get(teamId, playerId);
    if (open) {
      if ((open.shirt_number ?? null) !== (p.shirtNumber ?? null) || (open.position ?? null) !== (p.position ?? null)) {
        db.prepare('UPDATE team_rosters SET valid_to = ? WHERE id = ?').run(fetchedAt, open.id);
      } else {
        continue;
      }
    }
    db.prepare(`INSERT INTO team_rosters (team_id, player_id, shirt_number, position, valid_from)
                VALUES (?, ?, ?, ?, ?)`).run(teamId, playerId, p.shirtNumber, p.position, fetchedAt);
    written += 1;
  }
  /* An empty answer is more likely a provider gap than a team with no
   * players; closing every row on it would wipe the squad. */
  if (players.length) {
    for (const row of db.prepare('SELECT id, player_id FROM team_rosters WHERE team_id = ? AND valid_to IS NULL').all(teamId)) {
      if (!seen.has(row.player_id)) {
        db.prepare('UPDATE team_rosters SET valid_to = ? WHERE id = ?').run(fetchedAt, row.id);
        written += 1;
      }
    }
  }
  return written;
}

export function importPlayerProfile(db, sourceKey, profile, fetchedAt) {
  const id = upsertPlayer(db, sourceKey, profile, fetchedAt);
  if (id) db.prepare('UPDATE players SET profiled_at = ? WHERE id = ?').run(fetchedAt, id);
  return id;
}

/* ------------------------------------------------------------- injuries */

export function importInjuries(db, sourceKey, records, fetchedAt) {
  let written = 0;
  for (const r of records) {
    const matchId = r.fixtureRef ? idFor(db, 'matches', sourceKey, r.fixtureRef) : null;
    const teamId = teamIdByRef(db, sourceKey, r.teamRef);
    if (!matchId || !teamId) continue; // the fixture is not in an enabled competition
    const playerId = upsertPlayer(db, sourceKey, r.player, fetchedAt);
    if (!playerId) continue;
    db.prepare(`
      INSERT INTO availability (player_id, team_id, match_id, status, reason, first_reported_at, last_reported_at, source_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(player_id, match_id, source_key) DO UPDATE SET
        status = excluded.status, reason = COALESCE(excluded.reason, reason),
        last_reported_at = excluded.last_reported_at`)
      .run(playerId, teamId, matchId, r.status, r.reason, fetchedAt, fetchedAt, sourceKey);
    written += 1;
  }
  return written;
}

export { now as timestamp, idFor };
