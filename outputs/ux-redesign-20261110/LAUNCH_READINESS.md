# PrintQs launch readiness, 2026-11-11

Written for the founder. It covers the product as it would be with branch `ux/redesign-2026-11` merged and
deployed. **The redesign is not deployed.** Production runs `master` (`66907ea` at the last fetch), where the
counter's P0 from the audit (F1: staff confirm money without seeing the order) is still live.

Evidence labels used below:
- **verified in browser**: done through the real UI on the local stack, with screenshots or a measured journey.
- **verified by test**: covered by an automated test that passed in this session.
- **verified by request**: a read-only GET to the public production API on 2026-11-11.
- **read in code only**: true in the code on this branch; not exercised.
- **not verifiable here**: needs production access, hardware or people this session does not have.

## Verdict

| Launch | Verdict | In one line |
|---|---|---|
| **Small pilot** (1-2 shops you know, one campus, you at the counter on day one) | **GO WITH CONDITIONS** | The core loop works end to end and the counter is fast and safe; four owner actions must happen first. |
| **Wider campus launch** | **NO-GO for now** | No real-printer evidence yet, the desktop app cannot update itself and is unsigned, student sign-out does not end the session, and (per your notes) the database has no backups. |

**Conditions for the pilot** (all owner actions; none needs new code):
1. **Unpublish the two test shops in production.** "Tenx" (address "Shanti Avenue, Charnipada, Bhiwandi") is
   listed and **open for orders**; "Shanti AVenue test shop" is listed but closed (verified by request). A real
   student could order from Tenx today.
2. **Review, merge and deploy this branch** (Vercel deploys `master`; the API needs no deploy, nothing changed
   there). Without it, the pilot runs on the old counter (F1, F2, F3 from the audit).
3. **One real-printer order end to end in production** on the pilot shop's PC and printer, before students come:
   order → check in → code → cash → pages out → Printed OK · hand over → History and Earnings.
4. **Every pilot counter PC on desktop v0.1.1**, installed once with the owner present (the installer is unsigned,
   so Windows SmartScreen shows "Windows protected your PC": More info → Run anyway).

## End-to-end with fresh accounts (verified in browser)

Run twice through the UI with brand-new accounts on the local stack: once with owner and student both at
**390x844**, once at **1366x768** (`tools/e2e-fresh.mjs`; screenshots and `result.json` in
`07-final/e2e-phone/` and `07-final/e2e-desktop/`). Both passes finished with **no problems**: no page errors, no
console errors, no API 5xx.

| Step | Phone | Desktop |
|---|---|---|
| Owner registers a shop, lands on Setup, saves the location from the device position | ✓ | ✓ |
| Counter PC comes online with the PrintQ Simulator; owner adds it from Setup; the shop goes live | ✓ | ✓ |
| New student signs up with a phone number, finds the new shop in the directory, uploads a PDF | ✓ | ✓ |
| Checkout shows one final price (₹7.50, "Pay at the shop · cash or UPI"); Place order | ✓ | ✓ |
| "I’m here" (one tap) → "Your turn" ticket with the 6-digit code | ✓ | ✓ |
| Counter: 6 digits → order card (name, masked phone, file, pages, printer, ₹7.50) → Cash received & print; focus back in the code box | ✓ | ✓ |
| PC reports the print sent → "Printed OK · hand over" → job `completed`, payment `paid`; student page says Collected | ✓ | ✓ |
| History lists the order; Earnings: shop keeps ₹6.00 + PrintQs fee ₹1.50 = ₹7.50 the student paid | ✓ | ✓ |

Limits: the desktop app install and sign-in were replaced by a stand-in PC process that speaks the agent
protocol. In development the API lets the simulator print real orders on purpose; production does not. Login codes
came from the development console provider, not SMS.

## Scorecard

