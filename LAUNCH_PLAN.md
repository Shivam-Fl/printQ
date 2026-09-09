# PrintQ — real-student launch plan

Last updated: 2026-09-09

This is the source of truth for moving the current test deployment to a paid,
operational product. `DEPLOY.md` remains the deployment runbook; `PLAN.md`
describes the implemented product architecture.

## Current status

- The test PWA is live at `https://printq-three.vercel.app`.
- The API, workers, PostgreSQL and Key Value service are live on Render.
- CI is green, the production dependency audit is clean, and the remote printer
  simulator passes 55 assertions against the deployed backend.
- Checkout, SMS and email are still in test/console mode.
- The free Render filesystem, database and Key Value service are not durable
  enough for real orders. Vercel Hobby is restricted to non-commercial use.

The current URLs are suitable for invited testing, not for taking real student
payments.

## Product decision: campus first, nearby second

Most student printing is destination-led: a student wants a shop serving their
college, not simply the closest shop across a wall, highway or closed gate.
Therefore discovery should use this order:

1. Remember or ask for the student's campus.
2. Show verified shops that explicitly serve that campus.
3. Rank operational shops by estimated completion, distance and rating.
4. Offer **Use my location** as an optional fallback, never a requirement.
5. Keep QR/deep links to a specific shop as the fastest repeat-order path.

The queue remains arrival-based. Searching or uploading remotely never consumes
a physical position; **I'm at the shop** joins the live line. A no-show leaves
the line, closes the gap for everyone else, and can still use the stable counter
code without blocking or rejoining.

## Data model

Use `Campus`, not a free-text `collegeName`, because universities can have
multiple physical campuses.

### Campus

- `id`, `slug`, `name`, optional `shortName`
- searchable `aliases[]` (for example `IITB`, `IIT Bombay`)
- `city`, `state`, public address
- campus-centre `latitude`, `longitude`
- `active`, `verifiedAt`, timestamps

### Shop changes

- `latitude`, `longitude`, `locationAccuracy`
- `verificationStatus`: `pending | verified | suspended`
- `verifiedAt`, public phone/support contact
- structured weekly `businessHours` and exceptional closure state
- optional `serviceRadiusMeters`
- `ShopCampus(shopId, campusId, isPrimary)` many-to-many relation

A shop is one physical branch. A multi-branch business creates one shop per
branch so distance, printers, hours and queues stay truthful.

### Student change

- optional `defaultCampusId`
- recent shops remain client-side convenience data
- never persist a student's precise live coordinates for directory search

### Migration strategy

1. Create campuses from the distinct, reviewed `Shop.campusName` values.
2. Add the new nullable relations/coordinates without breaking old clients.
3. Backfill `ShopCampus` links, then make the canonical campus picker the normal
   owner flow.
4. Keep `campusName` read-only for one release as a compatibility fallback,
   then remove it after all shops are migrated.

## Search API and ranking

Endpoints:

- `GET /api/public/campuses?q=&city=` — canonical campus autocomplete.
- `GET /api/public/shops?campusId=&q=&openOnly=&capability=` — campus list.
- `POST /api/public/shops/search` — optional nearby search with rounded
  latitude/longitude in the body so precise coordinates do not appear in URL
  logs.

Validate and clamp every query, cap results, and return only verified shops.
For the first colleges, calculate distance with a tested Haversine utility in
the API. Add a bounding-box query before Haversine when the directory grows;
PostGIS is unnecessary for the pilot.

Default ranking:

1. verified and not suspended;
2. serving the selected campus;
3. accepting orders with a reachable compatible printer;
4. lowest estimated completion time from live printer workload;
5. shortest walking distance;
6. rating and completed-order reliability as tie-breakers.

Do not sort only by distance or rating. A slightly farther shop that is online
and can finish in five minutes is usually the better result.

Each shop card should show:

- shop and campus/landmark;
- open, paused or offline state;
- walking distance when location was granted;
- estimated wait range, not false minute-level precision;
- starting B/W and colour price;
- supported paper, duplex and finishing capabilities;
- rating count and a clear **Order here** action.

## Student UX

### First visit

Show a compact chooser:

- **Choose your college** — searchable canonical list (recommended).
- **Use my location** — asks for browser permission only after the tap.
- **Scan shop QR** — no directory step.

Remember the selected campus and let the student change it from the header and
settings. If location is denied, campus search continues normally. Explain why
location helps before the permission prompt.

### Returning student

Open with the last campus and recent shop, but show the shop's current online
state before upload. Never silently place an order at a different branch.

### Privacy

- Round coordinates before any server request and discard them after ranking.
- Do not log request bodies or precise location.
- Do not background-track students.
- Location is optional; campus and QR flows remain complete without it.

## Shop onboarding and verification

Self-registration must not make an unknown shop publicly discoverable.

1. Owner creates the account and verifies email/phone.
2. Owner selects one or more canonical campuses served.
3. At the physical counter, **Use this device's location** records the branch
   position; manual address remains available.
4. Owner connects the print agent, maps a detected printer, configures loaded
   paper/capabilities and runs the simulator.
5. PrintQ admin reviews identity, branch location, prices and one successful
   physical test, then marks the shop `verified`.
