# Built and run with platform: linux/arm64 pinned in docker-compose.yml
# (Oracle Cloud Ampere A1 — see spec §2). No native/arm64-incompatible deps:
# pg is pure JS, no pg-native.

FROM node:22-alpine AS build
WORKDIR /app

# Build backend
COPY package.json package-lock.json ./
# --ignore-scripts: devDependencies pull in esbuild/rollup (via vitest, tsx) purely for
# local dev/test — this stage only ever runs `tsc`. Their postinstall scripts exec a
# native arm64 binary to validate it, which crashes under GitHub Actions' QEMU emulation
# ("qemu: uncaught target signal 4 - Illegal instruction"); skipping lifecycle scripts
# avoids that entirely and is safe since nothing here needs install-time compilation.
RUN npm ci --ignore-scripts
COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
RUN npm run build

# Build frontend
COPY ui/package.json ui/package-lock.json ./ui/
RUN cd ui && npm ci
COPY ui ./ui
RUN cd ui && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
CMD ["node", "dist/index.js"]
