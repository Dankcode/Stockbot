const closes = [
  100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80, 78, 76, 74, 72,
  73, 75, 78, 82, 87, 93, 100, 108, 116, 123, 129, 134, 138, 141, 143,
  142, 139, 135, 130, 124, 117, 109, 101, 95, 91, 89, 92, 97, 103, 110, 118
];

const gapBps = [0, 35, -20, 55, -45, 80, -30];
const start = Date.UTC(2025, 0, 2);

export const deterministicBars = Object.freeze(
  closes.map((close, index) => {
    const previousClose = closes[Math.max(0, index - 1)];
    const open = index === 0 ? close : Number((previousClose * (1 + gapBps[index % gapBps.length] / 10_000)).toFixed(4));
    const high = Number((Math.max(open, close) + 1.25 + (index % 3) * 0.15).toFixed(4));
    const low = Number((Math.max(0.0001, Math.min(open, close) - 1.1 - (index % 2) * 0.2)).toFixed(4));
    return Object.freeze({
      time: start + index * 86_400_000,
      open,
      high,
      low,
      close,
      volume: 100_000 + index * 1_337
    });
  })
);
