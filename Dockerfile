FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0 AS base

USER root
RUN apk add --no-cache bash fd git ripgrep \
  && ln -sf /usr/local/bin/bun /usr/local/bin/node \
  && mkdir -p /home/bun/.pi/agent/bin /home/bun/.tmp \
  && ln -sf /usr/bin/rg /home/bun/.pi/agent/bin/rg \
  && ln -sf /usr/bin/fd /home/bun/.pi/agent/bin/fd \
  && chown -R bun:bun /home/bun/.pi /home/bun/.tmp

ENV BUN_INSTALL=/usr/local
ENV TMPDIR=/home/bun/.tmp
RUN bun add -g @earendil-works/pi-coding-agent@0.80.3 \
  && PI_OFFLINE=1 PI_TELEMETRY=0 pi --help >/dev/null

WORKDIR /opt/pipr

FROM base AS betterleaks
ARG BETTERLEAKS_VERSION=1.6.1
ARG TARGETARCH
RUN apk add --no-cache curl \
  && case "$TARGETARCH" in \
    amd64) asset_arch=x64; checksum=fbefc700a0bd4522cc952dd2a8f259cdb80526d7e60114aca19bb2d6fdc80f81 ;; \
    arm64) asset_arch=arm64; checksum=bab9688ba968264ace67b608fc7a7d8f5e61218cde70029d32cbc894e3808fdf ;; \
    *) echo "Unsupported Betterleaks architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && archive="betterleaks_${BETTERLEAKS_VERSION}_linux_${asset_arch}.tar.gz" \
  && curl --fail --location --retry 3 \
    "https://github.com/betterleaks/betterleaks/releases/download/v${BETTERLEAKS_VERSION}/${archive}" \
    --output "/tmp/${archive}" \
  && echo "${checksum}  /tmp/${archive}" | sha256sum -c - \
  && tar -xzf "/tmp/${archive}" -C /usr/local/bin betterleaks \
  && chmod 0755 /usr/local/bin/betterleaks \
  && test "$(betterleaks version)" = "$BETTERLEAKS_VERSION"

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

FROM base AS runtime-base
COPY --from=betterleaks /usr/local/bin/betterleaks /usr/local/bin/betterleaks
COPY --from=prod-deps --chown=bun:bun /opt/pipr/package.json /opt/pipr/bun.lock ./
COPY --from=prod-deps --chown=bun:bun /opt/pipr/node_modules node_modules
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/cli packages/cli
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/runtime packages/runtime
COPY --from=prod-deps --chown=bun:bun /opt/pipr/packages/sdk packages/sdk
COPY --from=build --chown=bun:bun /opt/pipr/packages/cli/dist packages/cli/dist
COPY --from=build --chown=bun:bun /opt/pipr/packages/runtime/dist packages/runtime/dist
COPY --from=build --chown=bun:bun /opt/pipr/packages/sdk/dist packages/sdk/dist
COPY --from=build --chown=bun:bun /opt/pipr/packages/runtime/assets/betterleaks.toml packages/runtime/betterleaks.toml
COPY --from=build /opt/pipr/packages/runtime/assets/betterleaks.LICENSE /usr/local/share/licenses/betterleaks/LICENSE
RUN chown -R bun:bun /opt/pipr \
  && chmod +x /opt/pipr/packages/cli/dist/main.mjs \
  && ln -sf /opt/pipr/packages/cli/dist/main.mjs /usr/local/bin/pipr \
  && betterleaks version >/dev/null \
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
