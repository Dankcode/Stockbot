import * as React from "react";

import type { ChartTime, ReplaySpeed, SessionReplayProps } from "./types";
import "./chart.css";

const REPLAY_SPEEDS: readonly ReplaySpeed[] = [1, 2, 10];

function replayTimeLabel(time: ChartTime | undefined) {
  if (time === undefined) return "No data";
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? String(time)
    : date.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit"
      });
}

export const SessionReplay = React.memo(function SessionReplay({
  times,
  index,
  onIndexChange,
  speed: controlledSpeed,
  onSpeedChange,
  playing: controlledPlaying,
  onPlayingChange,
  loop = false,
  ariaLabel = "Session replay",
  className = ""
}: SessionReplayProps) {
  const [internalSpeed, setInternalSpeed] = React.useState<ReplaySpeed>(1);
  const [internalPlaying, setInternalPlaying] = React.useState(false);
  const speed = controlledSpeed ?? internalSpeed;
  const playing = controlledPlaying ?? internalPlaying;
  const maximum = Math.max(0, times.length - 1);
  const safeIndex = Math.max(0, Math.min(maximum, Math.round(index || 0)));
  const stateRef = React.useRef({ index: safeIndex, onIndexChange, onPlayingChange });

  React.useEffect(() => {
    stateRef.current = { index: safeIndex, onIndexChange, onPlayingChange };
  }, [onIndexChange, onPlayingChange, safeIndex]);

  const setPlaying = React.useCallback((next: boolean) => {
    if (controlledPlaying === undefined) {
      setInternalPlaying(next);
    }
    stateRef.current.onPlayingChange?.(next);
  }, [controlledPlaying]);

  const setSpeed = React.useCallback((next: ReplaySpeed) => {
    if (controlledSpeed === undefined) {
      setInternalSpeed(next);
    }
    onSpeedChange?.(next);
  }, [controlledSpeed, onSpeedChange]);

  const setIndex = React.useCallback((next: number) => {
    const resolved = Math.max(0, Math.min(maximum, Math.round(next)));
    stateRef.current.index = resolved;
    stateRef.current.onIndexChange(resolved);
  }, [maximum]);

  const togglePlaying = React.useCallback(() => {
    if (!playing && safeIndex >= maximum && maximum > 0) {
      setIndex(0);
    }
    setPlaying(!playing);
  }, [maximum, playing, safeIndex, setIndex, setPlaying]);

  React.useEffect(() => {
    if (!playing || times.length <= 1) return;
    const timer = window.setInterval(() => {
      const current = stateRef.current.index;
      if (current >= maximum) {
        if (loop) {
          stateRef.current.index = 0;
          stateRef.current.onIndexChange(0);
        } else {
          window.clearInterval(timer);
          if (controlledPlaying === undefined) {
            setInternalPlaying(false);
          }
          stateRef.current.onPlayingChange?.(false);
        }
        return;
      }
      const next = current + 1;
      stateRef.current.index = next;
      stateRef.current.onIndexChange(next);
    }, 1_000 / speed);
    return () => window.clearInterval(timer);
  }, [controlledPlaying, loop, maximum, playing, speed, times.length]);

  return (
    <section
      aria-label={ariaLabel}
      className={`stockbot-session-replay ${className}`.trim()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === " ") {
          event.preventDefault();
          togglePlaying();
        } else if (event.key === "ArrowLeft") {
          event.preventDefault();
          setIndex(safeIndex - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          setIndex(safeIndex + 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          setIndex(0);
        } else if (event.key === "End") {
          event.preventDefault();
          setIndex(maximum);
        }
      }}
      tabIndex={0}
    >
      <div className="stockbot-replay-buttons">
        <button aria-label="Jump to session start" disabled={!times.length || safeIndex === 0} onClick={() => setIndex(0)} type="button">|◀</button>
        <button aria-label="Previous bar" disabled={!times.length || safeIndex === 0} onClick={() => setIndex(safeIndex - 1)} type="button">◀</button>
        <button
          aria-label={playing ? "Pause replay" : "Play replay"}
          aria-pressed={playing}
          disabled={times.length <= 1}
          onClick={togglePlaying}
          type="button"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <button aria-label="Next bar" disabled={!times.length || safeIndex === maximum} onClick={() => setIndex(safeIndex + 1)} type="button">▶</button>
        <button aria-label="Jump to session end" disabled={!times.length || safeIndex === maximum} onClick={() => setIndex(maximum)} type="button">▶|</button>
      </div>
      <output aria-live="off" className="stockbot-replay-time">{replayTimeLabel(times[safeIndex])}</output>
      <input
        aria-label="Replay position"
        aria-valuetext={replayTimeLabel(times[safeIndex])}
        disabled={!times.length}
        max={maximum}
        min="0"
        onChange={(event) => setIndex(Number(event.target.value))}
        step="1"
        type="range"
        value={safeIndex}
      />
      <label className="stockbot-replay-speed">
        <span>Speed</span>
        <select value={speed} onChange={(event) => setSpeed(Number(event.target.value) as ReplaySpeed)}>
          {REPLAY_SPEEDS.map((option) => <option key={option} value={option}>{option}×</option>)}
        </select>
      </label>
    </section>
  );
});
