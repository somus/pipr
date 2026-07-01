FROM oven/bun:1.3.14-alpine

USER root
RUN apk add --no-cache bash fd git ripgrep \
  && ln -s /usr/local/bin/bun /usr/local/bin/node \
  && mkdir -p /home/bun/.pi/agent/bin \
  && ln -s /usr/bin/rg /home/bun/.pi/agent/bin/rg \
  && ln -s /usr/bin/fd /home/bun/.pi/agent/bin/fd \
  && mkdir -p /home/bun/.tmp \
  && chown -R bun:bun /home/bun/.pi
RUN chown -R bun:bun /home/bun/.tmp

ENV BUN_INSTALL=/usr/local
ENV TMPDIR=/home/bun/.tmp
RUN bun add -g @earendil-works/pi-coding-agent@0.79.5 \
  && PI_OFFLINE=1 PI_TELEMETRY=0 pi --help >/dev/null

COPY --chown=bun:bun . /opt/pipr
WORKDIR /opt/pipr
RUN bun install --frozen-lockfile --ignore-scripts \
  && bun run build:packages \
  && chown -R bun:bun /opt/pipr \
  && chmod +x /opt/pipr/packages/cli/src/main.ts \
  && ln -sf /opt/pipr/packages/cli/src/main.ts /usr/local/bin/pipr \
  && pipr action --help >/dev/null

WORKDIR /workspace
ENTRYPOINT ["pipr"]
