#!/bin/sh
# Runs pending migrations, then starts the server. Used as the image's CMD
# instead of a render.yaml preDeployCommand (which needs a paid Render plan) —
# see DEPLOY.md. Idempotent: a no-op if nothing's pending, so it's safe to run
# on every cold start/restart, not just on deploy.
set -e
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
exec node apps/api/dist/server.js
