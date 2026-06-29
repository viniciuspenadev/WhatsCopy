# syntax=docker/dockerfile:1.7
# ============================================================
# WhatsCopy — multi-stage Dockerfile for EasyPanel / VPS
# ============================================================
# Stages:
#   1. deps    — install node_modules from the lockfile
#   2. builder — `next build` → .next/standalone
#   3. runner  — minimal runtime image
#
# NEXT_PUBLIC_* vars are INLINED into the client bundle at BUILD time, so
# they must be passed as build ARGs. Server-only secrets (service-role key,
# ENCRYPTION_KEY, EVOLUTION_API_KEY, ASAAS_*, etc.) are runtime-only — set
# them under "Environment" in EasyPanel, NOT as build args.

FROM node:22-alpine AS base
RUN apk add --no-cache libc6-compat
WORKDIR /app

# ── Stage 1: deps ────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
# `npm install` (not `npm ci`) because a lockfile generated on Windows omits
# Linux-only optional deps (e.g. @tailwindcss/oxide / lightningcss musl
# binaries). On Alpine, install resolves the correct optional deps.
RUN npm install --ignore-scripts --no-audit --no-fund --prefer-offline

# ── Stage 2: builder ─────────────────────────────────────────────
FROM base AS builder

# Public build args — inlined into the client bundle. Safe to expose
# (anon key is public). Set these as BUILD ARGS in EasyPanel.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY

ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

# ── Stage 3: runner ──────────────────────────────────────────────
FROM base AS runner

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Non-root user
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

# Public assets + standalone server + static chunks
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static     ./.next/static

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
