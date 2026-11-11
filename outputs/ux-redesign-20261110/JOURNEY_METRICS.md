# PrintQs journeys: before and after

Each task below was run twice through the real UI against the same local stack: once on the baseline
(`origin/development` @ `3ae2475`) and once on branch `ux/redesign-2026-11`. Raw results:
`00-baseline/journeys-before.json` and `07-final/journeys-after.json`, written by `tools/journeys.mjs`.

## How it was measured

- **Driver.** Playwright runs Chromium against the local API (`:4000`) and web app (`:5173`, or `:5174` for the
  baseline UI), seeded by the same fixtures in both runs: shops, students, a live line, and a stand-in counter PC
  that speaks the agent protocol (`tools/fake-counter-pc.mjs`). The database grew between the runs (more shops
  and orders); where that changes a number, the note says so.
- **Ledger.** `tools/ledger.mjs` records every user-level action: click or tap, typed characters, single keys,
  native dialogs, and a **scroll** whenever the next target is outside the viewport. A target already on screen
  costs no scroll.
- **Time estimate (KLM).** Keystroke-Level Model operators (Card, Moran & Newell): mental preparation 1.35 s,
  point 1.1 s, button press 0.2 s, hand moves between mouse and keyboard 0.4 s, keystroke 0.3 s, scroll and find
  1.5 s. KLM models a practised user. It leaves out reading, waiting for the network and printer, and the OS
  file picker, so treat it as a comparison between designs, not a stopwatch. `scriptedWallSeconds` in the JSON
  is the script's own speed and is not compared.
- **Viewports.** Counter and owner tasks at 1366x768 (the common shop PC), plus 1280x720 and 390x844 for the
  counter. Student tasks at 390x844, plus 360x640 for the first order.

## Results

c = clicks or taps, k = keystrokes, s = scrolls, d = blocking dialogs. KLM = estimated seconds.

| Task | Viewport | Before | After | Change |
|---|---|---|---|---|
| **a** Register a shop → live | 1366x768 | 9c · 91k · 2s · 0d · 64.9 s | 8c · 91k · 2s · 0d · 62.2 s | −1 click (printer added inside Setup) |
| **b** Counter: find order, take cash, print | 1366x768 | 2c · 7k · 0s · 0d · 9.6 s | **1c · 6k** · 0s · 0d · **6.6 s** | −31 % |
| **b** same | 1280x720 | 2c · 7k · 0s · 0d · 9.6 s | 1c · 6k · 0s · 0d · 6.6 s | −31 % |
| **b** same, phone | 390x844 | 2c · 7k · 1s · 0d · 11.1 s | 1c · 6k · 0s · 0d · 6.6 s | −41 % |
| **b** same, keyboard only | 1366x768 | not measured* | 0c · 8k (6 digits, Tab, Enter) · 4.1 s | new |
| **b2** Pages out → handed over | 1366x768 | 3c · 0k · 1s · **1d** · 9.5 s | **1c** · 0k · 0s · 0d · **2.7 s** | −72 % |
| **b2** same | 1280x720 / 390x844 | 3c · 1s · 1d · 9.5 s | 1c · 0s · 0d · 2.7 s | −72 % |
| **c** Rush: 10 students in a row (b + b2 each) | 1366x768 | 50c · 70k · **19s** · **10d** · 203.5 s | **20c · 60k · 0s · 0d · 92.5 s** | −55 % |
| **d** New student: sign up and first order | 390x844 | 8c · 29k · 1s · 0d · 37.9 s | 8c · 29k · 0s · 0d · 36.4 s | −1 scroll |
| **d** same, small phone | 360x640 | 8c · 29k · 3s · 0d · 40.9 s | 8c · 29k · 0s · 0d · 36.4 s | −3 scrolls, −11 % |
| **e** Returning student: repeat order | 390x844 | 3c · 0k · 1s · 0d · 9.5 s | 3c · 0k · 0s · 0d · 8.0 s | −1 scroll |
| **f** At the shop: check in, read the code | 390x844 | 2c · 0k · 0s · 0d · 5.3 s | **1c** · 0k · 0s · 0d · **2.7 s** | −1 tap; code 41.6 → 54.6 px, top at 411 → 256 px |
| **g** Owner changes the A4 B/W price | 1366x768 | 3c · 5k · 2s · 0d · 14.6 s | 3c · 5k · 0s · 0d · 11.6 s | −2 scrolls |
| **h** Add a printer the PC found (live shop), via the nav | 1366x768 | 3c · 0k · 0s · 0d · 8.0 s | 4c · 0k · 0s · 0d · 10.6 s | **+1 click (worse)** |
| **h** same, via the counter banner "Add printer" | 1366x768 | (no banner) | 3c · 0k · 0s · 0d · 8.0 s | same as before |
| **i** Admin hides a shop, then republishes it | 1366x768 | 4c · 20k · 2s · 0d · 21.8 s | 4c · 20k · 3s · 0d · 23.3 s | same flow; see note |

