# Built and run with platform: linux/arm64 pinned in docker-compose.yml
# (Oracle Cloud Ampere A1 — see spec §2). No native/arm64-incompatible deps:
# pg is pure JS, no pg-native.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
CMD ["node", "dist/index.js"]
