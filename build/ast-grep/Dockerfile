# syntax=docker/dockerfile:1.7

ARG AST_GREP_VERSION=0.45.0

FROM --platform=$TARGETPLATFORM rust:1.88.0-alpine3.22@sha256:9dfaae478ecd298b6b5a039e1f2cc4fc040fc818a2de9aa78fa714dea036574d AS build

ARG AST_GREP_VERSION
ARG TARGETARCH
ENV RUSTUP_TOOLCHAIN=1.88.0

RUN apk add --no-cache build-base \
  && case "$TARGETARCH" in \
    amd64) ln -s /usr/bin/gcc /usr/bin/x86_64-linux-musl-gcc ;; \
    arm64) ln -s /usr/bin/gcc /usr/bin/aarch64-linux-musl-gcc ;; \
    *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
  esac

RUN --mount=type=cache,id=ast-grep-cargo-registry-$TARGETARCH,target=/usr/local/cargo/registry \
  --mount=type=cache,id=ast-grep-cargo-target-$TARGETARCH,target=/tmp/cargo-target \
  CARGO_TARGET_DIR=/tmp/cargo-target \
  cargo install ast-grep --version "$AST_GREP_VERSION" --locked --root /opt/ast-grep \
  && test "$(/opt/ast-grep/bin/ast-grep --version)" = "ast-grep $AST_GREP_VERSION" \
  && /opt/ast-grep/bin/ast-grep outline --help >/dev/null

FROM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

ARG AST_GREP_VERSION

LABEL org.opencontainers.image.title="ast-grep for Alpine" \
  org.opencontainers.image.description="Precompiled ast-grep CLI for Alpine Linux" \
  org.opencontainers.image.source="https://github.com/somus/pipr" \
  org.opencontainers.image.url="https://github.com/ast-grep/ast-grep" \
  org.opencontainers.image.version="$AST_GREP_VERSION" \
  org.opencontainers.image.licenses="MIT"

COPY --from=build /opt/ast-grep/bin/ast-grep /usr/local/bin/ast-grep
RUN test "$(ast-grep --version)" = "ast-grep $AST_GREP_VERSION" \
  && ast-grep outline --help >/dev/null

ENTRYPOINT ["/usr/local/bin/ast-grep"]
