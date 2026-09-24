# QA environment — printQ

QA runs in **compose mode**: postgres and redis in docker, the API and web app on the runner,
against a database created empty and seeded on every run. Nothing here reaches production.

| | |
|---|---|
| Web | `http://localhost:5173` |
| API | `http://localhost:4000` |
| API log | `/tmp/printq-api.log` |
| Web log | `/tmp/printq-web.log` |
| Postgres | `localhost:15432`, user/db `printq` |
| Redis | `localhost:6380` |

## Logging in as a shop owner

Seeded by `apps/api/prisma/seed.ts` before QA starts. Credentials come from
`$QA_ACCOUNTS` (role `shop_owner`). The seed also creates the shop `demo` and two printers,
so there is a working shop to send jobs to.

## Logging in as a student — read the OTP from the log

**No student is seeded.** Students authenticate by phone + OTP, and `SMS_PROVIDER=console`
means the OTP is printed rather than sent. So:

1. Pick a phone number. Any valid-format number works — the database is empty and yours.
   Use a distinct one per test so accounts never collide: `+91900000{NN}`.
2. Request the OTP through the UI.
3. Read it out of the API log:

```bash
grep -iE "otp" /tmp/printq-api.log | tail -5
```

4. Enter it. The account is created on first successful verification.

If the OTP is not in the log, check `STUDENT_AUTH_PROVIDER=local` and `SMS_PROVIDER=console`
in the generated `.env` — with `firebase` the flow goes through the browser SDK instead and
this recipe does not apply.

**This is a compose-only recipe.** Against production the debugger uses the real test
accounts from secrets; there is no log to read.

## Worth knowing before you write steps

- `OTP_WINDOW_MINUTES=10` — a release OTP expires. A slow test can fail for that reason
  alone, which looks like a bug and is not one.
- The order lifecycle has real states (`refunding`, print failure, arrival queue) added in
  migrations. Read `apps/api/prisma/schema.prisma` before asserting what a status should be.
- Storage is `local` — uploads land in `./storage`, not S3. A file that "uploads" is on disk.
- The agent app (`apps/agent`) is what talks to a physical printer. It is **not** running.
  Anything that waits on a printer to accept a job will hang; that is the environment, not
  a defect. Record it as a `coverage_gap`.

## Known flaky

_(none recorded yet — add entries here as they are found, with the symptom and the workaround)_
