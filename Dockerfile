# Built and run with platform: linux/arm64 pinned in docker-compose.yml
# (Oracle Cloud Ampere A1 — see spec §2). No native/arm64-incompatible deps:
# pg is pure JS, no pg-native.

# UI build runs on the build host's *native* platform (via $BUILDPLATFORM),
# not the arm64 target: this stage has to *execute* esbuild/rollup to bundle
# (vite build), and their native arm64 binaries crash under GitHub Actions'
# QEMU emulation ("qemu: uncaught target signal 4 - Illegal instruction");
# see docs/decisions.md. The build output is static HTML/JS/CSS --
# architecture-independent -- so there's no correctness cost to building it
# natively and copying the result in. The backend `build` stage below uses
# the same $BUILDPLATFORM fix, for the same reason (see its comment).
FROM --platform=$BUILDPLATFORM node:22-alpine AS ui-build
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json ./
RUN npm ci
COPY ui ./
# App.tsx imports resolve/expandRule.ts + resolve/types.ts directly from the
# backend source (plan.md: the UI reaches expandRule/numbering as real
# runtime imports since they're dependency-free, rather than duplicating
# the logic) -- needs the sibling src/ tree physically present for
# TypeScript to resolve those relative imports.
COPY src /app/src
RUN npm run build
# vite.config.ts's outDir "../dist/ui" (relative to WORKDIR /app/ui) lands
# at /app/dist/ui inside this stage.

# Same $BUILDPLATFORM reasoning as ui-build above. --ignore-scripts (skipping
# devDependencies' install-time lifecycle scripts, since this stage only
# ever runs `tsc`) was tried first as a narrower fix, but the QEMU crash
# recurred anyway -- npm ci itself still crashed intermittently under
# emulation while placing esbuild/rollup's arm64 binaries on disk, even
# with their scripts skipped, hanging the job indefinitely (see
# docs/decisions.md). Building natively removes QEMU from this stage
# entirely; the compiled output is plain JS, architecture-independent, so
# there's no correctness cost.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app

# Build backend
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=ui-build /app/dist/ui ./dist/ui
COPY migrations ./migrations
CMD ["node", "dist/index.js"]
