FROM node:22.23.1-alpine AS builder

RUN corepack enable \
    && corepack prepare pnpm@11.15.0 --activate

WORKDIR /workspace

COPY . .

RUN pnpm install --frozen-lockfile

RUN pnpm --filter api exec prisma generate

RUN pnpm --filter api build


FROM node:22.23.1-alpine AS runtime

RUN corepack enable \
    && corepack prepare pnpm@11.15.0 --activate

ENV NODE_ENV=production
ENV PORT=3100

WORKDIR /workspace

COPY --from=builder /workspace/node_modules ./node_modules
COPY --from=builder /workspace/apps/api ./apps/api
COPY --from=builder /workspace/package.json ./package.json
COPY --from=builder /workspace/pnpm-workspace.yaml ./pnpm-workspace.yaml

COPY --from=builder /workspace/infra/docker/api-entrypoint.sh /usr/local/bin/psop-api-entrypoint

RUN chmod +x /usr/local/bin/psop-api-entrypoint

WORKDIR /workspace/apps/api

EXPOSE 3100

ENTRYPOINT ["psop-api-entrypoint"]
CMD ["node", "dist/main"]
