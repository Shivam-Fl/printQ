# PrintQ — Campus Print Queue Platform
### Full build specification & prompt for Claude Code

> **Note to whoever pastes this into Claude Code:** "PrintQ" is a placeholder name — rename freely. This document is meant to be handed to an AI coding agent as the source of truth for the project. It contains the problem, the full architecture, the data model, and a phased build order.

---

## 0. Instructions for the coding agent

You are building an MVP of a print-queue management platform for print shops near schools and colleges. Read this entire document before writing any code.

- Build **Phase 1 only** (see Section 13) unless explicitly told to go further.
- Use the tech stack in Section 12 unless you have a strong technical reason to deviate — if you deviate, explain why before proceeding.
- Ask the user clarifying questions about hosting/deployment environment, domain name, and WhatsApp Business API access before wiring up notifications — these require external account setup that the user must do.
- Treat the data model in Section 7 and the state machine in Section 8 as the backbone of the system — get these right first, UI comes after.
- This is a two-sided marketplace (students + shop owners). Build both sides, but keep the shop owner's interface radically simple — that is the core value proposition (see Section 2).

---

## 1. Problem statement

Print shops near schools and colleges get overwhelmed during assignment/submission deadlines. Dozens of students physically crowd the shop at the same time — in sun, in rain — pushing and shoving to get their documents printed. The shopkeeper has to manually take input from every single student (what file, how many copies, what paper size, color or not, binding or not), which is slow and error-prone, and creates a bottleneck that makes the crowding worse.

## 2. Product vision

Let students prepare and submit their print job — file, copies, paper size, binding, everything — from their phone, before they ever reach the shop. They join a **virtual queue** instead of a physical one. The shop owner's job becomes almost entirely: confirm an OTP, and print.

**For students:** no standing in a crowd, no back-and-forth explaining what you want, know exactly when your print will be ready, optionally schedule it the night before.

**For shop owners:** near-zero extra input per job, jobs arrive already fully specified and payment-confirmed, higher throughput during peak hours, less chaos in the shop.

## 3. Competitive context (why this needs to be good, not just possible)

This space already has real players — the market is validated, not hypothetical:

- **CopyFlow** — a WhatsApp/Telegram-bot based service already live across several Indian college campuses. Students drop a PDF/image into the bot, pick specs in chat, pay via Cashfree, and get an OTP to release the print at a campus kiosk.
- **PrintBuddy** — AI-powered self-serve kiosks, franchise-based rollout, also handles legal document e-stamping.

Neither of them, as far as we know, does the following — which is where this product should differentiate:

1. A genuine **scheduled-slot queue with fair priority logic** (not just an on-demand OTP token) — students can plan ahead and get a real place in line.
2. **Multi-format support including CAD/design files**, normalized server-side into a print-ready PDF so nothing renders wrong on the shop's machine.
3. **Multi-printer, multi-PC load balancing** inside a single shop, with both an automatic and a manual assignment mode.
4. **OTP gates the print action itself**, not just the pickup/release of an already-printed job — this avoids wasted paper/ink on no-shows.

---

## 4. User roles

- **Student** — uploads files, configures print jobs, pays, joins the queue, collects prints.
- **Shop owner / staff** — configures shop and printers, monitors the queue, releases print jobs, marks no-shows.
- **Platform admin** (future, not MVP) — onboards new shops, monitors platform health.

---

## 5. Core user flows

### 5.1 Student flow

1. Open the app/web page for a specific shop (or scan a QR code at the shop).
2. Upload a file — PDF, Word (.docx), image (.jpg/.png), or a design file (CAD, phase 2).
3. Backend converts it into a normalized, print-ready PDF and shows a **preview** — what the student sees is exactly what will print.
4. Student sets specs: number of copies, paper size, color or black & white, single/double-sided, binding/finishing, specific page range if needed.
5. Student sees a live price estimate.
6. Student chooses **Instant** (join the live queue now) or **Scheduled** (pick a future time slot, e.g. the night before an early morning deadline).
7. Student pays online (UPI).
8. Student sees their live queue position and estimated wait time.
9. When it's their turn, they get a WhatsApp/SMS notification: *"Your turn — give this OTP at the shop: XXXX"*.
10. Student reaches the shop, tells the shop owner (or enters at a kiosk) the OTP.
11. Print happens only after OTP is confirmed. Student collects their print.