6. Only verified shops appear in search. Suspended shops remain accessible to
   staff and existing-order support but cannot accept new orders.

Initial campus data should be curated by PrintQ. Do not use the public
OpenStreetMap Nominatim endpoint for client-side autocomplete: its public usage
policy forbids autocomplete and is intended for limited use. For the pilot, a
manually verified campus list plus browser geolocation requires no map bill.

## Infrastructure required for real orders

### Controlled paid beta (one college, one or two shops)

- Move Render web, PostgreSQL and Key Value off free instances.
- Switch uploads to the existing S3-compatible storage driver using Cloudflare
  R2. Its current free allowance is enough for an early pilot, but billing must
  still be monitored.
- Use a custom domain and serve the PWA from the paid Render app, or move Vercel
  to a commercial plan. Do not run a commercial product on Vercel Hobby.
- Configure real MSG91 OTP delivery. Indian SMS requires DLT entity, sender and
  content-template registration.
- Configure Resend (or another transactional provider) for shop password reset.
- Complete Razorpay KYC, test-mode webhook/refund tests, then switch to live keys.
- Add Sentry/error alerts, uptime checks, database backups and a support contact.

### General availability

- Split the conversion/maintenance workers from the public API after R2 is live,
  so a large DOCX or LibreOffice failure cannot take down student requests.
- Run at least two days of realistic peak-load testing with production-size
  documents and printer-agent disconnects.
- Add an internal admin surface for campuses, verification, suspensions,
  refunds and support lookup. Admin actions need an audit trail.
- Define database restore, stuck-job, duplicate-payment and printer-offline
  runbooks and rehearse them.

## External founder actions

These require account ownership, KYC or business decisions and cannot be safely
completed only in code:

- choose/buy the production domain;
- choose the legal business/entity receiving payments;
- complete Razorpay merchant KYC and settlement-bank setup;
- complete SMS DLT registration and approve the OTP template;
- approve hosting spend and alert limits;
- provide privacy policy, terms, cancellation/refund policy and support details;
- arrange one Windows counter PC and real printer for final hardware acceptance.

## Rollout sequence

### Stage 0 — current test deployment

Invited internal testing only, simulated payments, console OTPs, simulated or
real printer agent. Test data may disappear.

### Stage 1 — closed campus beta

One verified shop, 20–30 students, durable storage/infrastructure, real OTPs,
Razorpay test mode. Measure conversion time, check-in behaviour and support load.

### Stage 2 — real-money pilot

One campus, one or two verified shops, capped daily orders, live payments and
staffed support. Reconcile every payment/order/refund daily for the first week.

### Stage 3 — campus expansion

Add a campus only after a verified shop, printer capacity, support owner and
campus record are ready. Do not show empty/unverified campus directories.

## Launch gates

No real-money launch until all are checked:

- [ ] paid, non-sleeping API; durable PostgreSQL and Key Value;
- [ ] R2/S3 uploads survive deploys and expire according to retention policy;
- [ ] commercial hosting terms are satisfied and custom-domain TLS works;
- [ ] real SMS OTP and password-reset email arrive on multiple devices;
- [ ] Razorpay capture, webhook idempotency, cancellation and refund reconcile;
- [ ] at least one shop is verified and hidden shops cannot appear publicly;
- [ ] physical B/W, colour, duplex, copies and finishing tests pass;
- [ ] campus selection, denied-location and nearby ranking tests pass;
- [ ] accessibility and mobile tests pass on low-end Android and slow networks;
- [ ] privacy/terms/refund/support pages are published;
- [ ] monitoring, backup restore and incident contacts are tested;
- [ ] a peak-load rehearsal passes with no lost or duplicate print.

## Acceptance tests for campus and nearby discovery

- aliases find one canonical campus without duplicate entries;
- a shop can serve multiple campuses but has one physical queue;
- only verified shops appear in public results;
- location denial still produces a complete campus-based journey;
- nearby results display deterministic distances and sensible ordering;
- no student coordinates are stored or included in request URLs/logs;
- paused/offline shops are clearly labelled and sort below operational shops;
- capability filters never offer a print option the connected printer cannot do;
- QR links always open the intended branch, regardless of selected campus;
- upload/payment never enters the physical queue until arrival check-in.

## Success metrics for the first campus

- completed orders / paid orders;
- median upload-to-ready and check-in-to-print times;
- no-show and out-of-order counter-code use rates;
- failed print attempts and successful retry rate;
- payment/refund mismatch count (target: zero);
- support contacts per 100 orders;
- repeat usage within 30 days;
- shop-reported minutes saved during peak periods.

Track product events, not precise student movement.

## Current provider references

- Render free-instance limits: <https://render.com/docs/free>
- Vercel Hobby and commercial-use limits: <https://vercel.com/docs/plans/hobby>
- Cloudflare R2 pricing/free allowance: <https://developers.cloudflare.com/r2/pricing/>
- Nominatim public geocoding policy: <https://operations.osmfoundation.org/policies/nominatim/>
- MSG91 OTP/DLT setup: <https://msg91.com/help/sendotp/step-by-step-process-to-configure-otp>
- Razorpay pricing: <https://razorpay.com/pricing/>
