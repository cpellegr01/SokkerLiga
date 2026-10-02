import { Page } from '../components/ui.jsx';

const LATER = {
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
