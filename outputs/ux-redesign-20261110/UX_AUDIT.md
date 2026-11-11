# PrintQs UX audit (baseline)

Baseline build: `origin/development` @ `3ae2475` (same tree as `master` @ `66907ea`, live on printqs.com).
Studied on the local stack (Postgres 15432, Redis 6380, API :4000, Vite :5173, production preview :4173) with a
fixture world built by `tools/fixtures.mjs`: one live shop with two printers on a stand-in counter PC
(`tools/fake-counter-pc.mjs`, which finishes prints the way a real Windows spooler does, so staff must confirm
"printed"), one shop just signed up (42-character name), one shop with only the practice simulator, seven
students, orders in every state (prepared, scheduled, at the counter, coming up, waiting, absent, printing,
jammed, finishing, ready, completed, cancelled), a staff PIN account and the platform admin.

Evidence labels used below: **[browser]** verified in a real Chromium on the local stack (screenshot or scripted
run), **[test]** verified by an automated test, **[code]** read in code only, **[n/a]** not verifiable here.

Evidence files (all under `outputs/ux-redesign-20261110/`):

| What | Where |
|---|---|
| 102 screenshots: every route x state at 360x640, 390x844, 768x1024, 1280x720, 1366x768, 1920x1080 (full page + above-the-fold) | `00-baseline/*.png` |
| Layout metrics per shot (horizontal overflow, counter-code box position, focus) | `00-baseline/metrics.json` |
| Task measurements (interaction ledger + KLM estimate) | `00-baseline/journeys-before.json` |
| Production bundle sizes | `00-baseline/build-web.txt` |
| Throttled load (Fast 3G + 4x CPU, cold cache, median of 3) | `00-baseline/perf-throttled.json` |
| Harness | `tools/` (`shots.mjs`, `journeys.mjs`, `ledger.mjs`, `perf.mjs`, `fixtures.mjs`) |

Baseline gates: `npm run typecheck` exit 0; `npm test` exit 0 (shared 109, agent 15, api 280 passed / 158 DB tests
skipped, web 298) **[test]**.

## 1. How the tasks were measured

Each task is performed by Playwright in a real browser and every user-level operation is logged by
`tools/ledger.mjs`: clicks or taps (including the click needed to focus a field), keystrokes, fields touched,
scrolls needed to bring the next target on screen (vertical or horizontal), and browser confirm dialogs. Time is
reported two ways: the scripted wall clock (machine speed, not human speed) and a **Keystroke-Level Model**
estimate of expert human time (M 1.35 s, P 1.1 s, B 0.2 s, H 0.4 s, K 0.3 s per keystroke, S 1.5 s per
scroll-and-find). KLM excludes system waits, the SMS wait and the OS file picker, and assumes no errors, so it is a
floor, not a prediction. Wrong turns cannot be measured by a script; the cognitive walkthroughs below name the
likely ones.

## 2. Task metrics (baseline) [browser]

| Task | Viewport | Clicks / taps | Keys | Fields | Scrolls | Dialogs | KLM est. | Notes |
|---|---|---|---|---|---|---|---|---|
| (a) Owner registers and goes live (web steps only) | 1366x768 | 9 | 91 | 5 | 2 | 0 | 64.9 s | PC install + sign-in happen in the desktop app (not measured). Went live by itself. |
| (b) Staff releases one order (code known, pay at shop) | 1366x768 | 2 | 7 | 1 | 0 | 0 | 9.6 s | Click into code box (not focused on load), 6 digits, Enter, "Cash received & print". |
| (b) same | 1280x720 | 2 | 7 | 1 | 0 | 0 | 9.6 s | Code box visible without scrolling (y 333-395) but not focused. |
| (b) same | 390x844 | 2 | 7 | 1 | 1 | 0 | 11.1 s | Code box at y 701; 360x640 puts it below the fold (y 734). |
| (b2) Print came out: confirm printed + hand over | 1366x768 | 3 | 0 | 0 | 1 | 1 | 9.5 s | "Printed successfully" sits in the third table, below the fold; blocking confirm() dialog. |
| (c) Busy moment: 10 students, release + printed + hand over each | 1366x768 | 50 | 70 | 1 | 19 | 10 | 203.5 s | Every student: re-click the code box, scroll down to the printing table and back up. |
| (d) First-time student: landing to order placed | 390x844 | 8 | 29 | 3 | 1 | 0 | 37.9 s | "Prepare order" is the last element of a 2,342 px page. |
| (d) same | 360x640 | 8 | 29 | 3 | 3 | 0 | 40.9 s | |
| (e) Returning student, same shop: Home to order placed | 390x844 | 3 | 0 | 0 | 1 | 0 | 9.5 s | Already short; settings are not remembered. |
| (f) Student at the door: check in, read the code | 390x844 | 2 | 0 | 0 | 0 | 0 | 5.3 s | Code visible without scrolling, 41.6 px. |
| (g) Owner changes the A4 B/W price | 1366x768 | 3 | 5 | 1 | 2 | 0 | 14.6 s | Prices are halfway down a 3,241 px Settings page; one "Save all changes" at the bottom. |
| (h) Owner adds a detected printer | 1366x768 | 3 | 0 | 0 | 0 | 0 | 8.0 s | |
| (i) Admin hides then re-publishes a shop | 1366x768 | 4 | 20 | 1 | 2 | 0 | 21.8 s | |

