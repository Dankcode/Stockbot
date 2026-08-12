import * as React from "react";
import { MarketChart, SessionReplay, type ChartEquitySeries, type ChartRiskEvent, type ChartTrade } from "../../charts";

export function SessionChartPanel({
  series,
  trades = [],
  riskEvents = [],
  interval = "1day"
}: {
  series: ChartEquitySeries[];
  trades?: ChartTrade[];
  riskEvents?: ChartRiskEvent[];
  interval?: string;
}) {
  const times = series[0]?.points.map((point) => point.time) ?? [];
  const [replayIndex, setReplayIndex] = React.useState(Math.max(0, times.length - 1));
  const [playing, setPlaying] = React.useState(false);
  const [speed, setSpeed] = React.useState<1 | 2 | 10>(1);

  React.useEffect(() => setReplayIndex(Math.max(0, times.length - 1)), [times.length]);
  return (
    <div className="session-chart-panel">
      <MarketChart
        bars={[]}
        equitySeries={series}
        trades={trades}
        riskEvents={riskEvents}
        interval={interval}
        range="ALL"
        height={320}
        replayIndex={times.length ? replayIndex : undefined}
        ariaLabel="Session normalized equity"
      />
      {times.length > 1 ? (
        <SessionReplay
          times={times}
          index={replayIndex}
          onIndexChange={setReplayIndex}
          playing={playing}
          onPlayingChange={setPlaying}
          speed={speed}
          onSpeedChange={setSpeed}
          ariaLabel="Replay session"
        />
      ) : null}
    </div>
  );
}
