import { docsRoute, gitConfig } from "./shared.js";

export type DocsRedirect = {
  markdown: string;
  og: string;
  page: string;
};

const repositoryUrl = `https://github.com/${gitConfig.user}/${gitConfig.repo}`;
const rawRepositoryUrl = `https://raw.githubusercontent.com/${gitConfig.user}/${gitConfig.repo}/${gitConfig.branch}`;

export const legacyDocSlugs: Record<string, DocsRedirect> = {
  "guide/concepts": docsRedirect("concepts"),
  "guide/runtime": docsRedirect("concepts/runtime"),
  "guide/comments": docsRedirect("concepts/comments"),
  "guide/trust-security": docsRedirect("concepts/trust-security"),
  "reference/development": repositoryFileRedirect("CONTRIBUTING.md"),
  "reference/architecture": docsRedirect("concepts/runtime"),
  "reference/code-host-adapters": docsRedirect("guide"),
  project: {
    page: repositoryUrl,
    markdown: `${rawRepositoryUrl}/README.md`,
    og: `/og${docsRoute}/image.webp`,
  },
  "project/contributing": repositoryFileRedirect("CONTRIBUTING.md"),
  "project/development": repositoryFileRedirect("CONTRIBUTING.md"),
  "project/security": repositoryFileRedirect("SECURITY.md"),
  "project/changelog": repositoryFileRedirect("CHANGELOG.md"),
};

export function getLegacyDocRedirect(slugs: string[]) {
  return legacyDocSlugs[slugs.join("/")];
}

function docsRedirect(path: string): DocsRedirect {
  return {
    page: `${docsRoute}/${path}`,
    markdown: `${docsRoute}/${path}.md`,
    og: `/og${docsRoute}/${path}/image.webp`,
  };
}

function repositoryFileRedirect(path: string): DocsRedirect {
  return {
    page: `${repositoryUrl}/blob/${gitConfig.branch}/${path}`,
    markdown: `${rawRepositoryUrl}/${path}`,
    og: `/og${docsRoute}/image.webp`,
  };
}
