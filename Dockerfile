FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS base

USER root
RUN apk add --no-cache bash fd git ripgrep su-exec=0.2-r3 \
  && ln -sf /usr/local/bin/bun /usr/local/bin/node \
  && mkdir -p /home/bun/.pi/agent/bin \
  && ln -sf /usr/bin/rg /home/bun/.pi/agent/bin/rg \
  && ln -sf /usr/bin/fd /home/bun/.pi/agent/bin/fd \
  && chown -R bun:bun /home/bun/.pi \
  && chmod 1777 /tmp

ENV BUN_INSTALL=/usr/local
ENV TMPDIR=/tmp
ENV PIPR_PI_SANDBOX_UID=1000
ENV PIPR_PI_SANDBOX_GID=1000
RUN bun add -g \
  @earendil-works/pi-coding-agent@0.80.10 \
  @earendil-works/pi-ai@0.80.10 \
  @earendil-works/pi-tui@0.80.10 \
  @earendil-works/pi-agent-core@0.80.10 \
  && PI_OFFLINE=1 PI_TELEMETRY=0 pi --help >/dev/null

WORKDIR /opt/pipr

FROM base AS deps
COPY --chown=bun:bun package.json bun.lock turbo.json tsconfig.json tsconfig.base.json ./
COPY --chown=bun:bun apps/docs/package.json apps/docs/package.json
COPY --chown=bun:bun packages/cli/package.json packages/cli/package.json
COPY --chown=bun:bun packages/e2e/package.json packages/e2e/package.json
COPY --chown=bun:bun packages/evals/package.json packages/evals/package.json
COPY --chown=bun:bun packages/runtime/package.json packages/runtime/package.json
COPY --chown=bun:bun packages/sdk/package.json packages/sdk/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY --chown=bun:bun skills skills
COPY --chown=bun:bun packages/cli packages/cli
COPY --chown=bun:bun packages/runtime packages/runtime
COPY --chown=bun:bun packages/sdk packages/sdk
RUN bun run build:packages

FROM base AS prod-deps
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun apps/docs/package.json apps/docs/package.json
COPY --chown=bun:bun packages/cli/package.json packages/cli/package.json
COPY --chown=bun:bun packages/e2e/package.json packages/e2e/package.json
COPY --chown=bun:bun packages/evals/package.json packages/evals/package.json
COPY --chown=bun:bun packages/runtime/package.json packages/runtime/package.json
COPY --chown=bun:bun packages/sdk/package.json packages/sdk/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts \
  --filter=@usepipr/cli \
  --filter=@usepipr/runtime \
  --filter=@usepipr/sdk

FROM build AS evals
COPY --chown=bun:bun packages/evals packages/evals
RUN mkdir -p packages/evals/evalite-export \
  && chown -R bun:bun packages/evals
WORKDIR /opt/pipr/packages/evals
CMD ["bun", "run", "eval:full:export"]

FROM base AS runtime-base
COPY --from=prod-deps --chown=bun:bun /opt/pipr/package.json /opt/pipr/bun.lock ./
COPY --from=prod-deps --chown=bun:bun /opt/pipr/node_modules node_modules
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/cli packages/cli
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/runtime packages/runtime
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/sdk packages/sdk
COPY --from=build --chown=bun:bun /opt/pipr/packages/cli/dist packages/cli/dist
COPY --from=build --chown=bun:bun /opt/pipr/packages/runtime/dist packages/runtime/dist
COPY --from=build --chown=bun:bun /opt/pipr/packages/sdk/dist packages/sdk/dist
RUN chown -R bun:bun /opt/pipr \
  && chmod +x /opt/pipr/packages/cli/dist/main.mjs \
  && ln -sf /opt/pipr/packages/cli/dist/main.mjs /usr/local/bin/pipr \
  && command -v wget >/dev/null \
  && pipr host-run --help >/dev/null \
  && pipr webhook serve --help >/dev/null

FROM runtime-base AS e2e
COPY --chown=bun:bun packages/e2e/action-fixture.ts packages/e2e/action-fixture.ts
COPY --chown=bun:bun packages/e2e/assertions.ts packages/e2e/assertions.ts
COPY --chown=bun:bun packages/e2e/webhook-fetch-mock.ts packages/e2e/webhook-fetch-mock.ts
COPY --chown=bun:bun packages/e2e/webhook-health-fixture.ts packages/e2e/webhook-health-fixture.ts
RUN mkdir -p packages/e2e/node_modules/@usepipr \
  && ln -sf ../../../runtime packages/e2e/node_modules/@usepipr/runtime
WORKDIR /workspace
ENTRYPOINT ["pipr"]

FROM runtime-base AS runtime
WORKDIR /workspace
ENTRYPOINT ["pipr"]
