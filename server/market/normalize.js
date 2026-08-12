import { AppError } from "../http/errors.js";

export function normalizeQuote(symbol, raw, source) {
  const price = Number(raw.price);
  const previousClose = Number(raw.previousClose);
  const volume = raw.volume == null ? null : Number(raw.volume);
  const quoteAt = typeof raw.quoteAt === "number" ? raw.quoteAt : Date.parse(raw.quoteTime || "");
  if (!Number.isFinite(quoteAt) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(previousClose) || previousClose <= 0 || (volume !== null && (!Number.isFinite(volume) || volume < 0))) {
    throw new AppError("INVALID_PROVIDER_PAYLOAD", `${source} returned an invalid quote for ${symbol}.`, 502);
  }
  return {
    symbol: String(symbol).toUpperCase(),
    price,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    volume,
    at: quoteAt,
    source,
    status: "real"
  };
}

export function normalizeBar(raw, source) {
  const timeValue = raw.time ?? raw.t ?? raw.timestamp ?? raw.Timestamp;
  const volumeValue = raw.volume ?? raw.v;
  const at = typeof timeValue === "number"
    ? (timeValue < 10_000_000_000 ? timeValue * 1000 : timeValue)
    : Date.parse(String(timeValue));
  const bar = {
    time: at,
    open: Number(raw.open ?? raw.o),
    high: Number(raw.high ?? raw.h),
    low: Number(raw.low ?? raw.l),
    close: Number(raw.close ?? raw.c),
    volume: Number(volumeValue)
  };
  if (volumeValue == null || !Number.isFinite(at) || !Number.isFinite(bar.open) || !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || !Number.isFinite(bar.close) || !Number.isFinite(bar.volume) || bar.volume < 0 || bar.open <= 0 || bar.close <= 0 || bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
    throw new AppError("INVALID_PROVIDER_PAYLOAD", `${source} returned an invalid bar.`, 502);
  }
  return bar;
}