Performance budget (production preview, Fast 3G + 4x CPU, cold cache, median of 3) [browser]:

| Route | FCP | LCP | Transfer |
|---|---|---|---|
| `/` | 2.69 s | 2.69 s | 235 KB |
| `/login` | 3.34 s | 3.34 s | 178 KB |
| `/s/:slug` | 3.00 s | 3.74 s | 183 KB |
| `/home` | 3.73 s | 4.00 s | 186 KB |
| `/s/:slug/file/:id` (checkout) | 3.19 s | 3.95 s | 209 KB |
| `/jobs/:id` | 3.04 s | 4.28 s | 184 KB |
| `/dashboard` (counter) | 4.12 s | 4.12 s | 212 KB |
| `/dashboard/login` | 3.86 s | 3.86 s | 186 KB |

Entry chunk: `index-*.js` 252.89 KB, **82.62 KB gzip**; entry CSS 69.71 KB, **14.61 KB gzip**; counter chunk 19.44 KB /
5.99 KB gzip [browser, `build-web.txt`]. These are the budget: the redesign may not exceed them.

## 3. Cognitive walkthroughs

### (b) Staff releases one order at the counter (the most important number in the product)

| Step | Will staff know what to do? | Will they see the control? | Will they understand the feedback? |
|---|---|---|---|
| Open Queue | Yes, but the screen leads with "Counter & walk-in line", a policy sentence and five counters ("prepared remotely", "printing / pickup"). | The code box is the white field in the dark panel, beside a 5-line paragraph about absent timers. | — |
| Type the code | The box is **not focused**: the first keystrokes go nowhere until staff click it. | Yes. | Dots placeholder; no digit grouping. |
| Find & print | Label says "print", but it only looks the order up for pay-at-shop orders. | The button looks disabled until 6 digits (opacity .45 on navy). | A new panel appears under the box: "Verify ₹X" plus a paragraph about screenshots not being proof. **Nothing says whose order it is, which file, how many pages or which printer.** Staff must trust the code. |
| Cash / UPI received & print | Clear labels. | Yes. | "Sent to printer ✓" in a small stamp; the code box keeps no focus, so the next student needs another click. |
| UPI when the shop has no verified UPI ID | The button is shown anyway. | — | The API refuses with "Verify this shop's merchant UPI VPA…" after the click **[code]** (`release.ts:210`). |
| Student not "at the counter" yet | "This student is not at the counter yet" appears as a third panel; "Print anyway" then shows the payment panel: 2 extra clicks. | Yes. | Copy is fine. |
| Auto-assign off | A printer dropdown panel appears first, then the payment panel: 3 panels in sequence for one order. | | |

Likely wrong turns: typing before clicking the box; pressing Enter twice; clicking UPI in a shop without a verified
UPI ID; scrolling the 8-column table for the student's row instead of using the code.

### (a) Owner registers and goes live

1. `/` → "Register your shop" (desktop nav pill or a text link under the hero; fine).
2. Register: 5 fields + 1 button; Enter submits; errors are inline now. On phones the "what happens next" panel is
   hidden (`.auth-aside { display:none }` at ≤620 px) **[browser]**.
3. Setup: a 2x2 grid of cards. Card 1 holds the whole map editor (very tall), card 2 says prices are done, card 3
   says "On your counter PC… open printqs.com/pc", card 4 is titled **"You are live"** while marked TO DO. A dark
   "Your shop goes live by itself" panel repeats card 4 **[browser]** (`35-setup-new@1366x768.png`).
