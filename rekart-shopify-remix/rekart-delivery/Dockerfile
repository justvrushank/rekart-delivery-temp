# syntax=docker/dockerfile:1

# ── Build stage ──────────────────────────────────────────────────────────────
# Needs the full dependency set: `react-router build` uses @react-router/dev +
# vite (devDependencies), and `prisma generate` needs the prisma CLI.
FROM node:20-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app

COPY package.json package-lock.json* ./
# The root package.json declares `workspaces: ["extensions/*"]`, so npm ci needs
# each workspace's manifest present to resolve the lockfile. Copy the (small)
# extensions tree before install.
COPY extensions ./extensions
RUN npm ci

COPY . .
# Generate the Prisma client against the MySQL schema, then build the app.
RUN npx prisma generate && npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
# Carries the built server + node_modules (incl. the Prisma CLI, used by
# `prisma migrate deploy` on container start). openssl is required by Prisma.
FROM node:20-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json* ./
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/public ./public

EXPOSE 3000

# docker-start = prisma generate && prisma migrate deploy && react-router-serve.
# migrate deploy applies the committed MySQL migrations once the DB is reachable.
CMD ["npm", "run", "docker-start"]
