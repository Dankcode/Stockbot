import type { CandleGeometry } from "../useChartScene";

export type CanvasChartPalette = {
  candleUp: string;
  candleDown: string;
  volume: string;
};

export function drawCanvasCandles(
  context: CanvasRenderingContext2D,
  candles: readonly CandleGeometry[],
  palette: CanvasChartPalette
) {
  context.save();
  context.lineWidth = 1;

  context.fillStyle = palette.volume;
  for (const candle of candles) {
    if (candle.volumeHeight > 0) {
      context.globalAlpha = 0.36;
      context.fillRect(candle.x - candle.bodyWidth / 2, candle.volumeY, candle.bodyWidth, candle.volumeHeight);
    }
  }

  context.globalAlpha = 1;
  for (const candle of candles) {
    const color = candle.positive ? palette.candleUp : palette.candleDown;
    context.strokeStyle = color;
    context.fillStyle = color;
    context.beginPath();
    context.moveTo(candle.x, candle.highY);
    context.lineTo(candle.x, candle.lowY);
    context.stroke();
    const bodyTop = Math.min(candle.openY, candle.closeY);
    const bodyHeight = Math.max(1, Math.abs(candle.closeY - candle.openY));
    context.fillRect(candle.x - candle.bodyWidth / 2, bodyTop, candle.bodyWidth, bodyHeight);
  }
  context.restore();
}

