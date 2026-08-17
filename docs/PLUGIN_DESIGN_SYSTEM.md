# Plugin surface — design system

Audit and extension notes for the UI the plugin format introduces. Tokens live in [`src/styles/plugins.css`](../src/styles/plugins.css); nothing here invents a colour, spacing step, radius, or duration that `tokens.css` does not already define.

## Audit of the existing system

`tokens.css` is in good shape — a single `:root` block, semantic names (`--surface-selected`, not `--blue-800`), a consistent 4px spacing scale, and a chart namespace that already separates presentation from meaning. Three observations before extending it:

| Finding | Severity | Note |
|---|---|---|
| No token for "informational but not a status" | Medium | The palette has `--positive`, `--warning`, `--destructive`, `--info` — all verdicts. A control group has no verdict, and reaching for a status colour to label one would assert something the backtest has not concluded. Resolved below by mapping control to `--text-secondary`. |
| `--info` and `--chart-series-2` overlap in role | Low | Both read as "secondary/neutral emphasis" in different namespaces. Not worth unifying, but worth knowing when picking a token for a new surface. |
| No ordinal scale | Medium | Every existing token is categorical. Horizons are ordinal (daily → yearly is a scale). Resolved by adding a four-step single-hue ramp rather than four unrelated hues. |
| No `prefers-reduced-motion` handling | Low | `--motion` and `--motion-fast` exist but nothing opts out. The new components do. |

## New semantic concepts

The plugin surface introduces exactly four things the system could not already express. Each gets a token, not an inline value.

### 1. Method role

```
--plugin-role-strategy    → --accent          the thing under test
--plugin-role-control     → --text-secondary  the reference
--plugin-role-benchmark   → --chart-vwap      passive comparison
```

`role-control` deliberately uses a text colour rather than a status colour. **A control is neither good nor bad — it is the null hypothesis.** Rendering it in green or red would imply a verdict, and the entire point of the control group is that the verdict comes from the comparison, not from the label. This is the one place where the obvious choice (a status colour, for visual variety) would actively mislead.

`role-strategy` reuses `--accent`, which the app already uses for the selected/active subject, so a strategy reads as "the thing you are looking at" consistently across the Strategies list, the session detail panel, and the pairing disclosure.

### 2. Requirement state

```
--plugin-requirement-met      → --positive
--plugin-requirement-unmet    → --warning
--plugin-requirement-blocked  → --destructive
```

`unmet` maps to `--warning`, not `--destructive`. An unmet requirement is a configuration step the operator has not taken yet: nothing is broken, nothing was lost, and the remedy is one env edit away. `--destructive` stays reserved for genuine failure — a rejected plugin, a failed run, a halted session — so it keeps its urgency. Spending red on "you have not set this up yet" is how a UI teaches people to ignore red.

### 3. Horizon band

```
--plugin-horizon-daily    #58d6d2
--plugin-horizon-weekly   #65aef8
--plugin-horizon-monthly  #7f97ff
--plugin-horizon-yearly   #a98bff
```

One hue traversed in four steps (cyan → violet), not four categorical hues. Horizons are **ordinal**: daily through yearly is a scale, and four unrelated hues would imply four unrelated kinds. The ramp reads correctly when sorted and degrades to a sensible lightness order in monochrome.

The endpoints are existing tokens (`--chart-series-6` and `--chart-vwap`); only the two middle steps are new, and both were contrast-checked.

### 4. Provenance

```
--plugin-trust-json      → --info          JSON plugin: data, interpreted
--plugin-trust-local     → --text-muted    trusted algorithms/ file
--plugin-trust-uploaded  → --warning       uploaded .js: review before running
```

Uploaded `.js` gets `--warning` because the algorithm docs already say to review code from other people before uploading it. The UI should carry that caution rather than leave it in a document. A JSON plugin does not, because it contains no code to review.

## Accessibility

Every foreground token was measured against `--surface` (`#0b141d`) for WCAG 2.1 AA:

| Token | Ratio | |
|---|---:|---|
| `--plugin-horizon-daily` | 10.57:1 | |
| `--plugin-requirement-unmet` | 9.27:1 | |
| `--plugin-requirement-met` | 8.16:1 | |
| `--plugin-horizon-weekly` / `--plugin-trust-json` | 7.92:1 | |
| `--plugin-role-control` | 7.89:1 | |
| `--plugin-role-benchmark` / `--plugin-horizon-yearly` | 6.91:1 | |
| `--plugin-horizon-monthly` | 6.87:1 | |
| `--plugin-role-strategy` | 6.05:1 | |
| `--plugin-requirement-blocked` | 5.86:1 | |
| `--plugin-trust-local` | 4.57:1 | narrowest margin |

All thirteen clear AA for normal text (4.5:1). `--plugin-trust-local` is the narrowest at 4.57:1, so it is used only for secondary provenance labels and never for a value the operator must act on.

Two rules the components follow:

- **Colour is never the only channel.** Every badge carries a text label. Role, requirement state, and horizon are all readable in monochrome and to colour-blind users.
- **Requirement state is exposed as `data-state`, not a class.** It reads as a value rather than a style hook, which keeps it available to `aria-*` wiring and to tests.

## Component specs

### `.plugin-badge`

Compact, uppercase, 11px, with a 1px border at ~30% of the foreground colour. The `--horizon` variant drops the uppercase transform and switches to `--font-numeric`, because a horizon is closer to a value than a category label.

```html
<span class="plugin-badge plugin-badge--strategy">strategy</span>
<span class="plugin-badge plugin-badge--control">control</span>
<span class="plugin-badge plugin-badge--horizon" data-horizon="monthly">monthly</span>
```

### `.plugin-requirement`

Three-column grid: status icon, label, detail — with the remedy on its own row beneath.

**The remedy is part of the component, not an optional extra.** An unmet requirement without its fix next to it sends the operator hunting through documentation, which is exactly the failure the capability model exists to prevent. `resolvePluginRequirements()` returns a `remedy` for every unmet item, and the UI has nowhere to render it if the component does not have a slot.

```html
<div class="plugin-requirement" data-state="unmet">
  <span class="plugin-requirement__icon" aria-hidden="true">!</span>
  <span class="plugin-requirement__label">source</span>
  <span class="plugin-requirement__detail">bluesky is not registered</span>
  <p class="plugin-requirement__remedy">Add "bluesky" to RESEARCH_WEB_SOURCES_JSON…</p>
</div>
```

### `.plugin-card`

Standard surface card. The one non-obvious rule: **an unsatisfied plugin is dimmed and outlined, never hidden.** A missing card reads as "not installed" and sends the operator re-downloading something they already have. `data-satisfied="false"` warms the border toward `--plugin-requirement-unmet` and drops the title to `--text-secondary`, so it is visibly present and visibly not ready.

### `.plugin-pairing`

Controls render as an always-visible nested list under their strategy, on a left rule — not a separate collapsed section.

This is the design carrying a format guarantee. The schema requires every strategy to declare its controls; collapsing them by default would let a result be read alone, which is the exact habit the control group exists to break. If a strategy's number is on screen, its controls should be too.

## Extending this

When a new plugin concept needs a colour, work in this order:

1. **Can an existing token carry it?** Most can. Reuse beats invention.
2. **Is it ordinal or categorical?** Ordinal gets a single-hue ramp; categorical gets distinct hues.
3. **Does it assert a verdict?** If not, do not give it a status colour.
4. **Measure the contrast** against `--surface` before committing, and record the ratio in the table above.
5. **Add a second channel** — a label, an icon, a position — so the meaning survives without colour.
