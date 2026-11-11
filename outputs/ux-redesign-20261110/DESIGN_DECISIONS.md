# PrintQs redesign: design decisions

Companion to `UX_AUDIT.md` (findings F1-F23). Every decision below names the finding or metric it answers.
Branch `ux/redesign-2026-11` from `origin/development` @ `3ae2475`. Front-end only unless a section says otherwise.

## 1. Principles

1. **The counter screen is a tool, not a report.** It answers one question at a time: whose order is this, how
   much do I collect, did it print. Everything else is a count or a collapsed list. (F1, F3, F12)
2. **Show what is true and needed now.** Status words describe the person's next step ("Go to the counter",
   "Collect ₹30"), never the system's internals ("prepared remotely", "advisory", "spool acknowledgement"). (F11, F12)
3. **One primary action per view, always reachable.** The button that moves the task forward is the only filled
   button on screen and is never below the fold on a phone (sticky bar where needed). (F6)
4. **The code is the hero.** The six-digit counter code is the product's one memorable visual: a perforated
   ticket on the student's phone and the same grouped digits in the shop's code box. Everything around it stays
   quiet. (F1, F17)
5. **Calm, consistent, plain.** One type scale, one spacing scale, three radii, five status colours with fixed
   meanings, no decorative gradients, emoji, all-caps labels or arrow-suffixed links. (F13, F15, F21)

## 2. Information architecture

### Shop (dashboard)

Before: 8 top-level links + Printer setup chip + Help & policies + Sign out. After: **4 destinations**.

| Destination | Route(s) | Who | Contents |
|---|---|---|---|
| **Counter** | `/dashboard` | everyone | Code box with inline order card, Printing & pickup, Walk-in line, Prepared (collapsed) |
| **History** | `/dashboard/history` | everyone | Past orders, receipts, CSV |
| **Earnings** | `/dashboard/earnings` (`/dashboard/insights` redirects here) | owner | Today, last 7 days, by printer, due to PrintQs, fee activity (Insights merged in) (F10) |
| **Shop** | `/dashboard/setup`, `/dashboard/prices`, `/dashboard/printers`, `/dashboard/agents`, `/dashboard/settings` | owner; staff see Printers + Counter PC | Tabs: Setup (only until live) · Prices · Printers · Counter PC · Settings |

- **Status chip** next to the destinations replaces the Setup link once the shop is live: "Live", "Live · counter PC
  offline", "New orders paused", "Paused by PrintQs", "Practice mode", or "Setup 1 of 3" before go-live. It links to
  the page that fixes it. The Electron "Printers ready / Printer setup" chip is folded into it. (F8)
- **Account menu** (shop name button): full shop name, role, Help & policies, Sign out. Sign out leaves the main
  nav, so it is never next to a daily link on a phone. (F8)
- **Phones**: compact top bar (brand, status chip, account menu) + a bottom bar with the 4 destinations, the same
  pattern students already use. A 42-character shop name is shown in full in the account menu and truncated
  (with `title`) elsewhere.
- Routes are kept (bookmarks, the desktop tray link to `/dashboard/setup`, emails); `/dashboard/prices` is new
  (front-end route; prices move out of the 3,241 px Settings page) and `/dashboard/insights` redirects. (F9)
- A shop that is not live opens **Setup** after login instead of the counter (F18). The counter still works if
  opened directly.

### Student (PWA)

Bottom bar unchanged (Home, Jobs, **Print**, Profile). Changes:
- The bottom **Print** button and Home's **New print** use the same rule: one remembered live shop → its page;
  several → the shop chooser on Home; none → the directory. (F16)
- Home shows each order once ("Now" for active orders with their next step, "Earlier" for the rest). (F15)
- No duplicate paths: Welcome has one student action ("Start a print") and one owner action ("Register your shop").

## 3. Design system

### Tokens (changes to `:root`)

