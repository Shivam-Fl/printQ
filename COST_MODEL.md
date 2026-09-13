# PrintQ operating-cost model

Planning snapshot: 13 September 2026. Re-check vendor prices before each campus
launch. INR conversions below use a deliberately round **₹90 / USD** planning
rate; the actual card/bank conversion will vary.

## Recommended production shape

Keep the transactional print workflow on Postgres + Redis + the existing Node
API. Use Firebase only for phone-number verification, and use R2 for short-lived
documents. A full Firestore migration would be a large rewrite and would not
remove the need for container compute: LibreOffice conversion, BullMQ jobs,
WebSockets, and printer-agent dispatch still need a long-running backend.

Minimum responsible launch deployment:

- Render 1 CPU / 2 GB combined API + conversion worker: about **$25/month**.
- Render Postgres: start at **$6-$19/month**, then resize from measured CPU,
  memory, connections, and storage rather than user count alone.
- Render persistent 256 MB Key Value: **$10/month**.
- Cloudflare R2: normally **$0** initially because its standard tier includes
  10 GB-month storage, 1M writes, 10M reads, and free egress.
- Vercel: use a commercial plan or serve the built PWA from the Render service;
  Hobby is for personal/non-commercial use.

That makes the practical backend floor approximately **$41-$54/month
(₹3,700-₹4,900)** before OTP, payment-gateway fees, email, monitoring, support,
or tax. The current all-free stack is suitable only for testing.

## Volume assumptions

- 2 paid print orders per monthly active student.
- ₹80 average order value.
- 5 MB of source/converted/preview data per order, deleted after 24 hours.
- Firebase trusted-device sessions are retained, so only new devices, cleared
  browser data, explicit logout, or abuse recovery cause another SMS.
- The table conservatively budgets OTP SMS at 35% of MAU per month. During a
  fast launch month, OTP volume can be close to 100% of MAU.
- Firebase's first 10 SMS/day are free at the project level (about 300/month),
  shared with Packkar. India phone-auth SMS are then $0.07 each.
- Razorpay standard domestic pricing is 2% plus 18% GST on the fee: an effective
  2.36% of GMV before any negotiated discount.
- Razorpay Route/Direct Transfer charges are not included below because public
  standard checkout pricing does not establish the account-specific Route fee.
  Confirm that commercial term before launch.

## Monthly planning ranges

| Stage | MAU | Orders | Render/R2 allowance | Firebase OTP at 35% MAU | Razorpay at ₹80 avg. order | Total platform cost* |
|---|---:|---:|---:|---:|---:|---:|
| One-campus pilot | 500 | 1,000 | $41-$54 | $0 | ₹1,888 | ₹5,600-₹6,800 |
| Established campus | 5,000 | 10,000 | $79-$120 | $102 | ₹18,880 | ₹35,200-₹38,900 |
| Multi-campus | 25,000 | 50,000 | $200-$350 | $592 | ₹94,400 | ₹1.66L-₹1.79L |

\*Includes Render/R2, modeled Firebase SMS, and Razorpay fees. Excludes printing
paper/toner, shop payouts, GST/accounting treatment, customer support, refunds,
chargebacks, email upgrades, observability upgrades, and company overhead.

## What actually drives the bill

1. **Payments, not servers.** At ₹80/order, Razorpay costs about ₹1.89/order at
   list price. Negotiate once GMV exceeds ₹5 lakh/month and consider a prepaid
   campus wallet/top-up only after legal and accounting review; never mark a
   payment paid from the browser.
2. **Firebase SMS can become expensive.** Every 1,000 billable India OTP messages
   cost about $70 (₹6,300). Preserve trusted-device sessions, cap retries, allow
   only India, monitor sent-vs-verified SMS, and set a Google Cloud budget alert.
3. **Document storage is cheap when retention works.** At 50,000 orders/month and
   24-hour deletion, average stored data remains roughly 8-9 GB under these
   assumptions, inside R2's storage free tier. Failed cleanup must be alerted.
4. **Conversion determines compute.** Scale worker concurrency from measured
   conversion time and peak orders per minute. Do not autoscale only from MAU.
5. **Database/Redis reliability is a launch requirement.** Free Render Postgres
   expires and free Key Value is non-persistent; both can lose or block real jobs.

## Marketplace unit economics

The shop sets its own private base by paper type, colour/B/W and finishing. With
the default 25% markup, a ₹2.00 shop base becomes a single ₹2.50 student price.
The successful print credits ₹2.00 to the shop ledger; the gross PrintQ margin is
₹0.50 before checkout fees, Route fees, refunds, taxes and support. At standard
domestic checkout pricing, the modeled payment cost on ₹2.50 is roughly ₹0.059,
leaving about ₹0.441 before the other costs. This is why the gateway fee is tracked
separately and absorbed by PrintQ rather than deducted from the shop's promised base.

Students never receive this split. Public options expose capabilities only, and
student quote/order/receipt surfaces expose one final payable amount. Shop owners
see only their private base earnings and aggregate payout ledger in the owner area.

## Firebase versus Render decision

Firebase is useful here for OTP and push, not as a blanket backend replacement.
Firestore's free allowance is attractive, but moving PrintQ's queue/payment state
from relational transactions to document workflows increases correctness risk and
still leaves conversion and printer dispatch on Cloud Run or another container.
The current hybrid keeps the expensive rewrite-me-later parts replaceable:
Firebase proves the phone, PrintQ owns authorization and orders, Razorpay proves
payment, and the shop agent proves physical printing.

## Price sources

- Firebase pricing and quotas: https://firebase.google.com/pricing
- India phone-auth SMS price: https://cloud.google.com/identity-platform/pricing
- Render pricing and free-tier limits: https://render.com/pricing and
  https://render.com/docs/free
- Cloudflare R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Razorpay pricing: https://razorpay.com/pricing/
