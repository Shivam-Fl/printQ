# PrintQ production image — single deployable serving the API + built web app
# from one Express process (see apps/api/src/app.ts). See DEPLOY.md.
#
# Default CMD (docker-entrypoint.sh) runs pending migrations then starts the
# API+web+workers process — this is the "web service" mode.
# To run only the BullMQ worker instead (e.g. a separate Render/Fly service
# once you've split it out — see DEPLOY.md's upgrade checklist), override the
# command: node apps/api/dist/worker.js (skip migrations there; the web
# service's entrypoint already ran them).

# ---------- build ----------
FROM node:22-slim AS build
WORKDIR /app

# argon2/sharp ship prebuilt binaries for linux-x64 glibc, but keep a toolchain
# around in case npm falls back to building from source.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# copy just the manifests first so `npm ci` is cached across source-only changes
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/agent/package.json apps/agent/package.json
RUN npm ci

COPY . .
RUN npm run db:generate -w apps/api
# Root build also packages the downloadable Windows print agent before Vite
# copies public assets into the production web bundle.
RUN npm run build
# drop devDependencies in place so the runtime stage can copy node_modules as-is
RUN npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SOFFICE_PATH=/usr/bin/soffice

# libreoffice-writer (not the full `libreoffice` suite) is enough for DOCX->PDF
# and pulls in libreoffice-core; fonts-liberation avoids Calibri/Cambria/Arial
# substitution artifacts in converted documents.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libreoffice-writer \
      fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/web/dist apps/web/dist
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh
# Verify every direct API runtime dependency in the final image, including
# packages npm installs inside the workspace instead of hoisting to the root.
WORKDIR /app/apps/api
RUN node --input-type=module -e "import { readFileSync, accessSync } from 'node:fs'; const pkg = JSON.parse(readFileSync('package.json')); for (const name of Object.keys(pkg.dependencies)) accessSync(new URL(import.meta.resolve(name === 'prisma' ? 'prisma/package.json' : name)));"
WORKDIR /app

EXPOSE 4000
CMD ["./docker-entrypoint.sh"]