### 5.2 Shop owner flow

1. One-time setup: register the shop, register each physical printer with its **profile** (paper sizes loaded, color capability, finishing options, status), and set the **auto-assign toggle**.
2. Ongoing: watch the live queue on a dashboard (jobs already fully specified — no need to ask the student anything).
3. When a student arrives and gives their OTP, the shop owner enters it into a single input field.
4. Depending on the auto-assign setting (see 5.4), the job either prints directly or offers a printer dropdown to confirm/override.
5. If a student doesn't show up within the time window, mark the job **no-show** — the queue automatically moves to notify the next student.

### 5.3 OTP-gated release + no-show handling

- A job is fully paid and queued well before it's "live" — it just waits.
- When the job reaches the front of its assigned printer's queue (or its scheduled time arrives), the student is notified.
- A time window (default: configurable, suggest 5–10 minutes) starts. If the OTP is given within that window, printing proceeds.
- If the window expires with no OTP: job is marked **no-show**, and the queue immediately notifies the next student — nothing blocks.
- No-show handling: allow **one free requeue** within a grace period (e.g. next 30 minutes) — this covers genuine delays (traffic, a class running late) without letting one no-show clog the system indefinitely. Beyond that, the job **expires** and the student must resubmit.

### 5.4 Printer assignment — auto vs manual mode

This is a **shop-level setting**, not a per-job choice:

