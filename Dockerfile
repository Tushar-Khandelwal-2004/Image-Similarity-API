FROM node:22-bookworm-slim AS base

WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS prod-deps
RUN pnpm prune --prod

FROM deps AS dev
COPY . .
ENV NODE_ENV=development
ENV PORT=3000
CMD ["pnpm", "exec", "tsx", "watch", "src/server.ts"]

FROM deps AS model
COPY scripts/download-model.ts ./scripts/download-model.ts
RUN mkdir -p /app/model-cache
ENV TRANSFORMERS_CACHE=/app/model-cache
RUN pnpm exec tsx scripts/download-model.ts

FROM deps AS build
COPY . .
RUN pnpm run build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=model --chown=node:node /app/model-cache ./model-cache

ENV NODE_ENV=production
ENV PORT=7860
ENV TRANSFORMERS_CACHE=/app/model-cache
EXPOSE 7860
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:7860/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

CMD ["node", "dist/src/server.js"]