\* Baseline: the code box was not focused on load (a click, or several Tabs, to reach it), Enter looked the order
up, and the cash button was reached with the mouse or by tabbing through the result. It was not measured
keyboard-only. The redesign focuses the box on load and after every release, so a keyboard-only release is
6 digits, Tab, Enter.

### What changed in each step sequence

- **b (release).** Before: click the code box → type 6 digits → Enter (find) → click "Cash received & print".
  After: type 6 digits (the box is already focused; the order card appears after the 6th digit) → click "Cash
  received & print". Focus after sending: before `BODY` (staff had to click back into the box), after the code
  box itself (`focusAfterRelease` in the JSON). Two Enters in a row leave the order unpaid
  (`b-double-enter-safety`: `counter_due`, `queued`), so a habitual Enter never confirms money.
- **b2 (finish).** Before: scroll to the job → "Printed successfully" → a browser confirm() dialog → "Handed over".
  After: one "Printed OK · hand over" on the job card next to the code box. It calls the same two endpoints in the
  same order; staff still confirm the print themselves.
- **c (rush).** 10 students, each released with cash and then handed over. The 19 scrolls and 10 dialogs came from
  b2 and from the list growing under the code box. Zero of both now, because the job card sits next to the code
  box and the newest job is on top.
- **d / e (student order).** Same number of taps; the "Place order" button is in a sticky bar with the total, so
  it never needs a scroll, even at 360x640.
- **f (check in).** Before: "I’m at the shop" → "Yes, join the line". After: one "I’m here" (the API still checks
  the location). The code ticket is larger and sits higher.
- **g (price).** Prices have their own page (Shop → Prices), so the A4 row is on screen without scrolling the
  3,241 px Settings page.
- **h (add printer).** Printers moved under Shop (4 nav destinations instead of 8), which costs one extra click
  through the nav on a live shop. The counter shows "PC connected · 1 printer found → Add printer" in exactly that
  situation, so the usual path stays at 3 clicks. A shop still in setup adds it inside Setup (2 clicks, task a).
- **i (admin).** The steps are identical (the admin console only lost a badge). The extra scroll comes from the
  data: the after run had 10 shops in the list, the baseline run 4 (the 3 seeded shops plus the one task a registers). A same-data probe (old UI on `:5174`, new UI
  on `:5173`, same database) put the shop's Unpublish button at y = 1329 px and 1328 px, so the two UIs need the
  same scrolling.

## Targets from the brief