4. Counter PC: on a phone the only bridge to the PC is the URL text in card 3; the `/pc` QR/share block lives on the
   Computers page **[browser]** (`38b-computers-new`).
5. PC connected: card 3 says "PC connected · 1 printer found. Add it so students can send you jobs" even when that
   printer is the practice simulator, while Printers says "Only the practice simulator was found… never takes real
   student orders" **[browser]** (`36-setup-practice`, `37b-printers-practice`). Contradiction reproduced.
6. Printers: "Add & configure" → "Colour printer? Yes / No" → done; the shop goes live by itself.
7. Wrong turns: the Queue page after login for a not-live shop shows the full counter with a yellow "Finish setup"
   banner (`43-counter-new-shop`); 8 nav items invite exploring Insights, Earnings and History before anything works.

### (d) First-time student order

1. `/` → "Start a print" → `/login`: phone (autofocus) → "Send secure code" → 6-digit code → "Verify and continue"
   → name → "Finish setup" → `/home`. Light and well built (QA scored it 72-80) **[browser]**.
2. Home → "New print": with no history it goes to `/shops`; the bottom "+" always goes to `/shops` even for a
   student with one shop (two entry points, two behaviours) **[code]** (`StudentShell.tsx:7`, `Home.tsx:35`).
3. Shop page: "Drop your files here" on a phone (drag and drop does not exist on touch) → "Choose files".
4. Checkout (`07-checkout@390x844.png`): four cards (Print settings, Pages, "When do you plan to arrive?", "Pay at
   shop" — a selector with one option), then the preview, then the total and **"Prepare order" at y≈2,170 of 2,342 px**.
   Nothing on screen says what the total is until the bottom. A coupon field is always open **[browser]**.
5. Job page: prepared; "Join only after you arrive". Fine.

## 4. Heuristic evaluation (Nielsen's 10)

| # | Heuristic | Findings (severity) |
|---|---|---|
| 1 | Visibility of system status | Counter: order details are never shown before printing (P0, trust). Revealed students' absent countdown is a 0.7 rem pill in the 7th column (P1). Shop status (live / PC offline / paused) only appears as a banner when something is wrong; there is no persistent "Live" signal (P2). Student Home shows "Hi there" + skeleton while loading (P2). |
| 2 | Match with the real world | Jargon: "prepared remotely", "Physically checked in", "advisory", "Live operations", "Counter action", "Find & print" (it does not print pay-at-shop orders), "Driver media", "spool acknowledgement" (P1). Student status "Ready — check in on arrival" reads as "prints are ready" (P1). "IN QUEUE" stamp while the ticket says "It's your turn" (P2). |
| 3 | User control and freedom | "Mark absent" is a full button on every line row, including people not yet called (P2). No undo after "Printed successfully" (P2; the blocking confirm() is the only guard). |
| 4 | Consistency and standards | Two badge systems (`.stamp` uppercase mono with 4 colours + `.band-pill` sentence case with 4 colours); "Needs attention" print failure is blue, not red (P2). Two "New print" entry points behave differently (P2). Shop nav calls the PC "Computers", setup calls it "counter PC", the desktop chip says "Printer setup" (P2). |
| 5 | Error prevention | UPI button offered when UPI is not verified (P1). Price and queue settings share one "Save all changes" at the bottom of a 3,241 px page, so an unsaved edit is easy to lose (P2). |
| 6 | Recognition rather than recall | Staff must recall which row a printed job is in after scrolling; nothing ties the code they typed to the row below (P1). |
| 7 | Flexibility and efficiency | No autofocus, no auto-lookup on the 6th digit, focus lost after every release; 19 scrolls for 10 students (P1). Returning students re-pick every setting (P2). |
| 8 | Aesthetic and minimalist design | Counter: 5 counters + 3 explanatory paragraphs + 3 wide tables (one 8 columns) (P1). Settings 3,241 px with advanced queue options first (P1). Badges on most rows ("AWAITING ARRIVAL" + "PAY AT SHOP" on every prepared order) (P2). Emoji in the student greeting (P2). |
| 9 | Help users recognise and recover from errors | Print failures are explained in plain words with Retry (good). Release errors appear in a red box under the payment panel, far from the code (P2). |
| 10 | Help and documentation | "Help & policies" sits in the shop nav next to Sign out; fine but noisy (P2). |

## 5. Five-second tests (expert estimate from the first viewport) [browser]

| Screen | "What is this for?" in 5 s | "What do I press?" in 5 s | Result |
|---|---|---|---|
| Counter (1366x768) | Yes: "Counter & walk-in line". | Partly: the code box competes with 5 counters, a paragraph and a disabled-looking button. | Weak pass |
| Counter (390x844) | Yes. | No: the code box is the 7th block; actions in the tables are off-screen to the right. | Fail |
| Setup, new shop | Yes: "Get your counter ready", 1/3. | Partly: the map card is huge; card 4 says "You are live". | Weak pass |
| Settings | "Settings". | No single next action; prices are not visible. | Fail |
| Earnings vs Insights | Two pages, two meanings of "earnings" (Insights "Today's shop earnings ₹52", Earnings "Due to PrintQs ₹41.50"). | — | Fail |
| Welcome | Yes: "Upload anywhere. Queue on arrival." | Yes: "Start a print". | Pass |
| Student Home | Yes. | Yes: "New print". | Pass (duplicate lists below) |
| Shop landing | Yes. | Yes: "Choose files". | Pass |
| Checkout (390) | Yes: "Set up your print". | The action and the total are not on screen. | Fail |
| Job: at the counter | Yes: big yellow code. | Mostly, but a payment box sits above the code. | Pass |
| Job: ready to collect | Two stacked tickets (code + "Collect at counter"). | — | Weak pass |
| Admin | Yes. | Yes. | Pass |

## 6. Complexity inventory

Decision per visible element: **keep**, **merge**, **hide** (progressive disclosure), **remove**.

### Shop navigation (`components/ShopNav.tsx`)
| Element | Decision | Reason |
|---|---|---|
| 8 links: Queue, Setup, Insights, Earnings, History, Printers, Computers, Settings | merge to 4 | Daily work (Counter, History, Money) is mixed with one-time setup; 8 targets on a phone is a swipe strip. |
| Setup link | remove after live → status chip | It is a checklist; once live it only matters when something breaks. |
| Insights + Earnings | merge | Same audience (owner), same question ("how much did I make, what do I owe"). |
| Printers, Computers, Settings | merge under "Shop" with tabs | Same job: configure the shop. |
| Shop name in 0.65 rem mono caps | keep, restyle | Must survive 40+ characters; readable size, ellipsis. |
| Desktop "Printers ready / Printer setup" chip | merge into status chip | One status signal for web and desktop. |
| Help & policies, Sign out | merge into one account menu | Rare actions; Sign out next to the nav is a misclick risk on phones. |

### Counter (`pages/shop/Dashboard.tsx`)
| Element | Decision | Reason |
|---|---|---|
| "Live operations" eyebrow, H1, policy sentence | remove | The page is a tool. |
| 5 counters + "Pause new orders" | merge | Counts move into section headers; Pause moves to the header status area with a confirm. |
| "Counter action" paragraph (5 lines) | remove | It explains the design instead of making it obvious. |
| Code box + "Find & print" | keep, rebuild | Autofocus, auto-lookup on the 6th digit, grouped digits, inline order details, one-click payment. |
| Queue-override / printer / payment panels in sequence | merge into one inline result card | One decision surface per order. |
| "Physically checked in" 8-column table | replace with a compact list | At the counter first with countdown; coming up; waiting. Columns that matter: who, what, amount, time left. |
| "Mark absent" on every row | hide | Only on called students, as a quiet action; the timer marks absence automatically. |
| "Prepared, not checked in" table | hide (collapsed count) | Not actionable at the counter; the code finds these orders anyway. |
| "Printing and pickup" table at the bottom | move next to the code box | It is the step that follows every release. |
| Stamps "AWAITING ARRIVAL", "PAY AT SHOP" on every prepared row | remove | Every order is pay at shop now. |
| Inline `style={{…}}` in rows | remove | Shared components. |

### Setup (`pages/shop/ShopSetup.tsx`)
| Element | Decision | Reason |
|---|---|---|
| 2x2 card grid with 1 tall card | replace with a single-column checklist, current step open | Read top to bottom on a phone. |
| "You are live" card marked TO DO | merge into the result banner | Contradictory heading. |
| Dark "Your shop goes live by itself" panel | merge into the step 3 note | Duplicate. |
| PC hand-off (URL text) | keep, expand | Show the `/pc` link with Copy / Share / QR on phones, right in step 3. |
| Student link + QR when live | keep | Useful on the go-live moment. |

### Settings (`pages/shop/Settings.tsx`)
| Element | Decision | Reason |
|---|---|---|
| Shop profile | keep | |
| Counter queue (capacity, time to reach the counter) | hide under Advanced | Good defaults; rarely changed. |
| Arrival check-in (radius + map) | keep as "Location", radius under Advanced | Location is needed; radius is a policy setting. |
| Auto-assign printers | move to Printers | It is a printer behaviour. |
| Counter merchant UPI | keep as "Payments" | Needed for "UPI received". |
| Paper types & price, Binding, Double-sided | keep as "Prices" with their own save | The owner's most common edit. |
| One "Save all changes" at the bottom | split per section | No lost edits, no hunting for the button. |
| Staff | keep as "Staff" | |

### Printers (`pages/shop/Printers.tsx`) and Computers (`pages/shop/Agents.tsx`)
| Element | Decision | Reason |
|---|---|---|
| 9-column printer table (Linked printer, Driver media, Test page…) | hide advanced columns behind "Advanced" | Daily need is name, online, colour, paper; driver media is rare. |
| Detected printers with "Add & configure" | keep | |
| "Connected computers" button | merge into Shop tabs | |

### Student screens
| Screen | Element | Decision | Reason |
|---|---|---|---|
| Home | "Hi Aarav 👋" | remove emoji | Decoration; "Hi there" flash while loading. |
| Home | "Happening now" + "Recent" showing the same orders | merge | Duplicate. |
| Home | "tap for your counter code" on prepared orders | remove | The code is not available until the student is near the front. |
| Checkout | "Pay at shop" one-option selector card | remove | Not a choice; one line in the total bar says it. |
| Checkout | "When do you plan to arrive?" card | hide | Default flexible; "Plan a time" link opens it. |
| Checkout | Coupon field | hide | "Have a coupon?" link. |
| Checkout | Total + "Prepare order" at the bottom | move to a sticky bar | Always reachable; one primary action. |
| Checkout | Step dots "Files uploaded · Print settings · Pay at shop · Arrive & check in" | remove | Decorative; the page has one job. |
| Job status | Payment box above the code | move below | At the counter the code matters first. |
| Job status | Two tickets on "ready to collect" | merge | One "Collect your prints" card. |
| Shop landing | "Drop your files here" on touch | reword | "Choose your files" on phones. |

## 7. Findings

| ID | Sev | Finding | Evidence | Where |
|---|---|---|---|---|
| F1 | **P0** | Staff confirm money and print without seeing whose order, which file, how many pages or which printer it is. A mistyped code that matches another order would print the wrong document and take the wrong amount. | [browser] `32-counter`, journey (b) | `Dashboard.tsx:459-476` |
| F2 | P1 | Counter on a phone: every action ("Mark absent", "Printed successfully", "Handed over", "Retry print") is off-screen inside horizontally scrolling tables. | [browser] `32-counter@390x844.png`, `@360x640` | `Dashboard.tsx:481-632` |
| F3 | P1 | The code box is not focused on load and loses focus after every release; 10 students cost 10 extra clicks and 19 scrolls between the code box and the printing table at the bottom. | [browser] journey (c), metrics `codeInput.focused:false` | `Dashboard.tsx:396-414` |
| F4 | P1 | "UPI received & print" is offered when the shop has no verified UPI ID; the API then refuses. | [code] `release.ts:210`, `Dashboard.tsx:470` | |
| F5 | P1 | A called student is marked absent 60 s (default) after their code appears unless staff type it. On a busy counter with 5 called students, staff cannot reach the 5th in time; the countdown is a tiny pill in column 7. Product rule, not changed here; made visible and flagged for the founder. | [code] `PLAN.md` queue bands; [browser] `32-counter` | API `engine.ts`, `QueueBand.tsx` |
| F6 | P1 | Checkout on phones: total and "Prepare order" are the last thing on a 2,342 px page (360x640: 3 scrolls). | [browser] `07-checkout@390x844.png`, journey (d) | `NewJob.tsx:356-395` |
| F7 | P1 | Setup step 3 says "1 printer found. Add it so students can send you jobs" for the practice simulator while Printers says it never takes real orders. | [browser] `36-setup-practice`, `37b-printers-practice` | `setupSteps.ts:93-103` |
| F8 | P1 | 8-item shop nav mixes daily work and setup; on phones it is a sideways swipe strip with Sign out next to Help. | [browser] `32-counter@390x844.png` | `ShopNav.tsx:19-28` |
| F9 | P1 | Settings is 3,241 px at 1366; prices are halfway down; one save button at the bottom; advanced queue rules sit above prices. | [browser] `39-settings@1366x768.png`, journey (g) 2 scrolls | `Settings.tsx` |
| F10 | P1 | Earnings and Insights are two pages with two meanings of "earnings". | [browser] `40-earnings`, `41-insights` | `Earnings.tsx`, `Insights.tsx` |
| F11 | P1 | Student status words: "Ready — check in on arrival" (sounds like prints are ready), "IN QUEUE" while the ticket says it is your turn; Home says "tap for your counter code" on orders that have no code yet. | [browser] `06-home-returning`, `10-job-at-counter` | `jobStatus.ts:9`, `Home.tsx:197` |
| F12 | P2 | Counter text explains the design ("Queue positions organize students; the six-digit code always controls…", 5-line paragraph about absent timers). | [browser] | `Dashboard.tsx:348-394` |
| F13 | P2 | Two badge systems and colour meanings that drift ("Needs attention" is blue; "AWAITING ARRIVAL" yellow; "PAY AT SHOP" yellow on every row). | [browser] | `styles.css:317-333,1385-1390` |
| F14 | P2 | "Printed successfully" asks a blocking confirm() every time (10 dialogs per 10 students) yet there is no undo; habituation makes it a weak guard. | [browser] journey (c) | `Dashboard.tsx:291-305` |
| F15 | P2 | Home lists the same orders twice (Happening now + Recent); "Hi there" + skeleton flash before the name; emoji greeting. | [browser] `06-home-returning` | `Home.tsx` |
| F16 | P2 | Two "New print" entry points: Home goes to the student's only shop, the bottom "+" always opens the directory. | [code] | `StudentShell.tsx:7`, `Home.tsx:35` |
| F17 | P2 | Ready-to-collect shows two tickets and says both "tell this code" and "staff find your order by your name". | [browser] `15-job-ready` | `JobStatus.tsx:340-352` |
| F18 | P2 | A shop that is not live lands on the full counter after login with a yellow banner. | [browser] `43-counter-new-shop` | `Dashboard.tsx`, `locationFlow.ts` |
| F19 | P2 | `/s/<unknown>` renders "This shop link is not valid" with HTTP 200, no `noindex` and a self canonical (soft 404). `NotFound` already does this right. | [code] `ShopLanding.tsx:156-171`, `NotFound.tsx:6-13` | |
| F20 | P2 | Register's "what happens next" panel is hidden on phones. | [browser] `31-shop-register@390x844.fold.png` | `styles.css:1295` |
| F21 | P2 | styles.css has grown by appended patch blocks (`qa-fix`, `qa-fix2`, 9 blocks) that override earlier rules; ~40 inline `style={{…}}` in the counter, checkout and job pages. | [code] | `styles.css:1549-1718` |
| F22 | P2 | Checkout always shows a coupon field and a one-option payment card. | [browser] `07-checkout` | `NewJob.tsx:340-385` |
| F23 | P2 | Admin rows carry an "AUTO-LIVE" badge on every shop (noise). | [browser] `51-admin` | `AdminConsole.tsx` |

## 8. Known small issues re-verified

| Issue (from QA round 2) | Status at 3ae2475 |
|---|---|
| Practice warning missing after reload on Printers | Reproduces by code: the warning is computed from *unlinked* detected printers, so once the simulator is added the page shows nothing about practice mode [code] `Printers.tsx:312-313`. Production-only for the setup copy (`simulatorPrinters` is 0 in development). |
| Notice off-screen at 390 px | Not re-tested in the baseline pass; re-tested in slice 4 after the Printers rework. |
| Setup step 3 copy contradicting Printers | **Reproduces** (F7) [browser]. |
| Register checklist hidden on phones | **Reproduces** (F20) [browser]. |
| Focus not moved to the password field after a wrong password | `ShopLogin.tsx:46` has a focus-by-id helper [code]; whether it runs after a wrong password is re-tested in slice 6. |
| Student Home flashing "Hi there / Loading…" | **Reproduces** (F15) [code + browser]. |
| Enter not submitting some forms | Fixed on register, login and phone forms (all `<form onSubmit>`) [code]. Settings sections have no form; addressed in slice 5. |
| Long shop name breaking the nav | Fixed at 1366/1280 (ellipsis) but the name is 0.65 rem mono caps and unreadable [browser] `43-counter-new-shop@1280x720`. |
| Soft 404 for unknown shop slugs | **Reproduces** for `/s/<unknown>` (F19) [code]. |
