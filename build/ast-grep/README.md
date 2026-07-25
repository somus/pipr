# ast-grep Alpine image

This build context publishes a statically linked ast-grep CLI for Alpine Linux
on AMD64 and ARM64. Pipr maintainers publish it to
`ghcr.io/somus/ast-grep`, which is a public GHCR package.

## Build and test locally

Set the version once, then build the current Docker architecture:

```bash
AST_GREP_VERSION=0.45.0

docker buildx build \
  --build-arg "AST_GREP_VERSION=${AST_GREP_VERSION}" \
  --load \
  --tag "pipr-ast-grep:${AST_GREP_VERSION}" \
  build/ast-grep

docker run --rm "pipr-ast-grep:${AST_GREP_VERSION}" --version
docker run --rm "pipr-ast-grep:${AST_GREP_VERSION}" outline --help
```

## Publish to GHCR

Authenticate Docker to `ghcr.io`. If `docker buildx ls` shows that the active
builder uses the `docker` driver, create a reusable multi-platform builder:

```bash
docker buildx create \
  --driver docker-container \
  --name pipr-ast-grep \
  --use
docker buildx inspect --bootstrap
```

Then publish the immutable Alpine version tag and the moving Alpine
compatibility tag:

```bash
AST_GREP_VERSION=0.45.0
ALPINE_VERSION=3.22

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg "AST_GREP_VERSION=${AST_GREP_VERSION}" \
  --provenance=mode=max \
  --sbom=true \
  --tag "ghcr.io/somus/ast-grep:${AST_GREP_VERSION}-alpine${ALPINE_VERSION}" \
  --tag "ghcr.io/somus/ast-grep:${AST_GREP_VERSION}-alpine" \
  --push \
  build/ast-grep
```

The default version in the Dockerfile should match the most recently published
image. When ast-grep requires a newer Rust or Alpine release, update and verify
the pinned builder and runtime image digests in the same change.

GHCR visibility belongs to the package rather than an individual image version,
so new tags inherit the package's public visibility. If the package is deleted
and recreated, change its visibility back to public in the package settings
after the first push.

## Update Pipr

After publishing a new version, resolve its multi-platform digest:

```bash
docker buildx imagetools inspect \
  "ghcr.io/somus/ast-grep:${AST_GREP_VERSION}-alpine${ALPINE_VERSION}"
```

Update Pipr's root Dockerfile to the new immutable tag and digest, update the
expected version in `packages/e2e/container-check.ts`, and align the documented
Docker Action version before running `bun run docker:e2e` and
`mise run check-actions`.
