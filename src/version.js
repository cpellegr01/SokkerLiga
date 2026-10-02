/* The single source of truth for the running version.
 *
 * Bumped on every deploy. /api/health reports it, which is how a deploy is
 * verified as landed rather than assumed: if the live version still reads the
 * old number, the deploy did not take.
 *
 * Format: MAJOR.MINOR.BUILD — bump BUILD for a fix, MINOR for a feature.
 */
export const VERSION = '0.5.12';