| Target | Result |
|---|---|
| Counter release in 6 keystrokes + 1 click | **Met**: 6 keys + 1 click (b), or 8 keys and no click (keyboard only) |
| Code box focused and visible without scrolling at 1280x720 | **Met at all six viewports** (360x640 to 1920x1080): focused on load, top edge at 185-197 px, numeric keyboard on phones (`07-final/counter-codebox.json`). Baseline: never focused; below the fold at 360x640 (top at 734 px) |
| Order details inline before money is confirmed | **Met**: student, phone, file, pages and specs, printer, amount on the card (F1) |
| Clear and refocus after sending | **Met**: focus returns to the code box (b, `focusAfterRelease`) |
| Auto-lookup on the 6th digit, decided and justified | **Yes**; justification in `DESIGN_DECISIONS.md` §4 (lookup never prints or records money for pay-at-shop orders) |
| Out-of-order release: visible warning + audit | Kept: "Print anyway" / "Keep queue order" in the card; the API's audit event is unchanged |
| ≤ 4 primary nav destinations | **Met**: Counter, History, Earnings, Shop (staff: Counter, History, Shop) |
| Returning student ≤ 6 taps and < 60 s | **Met**: 3 taps + the file picker, KLM 8.0 s (plus upload time) |
| Shop names up to 40 characters | **Met** at 761-1920 px: the account button truncates with the full name as its title and in the menu |
| No metric worse than baseline | **One regression, mitigated**: h via the nav (+1 click); the banner path is unchanged |

## Other before/after measurements

| Measure | Before | After | Source |
|---|---|---|---|
| axe-core, WCAG 2.0/2.1/2.2 A + AA rules, 19 pages × phone + desktop | 4 violations, 5 nodes: `color-contrast` (checkout, both sizes), `scrollable-region-focusable` (earnings on phone) | **0 violations** on all 38 page checks | `00-baseline/axe-before.json`, `07-final/axe-after.json` |
| Entry JS (gzip) | 82.62 KB | 82.55 KB | `00-baseline/build-web.txt`, `07-final/build-web.txt` |
| Entry CSS (gzip), every visitor | 14.61 KB | 10.65 KB | same |
| Shop/admin CSS (gzip), shop and admin pages only | (inside the entry CSS) | 7.22 KB lazy chunk | same |
| Counter route JS (gzip) | Dashboard 5.99 KB + ShopNav 1.40 KB | Dashboard 6.74 KB + ShopNav 3.25 KB | same |
| Settings page height | 3,241 px at 1366x768; 4,676 px at 390x844 | 1,916 px (−41 %); 2,277 px (−51 %) | `00-baseline/metrics.json`, `07-final/metrics.json` (`39-settings`) |
| Checkout page height, 390x844 | 2,342 px, Place order at the very bottom | 1,626 px, Place order in a sticky bar (always on screen) | same (`07-checkout`) |
| Throttled first load, LCP summed over 8 routes (Fast 3G + 4× CPU) | 30.07 s | 29.86 s; every route within ±0.35 s | table below |

### Throttled first load

Production builds served with `vite preview`, measured back to back on the same data (baseline on `:4174`, redesign
on `:4173`). Chrome DevTools "Fast 3G" (562.5 ms round trip, 1.44 Mbps down) and 4× CPU slowdown, cold cache,
390x844, median of 3 runs per route (`tools/perf.mjs`; raw: `07-final/perf-throttled-baseline-samedata.json` and
`07-final/perf-throttled.json`; the day-one baseline run is in `00-baseline/perf-throttled.json`).

| Route | Before FCP / LCP | After FCP / LCP | Before → after transfer |
|---|---|---|---|
| Welcome | 2.68 / 2.68 s | 2.70 / 2.70 s | 235 → 215 KB |
| Student login | 3.32 / 3.32 s | 3.42 / 3.42 s | 178 → 174 KB |
| Shop landing | 2.91 / 3.68 s | 2.98 / 3.60 s | 183 → 180 KB |
| Home | 3.42 / 3.97 s | 3.07 / 3.98 s | 205 → 201 KB |
| Checkout | 3.34 / 4.14 s | 3.39 / 4.28 s | 209 → 207 KB |
| Job status | 3.21 / 4.21 s | 3.08 / 3.96 s | 184 → 180 KB |
| Counter | 4.04 / 4.04 s | 4.07 / 4.07 s | 195 → 201 KB |
| Shop login | 4.02 / 4.02 s | 3.85 / 3.85 s | 186 → 182 KB |

No regression: differences are within the run-to-run spread of three runs. Students download less on every route.
The counter downloads 6 KB more (the separate shop stylesheet and the larger nav). That is paid once, on a shop PC
that stays open all day.
