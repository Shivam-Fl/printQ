# PrintQ production image — single deployable serving the API + built web app
# from one Express process (see apps/api/src/app.ts). See DEPLOY.md.
#
# Two ways to run the resulting image:
#   web service:      node apps/api/dist/server.js            (RUN_WORKERS=false)
#   background worker: node apps/api/dist/worker.js

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
RUN npm run build -w packages/shared \
    && npm run build -w apps/api \
    && npm run build -w apps/web
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
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/prisma apps/api/prisma
COPY --from=build /app/apps/web/dist apps/web/dist

EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
