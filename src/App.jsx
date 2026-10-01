import { useEffect, useState } from 'react';
import { VERSION } from './version.js';

/* Placeholder until the product is defined: proves that the front door's
 * sign-in reaches this app and that the API and database are wired up. */
export default function App() {
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/me')
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? 'The request failed.');
        setMe(body);
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <main className="placeholder">
      <h1>SokkerLiga</h1>
      {me && <p>Welcome, {me.user.display_name}.</p>}
      {error && <p className="error">{error}</p>}
      <p>Coming soon.</p>
      {me && <p><a href={me.frontDoor}>Back to your apps</a></p>}
      <p className="meta">Version {VERSION}</p>
    </main>
  );
}
