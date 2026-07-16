import { docsRoute } from "./shared";

const legacyDocSlugs: Record<string, readonly string[]> = {
  "guide/concepts": ["concepts"],
  "guide/runtime": ["concepts", "runtime"],
  "guide/comments": ["concepts", "comments"],
  "guide/trust-security": ["concepts", "trust-security"],
  "reference/development": ["project", "development"],
};

export function getLegacyDocRedirect(slugs: string[]) {
  const target = legacyDocSlugs[slugs.join("/")];
  if (!target) return;

  return `${docsRoute}/${target.join("/")}`;
}
