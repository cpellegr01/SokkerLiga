/* Plain-English names for selections. Shared by the server (for Claude's
 * candidate list) and the UI, so both say the same thing. */

const signed = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${Math.abs(x)}` : '0');

/* Player markets key the selection as 'p:<player id>'; pass the player's
 * name as `playerName` to label it. */
export function selectionLabel(market, line, selection, home, away, playerName = null) {
  switch (market) {
    case 'anytime_scorer':
      return `${playerName ?? 'Player'} to score`;
    case 'match_result':
      return selection === 'home' ? `${home} to win` : selection === 'away' ? `${away} to win` : 'Draw';
    case 'double_chance':
      return { home_draw: `${home} or draw`, home_away: `${home} or ${away}`, draw_away: `Draw or ${away}` }[selection];
    case 'draw_no_bet':
      return `${selection === 'home' ? home : away} (draw no bet)`;
    case 'over_under':
      return `${selection === 'over' ? 'Over' : 'Under'} ${line} goals`;
    case 'btts':
      return selection === 'yes' ? 'Both teams to score' : 'Not both teams to score';
    case 'asian_handicap':
      return selection === 'home' ? `${home} ${signed(line)}` : `${away} ${signed(-line)}`;
    case 'european_handicap':
      if (selection === 'draw') return `Draw (${home} ${signed(line)}, 3-way)`;
      return selection === 'home' ? `${home} ${signed(line)} (3-way)` : `${away} ${signed(-line)} (3-way)`;
    case 'home_total':
      return `${home} ${selection === 'over' ? 'over' : 'under'} ${line} goals`;
    case 'away_total':
      return `${away} ${selection === 'over' ? 'over' : 'under'} ${line} goals`;
    case 'corners_ou':
      return `${selection === 'over' ? 'Over' : 'Under'} ${line} corners`;
    case 'cards_ou':
      return `${selection === 'over' ? 'Over' : 'Under'} ${line} cards`;
    default:
      return `${market} ${line ?? ''} ${selection}`.trim();
  }
}

export const CONFIDENCE_LABEL = { low: 'Low', medium: 'Medium', high: 'High' };
export const STANCE_LABEL = { support: 'Supports', caution: 'Cautious', oppose: 'Disagrees' };

/* For the bet slip: every market, whether it has a line, and its choices. */
export const MARKET_OPTIONS = [
  { key: 'match_result', name: 'Match result (1X2)', line: false, selections: ['home', 'draw', 'away'] },
  { key: 'double_chance', name: 'Double chance', line: false, selections: ['home_draw', 'home_away', 'draw_away'] },
  { key: 'draw_no_bet', name: 'Draw no bet', line: false, selections: ['home', 'away'] },
  { key: 'over_under', name: 'Over/Under goals', line: true, defaultLine: 2.5, selections: ['over', 'under'] },
  { key: 'btts', name: 'Both teams to score', line: false, selections: ['yes', 'no'] },
  { key: 'asian_handicap', name: 'Asian handicap (line for the home team)', line: true, defaultLine: -0.5, selections: ['home', 'away'] },
  { key: 'european_handicap', name: 'European handicap (line for the home team)', line: true, defaultLine: -1, selections: ['home', 'draw', 'away'] },
  { key: 'home_total', name: 'Home team total goals', line: true, defaultLine: 1.5, selections: ['over', 'under'] },
  { key: 'away_total', name: 'Away team total goals', line: true, defaultLine: 1.5, selections: ['over', 'under'] },
  { key: 'corners_ou', name: 'Total corners', line: true, defaultLine: 9.5, selections: ['over', 'under'] },
  { key: 'cards_ou', name: 'Total cards', line: true, defaultLine: 4.5, selections: ['over', 'under'] },
  { key: 'anytime_scorer', name: 'Anytime goalscorer', line: false, player: true, selections: [] },
];

export const OUTCOME_LABEL = {
  pending: 'Open', won: 'Won', lost: 'Lost', push: 'Push', void: 'Void', half_won: 'Half won', half_lost: 'Half lost',
};