| Token group | Decision | Why |
|---|---|---|
| Colour | Keep ink `#172033`, paper `#ffffff`, page `#f5f7fb`, cobalt `#3659e3` (primary + links), highlight `#f5d74f`. **Highlight is reserved for the counter code** and "your turn". Add an amber warn set (`--warn-ink #7a4a00`, `--warn-soft #fff4df`, `--warn-line #efc56a`) so warnings stop borrowing the code's yellow. | One colour, one meaning. (F13) |
| Status palette | 5 tones, fixed meanings: **neutral** grey (waiting, prepared, info), **info** cobalt (in progress: printing, checked in), **ok** green (done/good: ready, collected, live, online), **warn** amber (needs attention soon: coming up, setup to do, paused), **danger** red (problem: failed, absent, cancelled, offline when needed, time almost up). | Replaces 8 ad-hoc stamp/pill variants. Text always carries the meaning, colour only reinforces it. |
| Type | Bricolage Grotesque for page titles and the code ticket only; Instrument Sans for everything else; Space Mono **only for codes and money** (counter code, amounts, tabular numbers). Scale (rem): 0.75 · 0.875 · 1 · 1.125 · 1.375 · 1.75 · 2.25 (`--fs-xs` … `--fs-2xl`). Labels and badges in sentence case, no letter-spacing tricks. | Mono + all-caps labels everywhere read as generated and cost legibility for second-language readers. |
| Spacing | 4-pt scale `--sp-1` 4 px … `--sp-12` 48 px; components use only these. | Consistent rhythm. |
| Radii | `--r-sm` 8 px (controls, badges' inner), `--r-md` 12 px (rows, cards), `--r-lg` 16 px (panels, sheets), pill only for badges and chips. | Hierarchy instead of one radius on everything. |
| Shadow | `--shadow-1` for raised surfaces on the grey page, `--shadow-2` for menus, sticky bars and the code panel. List rows have no shadow. | Fewer floating cards. |
| Focus | 3 px outline: highlight on dark surfaces, cobalt on light; never removed. | WCAG 2.2 focus visible. |
| Motion | 120-200 ms ease-out for things that answer an action (result card appears, confirmation toast); no entrance animations; `prefers-reduced-motion` turns all of it off. The ticket's punched edge stays; its entrance bounce goes. | Motion only where something changed. |

### Components (shared primitives in `styles.css`, used by every slice)

- **Buttons**: `button` = primary (filled cobalt), `.secondary` (white, field border), `.quiet` (text button,
  ≥44 px hit area), `.danger` (filled red, only to confirm a destructive step). Sizes: default 44 px, `.large`
  52 px (counter payment, checkout). **One filled button per view.** Labels say what happens: "Cash received &
  print", "Place order", "Save prices".
- **Fields**: label above, help text below, inline error linked with `aria-describedby`; 1.5 px border at ≥3:1;
  Enter submits every form (all inputs inside `<form>`).
- **Badge** (`.stamp` / `.badge`): sentence case, body font, one of the 5 tones.
- **Notice**: one component with tones (info / warn / danger / ok), title + one line + optional action.
- **Panel** (`.panel`): white surface, `--r-lg`, `--shadow-1`. **List** (`.list` + `.list-row`): dividers, no
  per-row cards, for scanning. **Tables** stay only where columns are compared (History, fee activity) and never
  scroll actions off-screen on phones (they become stacked rows).
- **Tabs** (`.tabs`): Shop area sub-navigation, keyboard-operable links.
- **States**: skeleton (loading), empty (says what to do next, with the action), error (plain words + Try again),
  offline banner ("Can't reach PrintQs. Retrying…").
- **Ticket** (`.ticket`, `.code-digits`): the counter code. Student: large perforated ticket, highlight band,
  digits grouped 3+3. Shop: the same grouped digit style in the code box.
- **Sticky action bar** (`.action-bar`): bottom of the screen on phones for checkout and long forms.
- **Icons**: extend `components/Icons.tsx` (inline stroke SVG, 24 px grid, 2 px stroke). No icon dependency, no
  emoji, no icon-in-a-circle card grids.

## 4. Counter decisions

| Decision | Choice | Why / safety |
|---|---|---|
| Code box | Focused on load and after every release; 6 large grouped digits; numeric keyboard on phones; paste-safe (digits only). Visible without scrolling at 1280x720 and 360x640. | F3. |
| Auto-lookup on the 6th digit | **Yes.** Typing the 6th digit sends the same `POST /api/shop/release` the "Find" button sends today (an in-flight guard stops duplicates; editing the code cancels the shown result). Every order created since the pay-at-shop cut-over is `counter_due`, so this lookup **never prints and never records money**: the API stops at "requiresPaymentConfirmation" (or at the out-of-order / printer-choice step). Its only side effect is the one staff want: a matched, called student's absent timer stops, because they are standing at the counter. A legacy prepaid order (`paymentStatus: paid`) still prints on lookup exactly as "Find & print" did. Wrong codes count against the same limiter (10/min per counter) as pressing Enter did. | Saves 1 action per order (Enter or a click). |
| Order card | After lookup, show inline: student name and masked phone, file name, pages per copy and specs, the exact amount, the printer it will print on. Data comes from the queue list the page already loads (same server-computed `totalPaise` the API asks staff to confirm); the card refreshes the list if the job is not in it yet. | F1: staff see what they are about to print and charge. |
| Payment | **One click**: "Cash received & print" or "UPI received & print", each sending the code plus `paymentConfirmation` (and the chosen printer). The UPI button appears only when the shop's UPI ID is verified; otherwise a one-line note says where to add it. | Invariant kept: staff explicitly confirm the method for the exact amount; a student can never confirm. F4. |
| Keyboard path | Type 6 digits → `Tab` → `Enter` (Cash) or `Tab Tab Enter` (UPI). Focus stays in the code box after lookup on purpose: a habitual second Enter must not confirm money. `Esc` clears the card and the code. | Fully keyboard-operable without an accidental cash confirmation. |
| Out of turn | Inline warning in the same card: "Not called yet: #4 in line" (or "Not checked in"), with **Print anyway** and **Keep queue order**. Print anyway then shows the payment buttons in place. The audit event is unchanged (the API writes `COUNTER_QUEUE_OVERRIDE_RELEASE` when `overrideQueue` is sent). | Invariant kept: visible warning + audit. |
| Printer choice | When auto-assign is off or the assigned printer is not eligible, a compact select inside the card with the recommended printer preselected (eligible printers and ETA come from the API). No extra panel. | F1, fewer steps. |
| After sending | The card closes, the code box clears and refocuses, a short status line "Sent to Counter laser · Priya Nair · ₹300 cash" stays for 6 s (`role="status"`, non-blocking). | |
| Printing & pickup | Sits beside the code box (desktop) or right under it (phone). One card per job, one next button: **Printed OK · hand over** (printing, no binding), **Printed OK · start binding** (printing, binding), **Binding done** then **Hand over** (finishing / ready), **Retry print** + **Return payment** (failed), **Hand over** (ready). Secondary quiet action "Printed, student not here yet" confirms without handing over. | Invariant kept: staff confirm "printed" themselves; spool acceptance is never proof. "Printed OK · hand over" calls the existing `confirm-print-completion` then `handover` endpoints in order, exactly the transitions the state machine already allows; no API change. The blocking confirm() is replaced by the explicit label plus help text ("Check every page first. The file is deleted 10 minutes later."). F14. |
| Walk-in line | One list grouped **At the counter** (with a large countdown, red under 15 s), **Coming up**, **Waiting**; each row: position, name, file, pages and specs, amount, time left. "Mark absent" only on called students, as a quiet action. Phones: stacked rows, nothing off-screen. | F2, F5. |
| Prepared, not here yet | Collapsed by default with a count; expands to a compact list (planned time, name, file). | Not actionable at the counter. |
| Pause new orders | In the counter header next to the live status, secondary button + the existing confirm (prevent accidental taps); while paused, a warn notice with "Resume new orders" (primary). | Easy to find, hard to hit by accident. |
| Explanatory copy | Removed: H1 sentence, 5-line release paragraph, section paragraphs. Help lives in one "How the counter works" disclosure. | F12. |

## 5. Student decisions

| Decision | Choice | Why |
|---|---|---|
| Checkout layout | File name + pages on top, settings as segmented buttons (paper, colour, sides; binding as a select when there are more than 3), pages, then preview. **Sticky bottom bar** with the total and **Place order** on every screen size below 821 px; on desktop the total panel stays in the right column. | F6: the action is always reachable. |
| Remembered settings | Paper size and sides are remembered per shop in `localStorage`. Colour, binding, copies and pages always start at the cheapest default (B/W, none, 1, all). | Saves taps without ever silently making an order more expensive. |
| Disabled colour | The colour option stays visible but disabled with the reason underneath ("This shop prints black & white only right now"). | Explained disabled state. |
| One-option payment card | Removed; the bar says "Pay at the shop · cash or UPI". | Not a choice. F22. |
| Arrival planning and coupon | Collapsed behind "Plan a time (optional)" and "Have a coupon?". | Most students use neither. |
| Job status | Exactly one "what to do now" card per state, with the next action as the only filled button; details, receipt and progress below. At the counter: the ticket (code first, then countdown, then how to pay). Ready: one "Collect your prints" card with the code. | F11, F17. |
| Status words | `awaiting_arrival` → "Prepared · check in at the shop"; `queued` → "In line"; revealed → "Your turn"; `otp_verified` → "Sending to printer"; `ready_for_pickup` → "Ready to collect". | F11. |
| Home | No emoji; name placeholder skeleton instead of "Hi there"; "Now" list shows the next step per order, "Earlier" the rest; each order once. | F15. |

## 6. Slices and hypotheses

| Slice | Change | Metric it should move (baseline) |
|---|---|---|
| 1 Foundations | Tokens, primitives, badge palette, styles.css restructured (patch blocks merged), inline styles removed in touched pages | Entry CSS gzip ≤ 14.61 KB; no overflow at 320-1920; no regressions in screenshots |
| 2 Counter + nav | Section 4 + nav IA | (b) 2 clicks + 7 keys → **1 click + 6 keys**, KLM 9.6 s → ~6.5 s; (b2) 3 actions + 1 dialog + 1 scroll → **1 click, 0 scrolls**; (c) 50 clicks / 19 scrolls / 10 dialogs → **~20 clicks / 0 scrolls / 0 dialogs**; code box focused on load; phone counter actions on screen |
| 3 Student core | Section 5 | (d) scrolls 1-3 → 0; (e) 3 taps, ≤60 s kept, scroll 1 → 0; (f) code ≥ 48 px, still 2 taps |
| 4 Onboarding | Single-column setup, PC hand-off with QR/copy/share in step 3, practice-mode copy consistent everywhere, register next steps on phones | (a) clicks 9 → ≤8, no contradicting copy, phone owner has a way to send `/pc` to the PC |
| 5 Management | Prices page, Settings sections with their own save and an Advanced disclosure, Printers advanced columns hidden, Earnings + Insights merged | (g) 2 scrolls → 0; Settings page height −50% |
| 6 Auth, admin, legal | Consistency, focus after errors, soft-404 `noindex` on unknown shops | axe 0 violations kept |
| 7 Regression | Full screenshots, axe, keyboard paths, `test:launch`, throttled perf, launch readiness | No metric worse than baseline |

## 7. API changes

None. `git diff --stat 3ae2475..HEAD -- apps/api packages apps/agent` is empty: no API, Prisma, shared pricing,
state machine, auth or payment code changed. Every new behaviour uses endpoints that already exist.

## 8. Decision log (added during implementation)

Changes to the plan above, and choices the plan did not foresee. Each says what was decided and why.

### Slice 1: foundations (`ea34331`)

- **Badges stay lower-case in data, sentence case on screen.** `.stamp` and `.badge` are `inline-block` so
  `::first-letter` can capitalise them (it does nothing on `inline-flex`); badges with a dot keep `inline-flex`.
- **The checkout step indicator ("1 Upload · 2 Settings · 3 Pay") was removed.** Checkout is one screen; the
  steps described a flow that does not exist.

### Slice 2: counter and navigation (`fe2e49d`)

- **Shop CSS and shop-only icons are split out of the entry bundle.** `shop.css` (shop nav, counter, setup,
  printers, settings, earnings, admin) is imported by `ShopNav`, `ShopLocationEditor`, `FeeReceipt` and
  `AdminConsole`, so Vite emits it as a separate chunk. Shop icons moved to `ShopIcons.tsx`. Students never
  download either. Entry CSS fell from 14.61 KB to 10.65 KB gzip.
- **Enter in the code box only retries a failed lookup; it never confirms money.** Money is confirmed only by a
  button whose label names the method ("Cash received & print"). `b-double-enter-safety` checks that two Enters
  leave the order `counter_due`.
- **The per-row "Assign printer" button in the line was removed.** Printer choice happens in the order card at
  release time, where staff already are; a row without a printer shows a "No printer yet" badge. One place to
  choose a printer instead of two.
- **The UPI button appears only when the shop's UPI ID is verified.** The API refuses `shop_upi` confirmations
  otherwise. Without a verified UPI ID, owners see a one-line link to the UPI section of Settings, and staff see
  plain text instead.
- **Printing & pickup lists the job sent most recently first**: the one staff are waiting on is on top.
- **Counts are hidden while the counter loads.** The page no longer flashes "0 in line" before the data arrives.
- **One shared shop-status store** (`lib/shopStatus.ts`) feeds the nav status chip and the pages, so the setup
  status is fetched once per page instead of once per component.
- **Socket refreshes are coalesced (250 ms), added in slice 7 (`0214173`).** One release fires about five queue
  events within a second, and each one reloaded three endpoints. During the 10-student rush the API's per-user
  limit (300 requests a minute) answered 429. That rush also had the measuring script polling as the same user,
  but a busy real counter on a slow link could hit the same limit. The counter now does one reload per burst.

### Slice 3: student core loop (`20967aa`, `a2269f0`)

- **Check-in is one tap ("I’m here"); the "Yes, join the line" confirmation was removed.** The API still checks
  the student's location against the shop's radius, so a tap away from the shop fails with a plain message, and
  the browser asks for location permission the first time anyway. The second tap added no information.
- **Only paper size and sides are remembered** per shop (`lib/printSettings.ts`). Colour, binding and copies always
  start at the cheapest choice, so a remembered setting can never make an order dearer without the student seeing
  it.
- **The counter code is read digit by digit by screen readers.** The two visual halves (482 913) are
  `aria-hidden`, and a visually hidden text gives "Counter code 4 8 2 9 1 3". An `aria-label` on a plain `div`
  is not allowed (axe `aria-prohibited-attr`).
- **"Pay by UPI" shows on the job page only while the student is in line**, the only time it is useful. Before
  that the page only says "Pay ₹X at the counter. Cash or UPI. Staff confirm it before printing."
- **The timeline shows "Finishing" only for orders with binding.**
- **The 404 page is lazy-loaded** to keep the entry JS below baseline (82.56 KB vs 82.62 KB gzip). The 404 test
  renders the page directly, like the other lazy routes (`a2269f0`).

### Slice 4: onboarding (`603af15`)

- **Setup is one column of three steps, and step 3 lists the printers the counter PC found, with Add.** A new
  owner adds the printer without leaving Setup (register to live: 9 clicks to 8).
- **"Your shop is live" is never shown while only the practice simulator is connected.** Setup treats the shop as
  live only if it is listed and not in practice mode, so the page no longer contradicts the practice notice.
- **Owners on a phone get the `/pc` link to send to the counter PC** (copy, share, QR). The desktop app is
  installed on the PC; the owner often registers on a phone.
- **A late `/api/shop/me` response no longer wipes a pin the owner already placed.** Found when the register
  journey failed under React's development double-render.

### Slice 5: management pages (`a6ca53d`)

- **Prices got their own page** (`/dashboard/prices`, the first Shop tab once live). It is the same Settings
  component with `section="prices"`, so no new data code. Links to the old `#prices` anchor redirect there.
- **Settings is a set of sections with one sticky save bar.** Queue settings, check-in radius and coordinates sit
  in "Advanced details". The location editor has its own search form, so Settings uses a plain wrapper instead
  of a form, to avoid a form nested inside another (invalid HTML). Staff management is outside the save bar
  because each staff action saves on its own. Height at 1366: 3,241 px to 1,916 px.
- **Insights is merged into Earnings.** Summary tiles and the 7-day bars sit at the top. `/dashboard/insights`
  redirects, and `Insights.tsx` was deleted.
- **History has a search box** (student name, masked phone, file name).
- **Trade-off accepted: live shops reach Printers through Shop → Printers.** Through the nav, adding a printer on
  a live shop costs 4 clicks instead of 3. The common case (the PC just found a new printer) is covered by the
  counter banner "PC connected · 1 printer found → Add printer", which is still 3 clicks
  (`h-add-printer-from-banner`). Shops still in setup add printers inline (2 clicks inside Setup).

### Slice 6: auth, admin, legal (`ced0db5`, `84aebe8`)

- **Unknown or unpublished shop links are hidden from search engines** (`noindex`, no self canonical) and show
  "This shop link is not valid" with Find a shop and Go home. The single-page app still answers HTTP 200, so this
  is a `noindex` soft 404, not a status-code 404.
- **Admin badges the exception.** Shops that need a manual review get a "Manual review" badge. The old
  "Auto-live" badge sat on almost every shop, so it is gone. The admin page loads the shop stylesheet.
- **Fee activity table**: it is a keyboard-focusable region with a name (`tabIndex=0`, `role="region"`,
  `aria-labelledby`), so keyboard users can scroll it on phones (axe `scrollable-region-focusable`).

### Slice 7: fixes found in the final regression (`0214173`, `cb6c031`, `7bdd599`)

- **Counter refreshes are coalesced** (see slice 2): found when the 10-student rush hit the API's per-user limit.
- **Shop top bar at tablet widths.** At 768 px the account button kept the full shop name and ran 7 px off-screen.
  The nav links now keep their size and the account button shrinks first, truncating the name; the full name
  stays in its `title` and in the menu. Checked from 761 to 1280 px with 25- and 40-character names.
- **The earnings summary can fail quietly.** Loading and failed used to be the same `null`, so a failed
  `/api/shop/stats` would have left skeleton tiles on screen forever. It now disappears and the rest of Earnings
  works.
- **The history search helper is a plain function in `counterFlow.ts`**, so its test no longer loads the whole
  History page (that import timed out once on a busy machine).
- **Known, not changed: practice-mode wording in development.** Development lets the simulator print real orders,
  so the API marks a simulator-only shop live, while Setup still says "Practice mode … add your real printer". In
  production the API never makes a simulator-only shop live, and both say practice mode. Not worth new logic.

### Not changed, on purpose

- **60 s reveal grace before auto-absent (F5).** It is a queue rule (API), not UI. The counter now shows the
  countdown in the line and stops it when staff type the code. Whether 60 s is enough at a busy counter is a
  product call; see `LAUNCH_READINESS.md`.
- **Staff still confirm "printed" themselves.** Spool acceptance by the PC is not proof that the pages came out.
- **Cash/UPI confirmation is never automatic.** It is one click, never zero.
