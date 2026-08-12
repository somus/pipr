/** @type {import('dependency-cruiser').IConfiguration} */

/**
 * Runtime module order (inner → outer). Each layer may import inward
 * (lower index) but never outward (higher index).
 *
 * Peer leaves (`shared`, `commands`, `publication`) sit at the bottom.
 * `observability` is just above them. `internal` is outermost packaging.
 * There is no `sdk-types/` folder; package-root `types.ts` is a shared
 * facade imported by many layers (not itself a layer folder).
 */
const runtimeLayers = [
  "shared",
  "commands",
  "publication",
  "observability",
  "config",
  "diff",
  "pi",
  "review",
  "hosts",
  "host-run",
  "internal",
];

function layerPath(name) {
  return `^packages/runtime/src/${name}`;
}

const layerOrderRules = runtimeLayers.slice(0, -1).map((fromLayer, index) => {
  const outerLayers = runtimeLayers.slice(index + 1);
  return {
    name: `${fromLayer}-must-not-import-outer-layers`,
    severity: "error",
    comment: `${fromLayer} may import inward layers only; outer layers are forbidden.`,
    from: { path: layerPath(fromLayer) },
    to: { path: outerLayers.map(layerPath).join("|") },
  };
});

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Runtime modules must remain acyclic.",
      from: {},
      to: { circular: true },
    },
    ...layerOrderRules,
    {
      name: "publication-leaf-isolation",
      severity: "error",
      comment:
        "publication/ must stay a leaf: only shared/ (and externals) are allowed inward imports.",
      from: { path: layerPath("publication") },
      to: {
        path: "^packages/runtime/src/",
        pathNot: "^packages/runtime/src/(publication|shared)(?:/|$)",
      },
    },
    {
      name: "review-must-not-import-provider-hosts",
      severity: "error",
      comment:
        "Review core may not import host adapter implementations (hosts/types.ts is the port surface).",
      from: { path: layerPath("review") },
      to: {
        path: "^packages/runtime/src/hosts/(?!types\\.ts$)",
      },
    },
    {
      name: "review-must-not-import-octokit",
      severity: "error",
      comment: "Review core must not depend on GitHub Octokit directly.",
      from: { path: layerPath("review") },
      to: { path: "node_modules/@octokit/rest" },
    },
    {
      name: "review-must-not-import-shared-github",
      severity: "error",
      comment: "Review core must not import shared GitHub helpers.",
      from: { path: layerPath("review") },
      to: { path: "^packages/runtime/src/shared/github" },
    },
  ],
  options: {
    doNotFollow: {
      path: ["node_modules", "dist", "coverage", "\\.turbo"],
    },
    exclude: {
      path: ["\\.test\\.ts$", "/tests/", "node_modules", "dist"],
    },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".mjs"],
    },
  },
};
