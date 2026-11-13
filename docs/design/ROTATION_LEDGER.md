# Ledger Dusk — Rotation page design

The Rotation page has its own visual system, scoped to `.rotation-page` in `src/styles/rotation.css`. The rest of the HUD keeps the token lock in [README.md](./README.md).

**Ledger Dusk** is the aesthetic of the observatory after hours: a near-black graphite field warmed by one band of amber, like the last lamp left burning over an open ledger. It borrows the language of the scientific record (the ruled column, the reference tick, the plotted series) and treats the drift of capital as something measured, not decorated. Every mark on the surface is there because something was measured.

## Space

A strict grid with generous gutters, so dense clusters of data sit like specimens on a tray. Rhythm comes from small repeated elements (hairline sparklines, monospaced columns, thin score bars) set against calm large panels. Hierarchy is carried by size and weight, not colour: one large thin serif figure, a field of small even monospaced labels, nothing in between shouting.

## Colour

| Role | Value |
|---|---|
| Ground, three tonal lifts | `#0d0e10`, `#131517`, `#1a1d20`, `#22262a` |
| Hairlines | `#2a2f34`, `#353b41` |
| Text, rationed brightness | `#ede9e1` at 100 / 68 / 42 / 24% |
| Accent: the thing that matters now | amber `#e2a54d` |
| Gain / loss, desaturated | sage `#93b89c` / rose `#c88a8a` |

Panels separate by tone alone, without borders. Amber is reserved for the current selection, the live point on a series, and the primary action.

## Type

- **Instrument Serif** for the few large gestures: the page title and the headline figure.
- **IBM Plex Mono** for every number, tabular and aligned, so columns read like instrument readouts.
- Labels in small capitals with wide tracking. No paragraphs; where an explanation seems needed, the answer is a better chart.

Both fonts are SIL Open Font License 1.1 and ship in `public/fonts` with their licenses.

## Marks

Series are hairlines, never gradient-filled. Ranks are rows of identical thin bars whose only variable is length. The regime is one dashed rule above or below the price, with faint sage or rose bands behind it. Grid lines are dotted ticks, like graph paper held up to lamplight.
