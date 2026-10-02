import { Page } from '../components/ui.jsx';

const LATER = {
  bets: ['My Bets', 'Phase 3', 'Record a bet after placing it in your betting app: match, selection, the odds you got, stake. SokkerLiga settles it from the result.'],
  history: ['Betting History', 'Phase 3', 'Profit, ROI, win rate and averages, broken down by league, team, market, betting app, confidence and odds range.'],
  performance: ['Model Performance', 'Phase 4', 'Whether the predictions were right: accuracy, calibration (does a 70% call come in 70% of the time?), by market, league and model version.'],
};

export default function Later({ page }) {
  const [title, phase, text] = LATER[page];
  return (
    <Page title={title}>
      <div className="card pad soon">
        <p><span className="pill">{phase}</span></p>
        <p>{text}</p>
      </div>
    </Page>
  );
}