| Area | Score | Evidence | Notes |
|---|---|---|---|
| Student ordering (find shop → order → check in → code → collect) | 85 | verified in browser | Fresh-account pass on phone and desktop; first order 0 scrolls at 360x640; check-in one tap; code 54.6 px. Real SMS OTP not exercised (dev uses the console provider). |
| Counter (find order, take money, print, hand over) | 88 | verified in browser, verified by test | 6 keys + 1 click per student; order details before money; 10-student rush with 0 scrolls, 0 dialogs; Enter never confirms money. The 60 s reveal grace (F5) is unchanged. |
| Shop onboarding (register → live) | 75 | verified in browser; not verifiable here (desktop install) | Web part 8 clicks; PC hand-off with QR and share; the desktop install itself was replaced by a stand-in PC. |
| Management (prices, printers, settings, earnings, history) | 80 | verified in browser | Price change 0 scrolls; Settings 41 % shorter; Earnings and Insights merged; Printers is one click deeper through the nav. |
| Admin console | 70 | verified in browser | Flow unchanged and works; the list grows with every shop and has no search. |
| Accessibility | 85 | verified in browser (axe-core, keyboard) | 0 axe violations on 38 page checks (baseline 4). Counter fully keyboard-operable. No real screen-reader session. |
| Visual consistency | 85 | verified in browser | One token system, 5 status tones, sentence-case badges; 106 states at 6 viewports, no horizontal overflow. |
| Performance | 75 | verified in browser (throttled) | No regression vs baseline on the same data. On Fast 3G with a slow CPU, pages paint in 2.7-4.3 s; on campus 4G it is far less. The PDF preview chunk (146 KB gzip) is the heaviest download, on checkout only. |
| Resilience (offline, API down, loading) | 80 | verified in browser | Offline banner, API-down and loading states shot on the counter and student pages. |
| Money handling | 85 | verified by test, read in code only | Staff confirm cash/UPI explicitly for the server-computed amount; UPI hidden until the shop's UPI ID is verified. Platform fee collection is off by default (`FEE_PAYMENT_PROVIDER=disabled`). |
| Printing on real hardware | 40 | not verifiable here | All printing in this session went through a stand-in PC. A real-printer order in production is still missing. |
| Desktop app distribution | 35 | read in code only | Unsigned NSIS installer, no auto-update: each fix means a manual reinstall on every counter PC. |
| Sessions | 65 | read in code only | Shop sessions are 12 h and revocable; student tokens last 30 days and sign-out only clears the phone. |
| Hosting and operations | 60 | verified by request; not verifiable here | API answered in 0.17-0.50 s (Singapore). Database plan, backups and Redis persistence not visible from here. |
| Production data hygiene | 40 | verified by request | Two test shops public, one open. |
| Automated tests | 85 | verified by test | `typecheck` green. `test:launch` (2026-11-11): build ✓; web 334/334, shared 109/109, agent 30/30; API 279 passed, 1 timeout (L15), 158 database tests skipped (no test database configured here); simulator end-to-end 102/102 assertions, run separately because the chain stops at the timeout. |

## Open items from the brief, re-checked today

| Item | Status on 2026-11-11 | Evidence | Owner |
|---|---|---|---|
| "Shanti AVenue test shop" listed and open | **Still listed**, now closed (`open: false`, campus "QA Campus"). **New:** "Tenx", same Bhiwandi address, is listed and **open**. | verified by request (`GET api.printqs.com/api/public/shops`) | Founder: Admin → Unpublish both |
| Counter PCs on desktop v0.1.0, no auto-update | The repo's app is **v0.1.1**; there is **no updater** in the code (no `electron-updater` or update check). Which version each PC runs is unknown here. | read in code only; not verifiable here | Founder (reinstall); engineering (auto-update) |
| Unsigned installer / SmartScreen | **Still unsigned**: `electron-builder` has no certificate or signing settings. | read in code only | Founder (buy a code-signing certificate, or use a signing service) |
| QA shops and users in the database | The public list shows no other test shops. Unpublished QA shops and QA users can't be seen from here. | verified by request; not verifiable here | Founder (database purge) |
| Student sign-out does not revoke the 30-day token | **Still true.** `Student` has no `sessionVersion` (shop and admin users do); sign-out clears the token on the phone only; the token lives 30 days. | read in code only | Engineering (API: add `Student.sessionVersion`, check it in `requireStudent`, bump it on sign-out) |
| Live Razorpay / fee collection | Students pay at the shop (cash or UPI to the shop). Platform fee collection defaults to `disabled`; the production value is not visible here. | read in code only; not verifiable here | Founder (live key secret, webhook, then switch on) |
| No real-printer end-to-end | **Still missing** as far as this session can see. | not verifiable here | Founder, with the first pilot shop |
| Hosting region / cold starts | The API is in Singapore since 2026-11-07 (your notes). Health check today: 0.50 s first, then 0.31 s and 0.17 s; no cold start seen. If the API runs on Render's free plan it sleeps after 15 minutes without traffic, and the first request after that can take up to about a minute. | verified by request; not verifiable here (plan) | Founder |

