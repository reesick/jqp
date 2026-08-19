# Builds and runs the publishing worker (apps/worker) from the monorepo root.
# Build context MUST be the repo root, e.g.:
#   docker build -f apps/worker/Dockerfile -t jqp-worker .
# Render's Blueprint (render.yaml) is configured with rootDir: . and
# dockerfilePath: apps/worker/Dockerfile for exactly this reason.

FROM node:20-slim AS build
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/core/package.json packages/core/
COPY packages/meta/package.json packages/meta/
COPY packages/storage/package.json packages/storage/
COPY packages/queue/package.json packages/queue/
COPY packages/publisher/package.json packages/publisher/
COPY apps/worker/package.json apps/worker/
RUN npm install

COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps/worker ./apps/worker

RUN npx tsc -p packages/core/tsconfig.json \
 && npx tsc -p packages/meta/tsconfig.json \
 && npx tsc -p packages/storage/tsconfig.json \
 && npx tsc -p packages/queue/tsconfig.json \
 && npx tsc -p packages/publisher/tsconfig.json \
 && npx tsc -p apps/worker/tsconfig.json

FROM node:20-slim AS runtime
WORKDIR /repo
ENV NODE_ENV=production

COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/package.json ./package.json
COPY --from=build /repo/packages ./packages
COPY --from=build /repo/apps/worker ./apps/worker

EXPOSE 8080
CMD ["node", "apps/worker/dist/index.js"]