**Auto-assign: ON**
- Requires the shop owner to keep printer profiles accurate.
- After OTP verification, the system automatically picks the best-matching printer (see algorithm in Section 9) and sends the print — **no dropdown shown at all**.
- Safety net: if no eligible printer is found (all offline, or none match the job's specs), the system must **fall back to showing the manual dropdown with a warning**, rather than silently failing.

**Auto-assign: OFF**
- A dropdown of eligible printers is shown every time.
- The system still computes its recommendation in the background and **highlights the top pick** in the dropdown (e.g. "Printer 2 — recommended, shortest wait") — even though the owner has full manual control and must click to confirm.

---

## 6. System architecture

### 6.1 High-level components

- **Student web app** (mobile-first, works as a PWA — avoid forcing an app install for MVP)
- **Shop owner dashboard** (web app)
- **Backend API** (REST + WebSocket for real-time queue updates)
- **File conversion worker** (background job queue — converts uploads to print-ready PDF + generates preview)
- **Notification service** (WhatsApp Business API integration)
- **Payment integration** (UPI via Razorpay or Cashfree)
- **Local print agent** — a lightweight app installed on each shop PC (see 6.2)

### 6.2 Why a local print agent is required

The cloud backend cannot directly control a physical printer unless that printer natively supports cloud printing. So a small agent application must run on the shop's PC(s):

- Maintains a live connection (WebSocket or long-poll) to the backend, scoped to the printers it can reach.
- Sends periodic heartbeats so the backend knows it's online.
- When a job is confirmed (OTP verified + printer assigned), the backend pushes a "print now" command to the correct agent.
- The agent sends the already-converted PDF to the OS print spooler for that specific printer.

### 6.3 Printer & agent topology (many-to-many)

Do **not** model this as a rigid "1 PC = 1 printer" pairing — real shops don't work that way. Instead:

- **Printer** is its own entity (physical device, profile, status).
- **Agent** (a PC running the agent software) has a list of printer IDs it can reach — this naturally supports:
  - One PC driving multiple printers (USB-connected).
  - Multiple PCs sharing access to the same networked printer.
- If more than one agent can reach the same printer, use a short-lived claim/lock on the job (e.g. `claimed_by_agent_id`, first agent to acknowledge wins) to avoid double-dispatch.

---

## 7. Data model

```
Shop
- shop_id (PK)
- name
- address
- college_or_campus_name
- auto_assign_enabled (boolean)
- created_at

Student
- student_id (PK)
- name
- phone_number (used for WhatsApp/OTP delivery)
- created_at

Printer
- printer_id (PK)
- shop_id (FK)
- label                      e.g. "Printer 1 - near entrance"
- paper_sizes_loaded[]       e.g. ["A4", "A3"]
- color_support (boolean)
- currently_loaded_paper     e.g. "A4 plain"
- finishing_options[]        e.g. ["stapling", "spiral_binding"]
- avg_pages_per_minute       (used for ETA calculation)
- status                     enum: online | offline | jammed

Agent
- agent_id (PK)
- shop_id (FK)
- machine_label
- connected_printer_ids[]    (many-to-many with Printer)
- last_heartbeat_at
- status                     enum: online | offline

Job
- job_id (PK)
- shop_id (FK)
- student_id (FK)
- assigned_printer_id (FK, nullable until assigned)
- original_file_url
- converted_pdf_url
- preview_url
- specs                      { copies, paper_size, color, duplex, binding, page_range }
- price
- payment_status             enum: pending | paid | refunded
- payment_id
- mode                       enum: instant | scheduled
- scheduled_time (nullable)
- queue_position
- status                     see Section 8 state machine
- otp_code
- otp_generated_at
- otp_expires_at
- created_at
- updated_at
```

---

## 8. Job state machine

```
pending_payment  →  queued            (on successful payment)
queued           →  notified          (job reaches front of its printer's queue,
                                        or scheduled time arrives)
notified         →  otp_verified      (student gives OTP within the time window)
notified         →  no_show           (time window expires, no OTP given)
no_show          →  requeued          (one free retry within grace period)
no_show          →  expired           (grace period also passes)
requeued         →  queued            (rejoins the line)
otp_verified     →  printing          (agent receives and executes print command)
printing         →  ready_for_pickup  (agent confirms print completed)
ready_for_pickup →  completed         (marked handed over)
queued/notified  →  cancelled         (optional: student cancels before OTP)
```

---

## 9. Queue & printer-assignment logic

**Queue priority (instant vs scheduled):**
- Reserve a configurable percentage of each time-slot's capacity for scheduled jobs (e.g. 50%) so walk-in students during peak hours aren't crowded out entirely, and scheduled students get a real guarantee.
- Compute `queue_position` per assigned printer, pushed live via WebSocket to both the student app and shop dashboard.

**Printer assignment algorithm** (runs whether auto-assign is on or off — only the *action taken* differs, per Section 5.4):
1. Filter printers in the shop where `status = online` **and** capabilities match the job's specs (paper size, color, finishing).
2. Rank the remaining eligible printers by shortest current queue length / fastest estimated completion time.
3. Take the top-ranked printer as the recommendation.
4. If `auto_assign_enabled = true` → assign it directly to the job.
   If `false` → present it as the highlighted default in the dropdown; owner confirms or overrides.
5. If no eligible printer is found in auto mode → fall back to manual dropdown with a warning (never fail silently).

---

## 10. File handling pipeline

1. Student uploads a file (PDF, DOCX, image; CAD/DWG is a Phase 2 item — see Section 13).
2. A background worker converts non-PDF files into a normalized, print-ready PDF (e.g. via headless LibreOffice for documents).
3. Generate a page-count and thumbnail preview so the student can visually confirm before paying — this is what guarantees "what you see is what prints," and removes the need for the shop owner to ever open the original file.
4. Validate the converted file's paper size/orientation against the specs the student selected before allowing checkout.

---

## 11. Notifications (WhatsApp/SMS events)

- Job confirmed and queued (after payment).
- "Your turn — give this OTP: XXXX" (with the expiry window stated).
- No-show warning as the window nears expiry (optional, nice-to-have).
- Marked no-show / requeued.
- Ready for pickup.

**OTP rules:** 4–6 digit numeric code, single-use, tied to `job_id`, short expiry window (configurable, default ~10 minutes from the "notified" event).

---

## 12. Recommended tech stack

| Layer | Recommendation | Why |
|---|---|---|
| Backend | Node.js (Express or NestJS) | Fast to build, huge ecosystem, good WebSocket support |
| Database | PostgreSQL | Relational fit for queue/state/status tracking |
| Real-time | Socket.io / WebSockets | Live queue position updates without polling |
| File storage | S3-compatible (AWS S3 / Cloudflare R2) | Standard, cheap, works with signed URLs |
| File conversion | Background worker + headless LibreOffice, queued via Redis/BullMQ | Reliable async conversion, doesn't block requests |
| Notifications | WhatsApp Business API (via Gupshup, Twilio, or Meta Cloud API) | No app-install friction for students |
| Payments | Razorpay or Cashfree (UPI) | Standard in India, low friction |
| Print agent | Lightweight desktop app (Electron or Python + system tray) | Only way to actually trigger a physical printer |
| Student frontend | Mobile-first PWA | Avoids forcing an app download for a low-frequency-use tool |
| Shop dashboard | Web app | Desktop-first, since shop owners work at a PC anyway |
| Auth | Phone OTP login for students; email/PIN for shop staff | Low friction, matches how OTP is already used elsewhere in the flow |

---

## 13. Build order — phased scope

**Phase 1 (MVP — single shop pilot):**
- Student: upload PDF/Word/image → auto-convert + preview → set specs → pay via UPI → join the **instant** queue (scheduling comes in Phase 2) → get WhatsApp OTP notification when it's their turn.
- Shop: printer profile settings, live queue dashboard, OTP entry field to release a print, auto-assign toggle (if the pilot shop has 2+ printers; trivial with just 1).
- Basic no-show handling: mark no-show, one free requeue.
- Print agent: basic version, can start with a simple 1-agent-to-N-printers mapping.

**Phase 2:**
- Scheduled time slots with the reserved-capacity priority logic (Section 9).
- Full multi-printer, multi-agent many-to-many topology (Section 6.3).
- CAD/design file conversion support (likely via a third-party conversion API rather than building in-house).
- Roll out to additional shops/campuses; consider a WhatsApp-bot ordering path (no app needed at all) as an alternative front door.

**Phase 3:**
- Analytics dashboard for shop owners (revenue, peak-hour patterns).
- Multi-city expansion, lightweight admin panel for platform operations.
- Incentives for off-peak scheduled printing (small discounts to smooth demand).

---

## 14. Non-functional requirements

- **File privacy:** encrypt files in transit and at rest; auto-delete original and converted files a short window after the job is completed (e.g. 24–48 hours).
- **OTP security:** single-use, short expiry, tied to one specific job.
- **Reliability:** detect an agent going offline via missed heartbeats; reassign or alert if it was holding assigned jobs.
- **Scalability:** keep Shop/Printer/Agent modeled as separate, normalized entities from day one (Section 7) so a shop with many printers, or a future multi-shop chain, doesn't require a redesign later.

---

## 15. Definition of done for Phase 1

- [ ] Student can upload a file and see an accurate print preview before paying.
- [ ] Student can pay via UPI and see a live queue position.
- [ ] Student receives a WhatsApp notification with OTP when it's their turn.
- [ ] Shop owner dashboard shows the live queue with zero need to re-ask the student anything.
- [ ] Entering the correct OTP triggers an actual print via the local agent.
- [ ] A no-show can be marked and the queue moves forward automatically.
- [ ] Printer profile settings page exists and feeds the assignment logic.
- [ ] Auto-assign toggle works in both directions, including the manual-mode fallback safety net.