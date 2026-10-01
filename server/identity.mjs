/* Who is making this request.
 *
 * SokkerLiga does not sign anyone in. In production Caddy asks the Conforza
 * front door before every request and adds the answer as X-Conforza-User-*
 * headers; a request without them never reaches this process. Caddy also
 * strips any such headers a browser sends itself, and the API listens on
 * loopback only, so the headers cannot be forged from outside.
 *
 * In development there is no Caddy, so SOKKERLIGA_DEV_USER stands in.
 */

const now = () => new Date().toISOString();

const decode = (value) => {
  try {
    return decodeURIComponent(value ?? '');
  } catch {
    return '';
  }
};

export function identityFrom(headers, devUser = process.env.SOKKERLIGA_DEV_USER) {
  const id = headers['x-conforza-user-id'];
  if (id) {
    return {
      id,
      email: decode(headers['x-conforza-user-email']),
      display_name: decode(headers['x-conforza-user-name']),
      role_key: headers['x-conforza-user-role'] ?? '',
    };
  }
  if (devUser) {
    return { id: 'dev', email: devUser, display_name: 'Developer', role_key: 'administrator' };
  }
  return null;
}

/* Keep a local record of everyone who has used the app, so league data can
 * refer to people by id and still show a name. */
export function recordVisit(db, person) {
  db.prepare(`
    INSERT INTO people (user_id, email, display_name, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email, display_name = excluded.display_name,
      last_seen_at = excluded.last_seen_at`)
    .run(person.id, person.email, person.display_name, now(), now());
}
