import * as React from "react";

import { drawCanvasCandles } from "./canvas";
import type { ChartScene } from "../useChartScene";

function chartColor(style: CSSStyleDeclaration, name: string) {
  return style.getPropertyValue(name).trim() || "transparent";
}

export const CanvasCandles = React.memo(function CanvasCandles({ scene }: { scene: ChartScene }) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let animationFrame = 0;

    const draw = () => {
      const ratio = Math.max(1, window.devicePixelRatio || 1);
      canvas.width = Math.round(scene.layout.width * ratio);
      canvas.height = Math.round(scene.layout.height * ratio);
      const context = canvas.getContext("2d");
      if (!context) return;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, scene.layout.width, scene.layout.height);
      const style = window.getComputedStyle(canvas);
      drawCanvasCandles(context, scene.candles, {
        candleUp: chartColor(style, "--stockbot-chart-candle-up"),
        candleDown: chartColor(style, "--stockbot-chart-candle-down"),
        volume: chartColor(style, "--stockbot-chart-volume")
      });
    };
    const scheduleDraw = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(draw);
    };
    scheduleDraw();

    const observer = new MutationObserver(scheduleDraw);
    let ancestor: HTMLElement | null = canvas;
    while (ancestor) {
      observer.observe(ancestor, { attributes: true, attributeFilter: ["class", "style", "data-theme"] });
      ancestor = ancestor.parentElement;
    }
    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [scene]);

  return <canvas aria-hidden="true" className="stockbot-chart-canvas" ref={canvasRef} />;
});
