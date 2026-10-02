/* Plain-English names for selections. Shared by the server (for Claude's
 * candidate list) and the UI, so both say the same thing. */

const signed = (x) => (x > 0 ? `+${x}` : x < 0 ? `−${Math.abs(x)}` : '0');

export function selectionLabel(market, line, selection, home, away) {
  switch (market) {
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
