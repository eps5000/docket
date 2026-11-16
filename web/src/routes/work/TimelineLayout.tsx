import type { Timeline } from '@tasklite/shared';
import { Card, EmptyState } from '../../components/kit';
import { BurndownCard } from './BurndownCard';

/**
 * Timeline (UI_SPEC §6.2.4, §9.1): the burn-down card above the week grid,
 * the grid, the forecast lane, the legend, and "Not on the timeline (no
 * dates)". US8 fills the grid and the lane.
 */
export function TimelineLayout({
  timeline,
  epic,
  label,
}: {
  timeline: Timeline | null;
  epic?: string;
  label?: string;
}) {
  const rows = timeline?.rows ?? [];
  return (
    <div className="stack" data-layout="timeline">
      <BurndownCard epic={epic} label={label} />
      <Card padded data-card="timeline-grid">
        {rows.length === 0 ? (
          <EmptyState text="Nothing has planned dates in this view." />
        ) : (
          <div className="tl-grid" role="table" aria-label="Timeline">
            {rows.map((r) => (
              <div className="tl-row" role="row" key={r.id}>
                <span role="cell" className="mono">
                  {r.id}
                </span>
                <span role="cell" className="one">
                  {r.title}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="legend" style={{ marginTop: 10 }}>
          <span>Entered plan</span>
          <span>Actual</span>
          <span>Forecast</span>
          <span>Blocker’s planned end</span>
          <span>Now</span>
        </div>
        {timeline && timeline.undated.length > 0 && (
          <div className="src" style={{ marginTop: 6 }}>
            Not on the timeline (no dates): {timeline.undated.join(', ')}
          </div>
        )}
      </Card>
    </div>
  );
}