## Findings

### Blocks the pilot (P0)

| # | Finding | Evidence | Owner |
|---|---|---|---|
| L1 | Test shop "Tenx" is public and open in production. | verified by request | Founder |
| L2 | Production counter still has audit F1 (no order details before money), F2 (phone actions off-screen) and F3 (focus lost after each release). Fixed on this branch, not deployed. | verified in browser (baseline vs branch) | Founder: review, merge, deploy |
| L3 | No real-printer order has been completed in production. | not verifiable here | Founder |

### Fix before a wider launch

| # | Finding | Evidence | Owner |
|---|---|---|---|
| L4 | Desktop app cannot update itself; every counter PC needs a manual reinstall for each fix. | read in code only | Engineering |
| L5 | Unsigned installer: SmartScreen warning on every install. | read in code only | Founder (certificate) + engineering (build config) |
| L6 | Student sign-out does not end the session (30-day token). Matters on shared or lab phones. | read in code only | Engineering (API) |
| L7 | If staff don't press "Printed OK" within 15 minutes of the print reaching the printer, the job turns into a print problem whose only options are **Retry print** (prints again) or **Cancel & return payment**, even when the pages came out. `confirm-print-completion` only accepts jobs still `printing`. | read in code only (`printLease.ts`, `shops/routes.ts`); seen in browser on leftover jobs | Engineering (API: let staff confirm "It printed" on a `spool_timeout` problem, through `applyTransition`, with an audit event) |
| L8 | Data tier: per your 2026-10 notes the database is on Supabase free (pauses after about a week idle, no backups) and Redis is memory-only. Not re-checked here. | not verifiable here | Founder |
| L9 | Platform fee collection is not live, so commission accrues but can't be collected. | read in code only | Founder |
| L10 | Reveal grace (F5): a called student is marked absent 60 s after the code appears unless staff type it. With 3+ students called at once, the last may lose their place while staff serve the first. The counter now shows the countdown in the line, but the rule is unchanged. | read in code only; audit F5 | Product: decide after a week of pilot data (metric 3 below); 2 min is the safest pilot setting |

### Fix during the pilot

| # | Finding | Evidence | Owner |
|---|---|---|---|
| L11 | Print-problem messages are long API sentences (four lines of red on a phone) and use " - " as a dash. A shorter staff message per problem code would scan faster. | verified in browser (`07-final/32-counter@390x844.png`) | Engineering (`apps/api/src/lib/printProblem.ts`, copy only) |
| L12 | Adding a printer on a live shop through the nav is one click longer than before (Shop → Printers tab). The counter banner covers the common case. | verified in browser (task h) | Watch: if owners ask "where are printers?", add Printers to the account menu |
| L13 | "Ordered, not here yet" can hold many orders; it is collapsed with a count, but has no search. | verified in browser (43 in the test data) | Engineering, if pilot shops have many prepared orders |

### Later

| # | Finding | Evidence | Owner |
|---|---|---|---|
| L14 | Admin shop list has no search; it gets longer with every self-serve shop. | verified in browser (task i) | Engineering |
| L15 | `npm run test:launch` stops at an API `env.test.ts` case that spawns a process per config and hit the 5 s limit (5.3 s) on this Windows machine. The same file passes alone (22/22), and the untouched baseline timed out the same way. Because the chain uses `&&`, the simulator end-to-end only runs when called separately (it passes, 102 assertions). | verified by test (both trees) | Engineering (raise the timeout for that file) |
| L16 | Hindi or bilingual copy for staff and students was out of scope; plain English was kept short instead. | — | Product |

## Pilot day-one checklist

**The evening before**
1. Admin console: unpublish "Tenx" and "Shanti AVenue test shop". Open printqs.com/shops on your phone: only the pilot shop(s) should show.
2. Merge and deploy this branch. On printqs.com, the shop's counter shows a large "Counter code" box focused on load.
3. Counter PC: install PrintQs Shop v0.1.1 (SmartScreen: More info → Run anyway), sign in, keep the PC from sleeping (Windows power settings: never), printer on with paper loaded. The status chip says **Live**.
4. Settings → UPI at the counter: add and verify the shop's UPI ID if the shop takes UPI (otherwise only "Cash received & print" shows).
5. Settings → Advanced details: set the reveal grace to **2 min** and counter capacity to what one person can serve (2-3).
6. Do one real order with your own phone: order → I’m here → code → Cash received & print → pages out → Printed OK · hand over → it shows in History and Earnings.

