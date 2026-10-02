import { useEffect, useState } from 'react';

/* Hash routing: #/matches, #/match/12, #/team/4?tab=squad. Hash rather than
 * paths so every page is a plain link that survives a refresh, with no
 * server-side routing to keep in step. */
export function parseHash(hash = window.location.hash) {
  const [path, qs] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean);
  return { page: parts[0] ?? 'dashboard', id: parts[1] ?? null, params: Object.fromEntries(new URLSearchParams(qs)) };
}

export function useRoute() {
  const [route, setRoute] = useState(parseHash());
  useEffect(() => {
    const onChange = () => { setRoute(parseHash()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const href = (page, id, params) => {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  return `#/${page}${id !== undefined && id !== null ? `/${id}` : ''}${qs}`;
};

export const go = (page, id, params) => { window.location.hash = href(page, id, params); };