**Opening**
7. Put the shop's QR or link at the counter and the entrance. Tell staff only three things: type the code, take the money and press the matching button, check the pages and press Printed OK.
8. Stay at the counter for the first rush hour. Write down every question staff or students ask.

**During the day**
9. A red "Print problem" card: check the printer first. Pages came out → tell engineering (see L7); not printed → Retry print.
10. If the PC goes offline the chip turns red; restart PrintQs Shop on the PC.

**Closing**
11. Earnings → Today should match the cash in the drawer plus the shop's UPI app for PrintQs orders.
12. Note how many students were marked absent and why.

## Pilot metrics

| # | Metric | Why | Where it comes from |
|---|---|---|---|
| 1 | Orders completed per day, and in the busiest hour | Is the shop using it at all, and at rush time? | Jobs handed over, by hour |
| 2 | Check-in → handed over, median and 90th percentile | The promise is "skip the queue"; this is the queue | Job timestamps (`arrivedAt` → hand-over) |
| 3 | Share of called students marked absent | Tests the 60 s / 2 min reveal grace (L10) | No-show events ÷ students called |
| 4 | Print problems per 100 orders, and how many were "it had printed" | Hardware path reliability and L7 | `PRINT_FAILED` events by problem code; staff notes |
| 5 | Out-of-turn releases per day | Whether queue order matches the counter's reality | `COUNTER_QUEUE_OVERRIDE_RELEASE` audit events |
| 6 | Orders placed but never checked in (expired) | Students who order and don't come: wasted shop attention | Expired prepared orders ÷ orders |
| 7 | Students with a second order within the pilot | The only honest signal that students like it | Students with ≥2 orders |
| 8 | Day-end money mismatches reported by the owner | Payment confirmation by staff must match the drawer | Owner's note at closing (step 11) |

## Before and after (this branch vs baseline `3ae2475`)

| Measure | Before | After |
|---|---|---|
| Counter: find order, take cash, print (1366x768) | 2 clicks + 7 keys, KLM 9.6 s | **1 click + 6 keys, KLM 6.6 s** (−31 %) |
| Counter: pages out → handed over | 3 clicks, 1 scroll, 1 dialog, 9.5 s | **1 click, 2.7 s** (−72 %) |
| Counter rush, 10 students | 50 clicks, 70 keys, 19 scrolls, 10 dialogs, 203.5 s | **20 clicks, 60 keys, 0 scrolls, 0 dialogs, 92.5 s** (−55 %) |
| Counter on a phone (390x844) | 1 scroll per release; actions in sideways-scrolling tables | 0 scrolls; actions on screen |
| Student first order (360x640) | 8 taps, 3 scrolls, 40.9 s | 8 taps, **0 scrolls**, 36.4 s |
| Student repeat order (390x844) | 3 taps, 1 scroll, 9.5 s | 3 taps, 0 scrolls, 8.0 s |
| Check in and read the code | 2 taps, code 41.6 px | **1 tap**, code 54.6 px |
| Owner changes a price | 3 clicks, 2 scrolls, 14.6 s | 3 clicks, 0 scrolls, 11.6 s |
| axe-core violations (38 page checks) | 4 (5 nodes) | **0** |
| Entry JS / entry CSS (gzip) | 82.62 KB / 14.61 KB | 82.55 KB / 10.65 KB |
| Throttled first load, LCP summed over 8 routes (Fast 3G + 4× CPU) | 30.07 s | 29.86 s (every route within ±0.35 s) |

Full method and per-task detail: `JOURNEY_METRICS.md`. Design reasons: `DESIGN_DECISIONS.md`. Baseline problems:
`UX_AUDIT.md`. Screenshots: `00-baseline/` (before), `01-after-foundations/` … `06-after-auth-admin/` (per slice),
`07-final/` (final, all routes and states, plus the two fresh-account passes in `07-final/e2e-phone/` and
`07-final/e2e-desktop/`).
