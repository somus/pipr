import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { supportedOfficialInitAdapters } from "../../../packages/runtime/src/config/init.js";
import { supportedOfficialInitRecipes } from "../../../packages/runtime/src/config/recipes.js";
import { getLegacyDocRedirect } from "../src/lib/docs-routes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const docsDir = process.env.PIPR_DOCS_CONTENT_DIR ?? path.join(repoRoot, "apps/docs/content/docs");
const publicDir = process.env.PIPR_DOCS_PUBLIC_DIR ?? path.join(repoRoot, "apps/docs/public");
const externalMode = process.argv.includes("--external");
const errors: string[] = [];

const docFiles = await globFiles(docsDir, "**/*.mdx");
const pages = new Map<string, { anchors: Set<string>; file: string; source: string }>();

for (const file of docFiles) {
  const source = await readFile(file, "utf8");
  pages.set(routeForFile(file), {
    anchors: extractAnchors(source),
    file,
    source,
  });
}

for (const [route, page] of pages) {
  checkInternalLinks(route, page);
  await checkImageAssets(page);
}

checkOfficialCoverage();
await checkSetupSkillCoverage();

if (externalMode) {
  await checkExternalLinks();
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.log(
    `Docs content check passed: ${pages.size} routes${externalMode ? " with external links" : ""}.`,
  );
}

async function globFiles(directory: string, pattern: string): Promise<string[]> {
  const glob = new Bun.Glob(pattern);
  const files: string[] = [];
  for await (const relative of glob.scan({ cwd: directory, onlyFiles: true })) {
    files.push(path.join(directory, relative));
  }
  return files.sort();
}

function routeForFile(file: string): string {
  const relative = path
    .relative(docsDir, file)
    .split(path.sep)
    .join("/")
    .replace(/\.mdx$/, "");
  const route = relative.replace(/(^|\/)index$/, "").replace(/\/$/, "");
  return route ? `/docs/${route}` : "/docs";
}

function extractAnchors(source: string): Set<string> {
  const anchors = new Set<string>();
  const counts = new Map<string, number>();
  const content = source.replace(/^\s*```[\s\S]*?^\s*```\s*$/gm, "");

  for (const match of content.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)) {
    const base = slugify(match[1]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }

  return anchors;
}

function slugify(value: string): string {
  return value
    .replace(/<[^>]+>/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/[\s-]+/g, "-");
}

function checkInternalLinks(
  sourceRoute: string,
  page: { anchors: Set<string>; file: string; source: string },
): void {
  for (const link of extractDocsLinks(page.source)) checkInternalLink(sourceRoute, page, link);
}

function extractDocsLinks(source: string): Set<string> {
  const links = new Set<string>();
  for (const pattern of [/\]\((\/docs[^)\s]*)\)/g, /href=["'](\/docs[^"']*)["']/g]) {
    for (const match of source.matchAll(pattern)) links.add(match[1]);
  }
  return links;
}

function checkInternalLink(
  sourceRoute: string,
  page: { anchors: Set<string>; file: string },
  link: string,
): void {
  const [rawPath, anchor] = link.split("#", 2);
  const route = normalizeDocsRoute(rawPath);
  const slugs = route
    .replace(/^\/docs\/?/, "")
    .split("/")
    .filter(hasText);
  const legacy = getLegacyDocRedirect(slugs);
  if (legacy) {
    errors.push(`${relative(page.file)}: stale docs link ${link}; use ${legacy}`);
    return;
  }
  const target = pages.get(route);
  if (!target) {
    errors.push(`${relative(page.file)}: broken docs route ${link} from ${sourceRoute}`);
    return;
  }
  checkAnchor(target.anchors, anchor, page.file, link);
}

function normalizeDocsRoute(rawPath: string): string {
  const route = rawPath.replace(/\.md$/, "").replace(/\/$/, "");
  return route.length === 0 ? "/docs" : route;
}

function hasText(value: string): boolean {
  return value.length > 0;
}

function checkAnchor(anchors: Set<string>, anchor: string | undefined, file: string, link: string) {
  if (!anchor) return;
  if (!anchors.has(anchor)) errors.push(`${relative(file)}: broken anchor ${link}`);
}

async function checkImageAssets(page: { file: string; source: string }): Promise<void> {
  for (const match of page.source.matchAll(/src=["'](\/images\/[^"']+)["']/g)) {
    const asset = path.join(publicDir, match[1].replace(/^\//, ""));
    try {
      await access(asset);
    } catch {
      errors.push(`${relative(page.file)}: missing image ${match[1]}`);
    }
  }
}

async function checkSetupSkillCoverage(): Promise<void> {
  const skillFiles = [
    path.join(repoRoot, "skills/pipr-setup/SKILL.md"),
    path.join(repoRoot, "skills/pipr-setup/references/config-patterns.md"),
    path.join(repoRoot, "skills/pipr-setup/references/recipes.md"),
  ];
  const source = (await Promise.all(skillFiles.map((file) => readFile(file, "utf8")))).join("\n");

  checkReferences(source, supportedOfficialInitRecipes, "recipe");
  checkReferences(source, supportedOfficialInitAdapters, "adapter");
}

function checkReferences(source: string, values: readonly string[], kind: string): void {
  for (const value of values) {
    if (!source.includes(`\`${value}\``))
      errors.push(`skills/pipr-setup: missing official ${kind} ${value}`);
  }
}

function checkOfficialCoverage(): void {
  for (const recipe of supportedOfficialInitRecipes) checkRecipeCoverage(recipe);
  for (const adapter of supportedOfficialInitAdapters) checkAdapterCoverage(adapter);
}

function checkRecipeCoverage(recipe: string): void {
  const route = `/docs/recipes/${recipe}`;
  const page = pages.get(route);
  if (!page) {
    errors.push(`recipes: missing generated route ${route}`);
    return;
  }
  const image = `/images/pipr/recipes/${recipe}.png`;
  if (!page.source.includes(`src="${image}"`)) {
    errors.push(`${relative(page.file)}: missing official recipe image reference ${image}`);
  }
}

function checkAdapterCoverage(adapter: string): void {
  const route = adapterGuideRoute(adapter);
  const page = pages.get(route);
  if (!page) {
    errors.push(`adapters: missing provider guide ${route}`);
    return;
  }
  for (const view of ["review", "inline"]) {
    checkProviderImage(page, adapter, view);
  }
}

function adapterGuideRoute(adapter: string): string {
  if (adapter === "github") return "/docs/guide/github-action";
  return `/docs/guide/${adapter}`;
}

function checkProviderImage(
  page: { file: string; source: string },
  adapter: string,
  view: string,
): void {
  const image = `/images/pipr/providers/${adapter}-${view}.png`;
  if (!page.source.includes(`src="${image}"`)) {
    errors.push(`${relative(page.file)}: missing provider image reference ${image}`);
  }
}

async function checkExternalLinks(): Promise<void> {
  const markdownFiles = [
    ...(await globFiles(repoRoot, "*.md")),
    ...(await globFiles(path.join(repoRoot, "apps/docs/content/docs"), "**/*.mdx")),
    ...(await globFiles(path.join(repoRoot, "docs"), "**/*.md")),
    ...(await globFiles(path.join(repoRoot, "packages"), "**/README.md")),
    ...(await globFiles(path.join(repoRoot, "skills"), "**/*.md")),
  ];
  const urls = new Map<string, string>();

  for (const file of markdownFiles) {
    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/https:\/\/[^\s)>'"`]+/g)) {
      const url = match[0].replace(/[.,;:]$/, "");
      if (!skipExternalUrl(url)) urls.set(url, file);
    }
  }

  const entries = [...urls.entries()];
  const concurrency = 6;
  await Promise.all(
    Array.from({ length: concurrency }, (_, index) =>
      runExternalWorker(entries, index, concurrency),
    ),
  );
}

async function runExternalWorker(
  entries: [string, string][],
  start: number,
  step: number,
): Promise<void> {
  for (let index = start; index < entries.length; index += step) {
    const entry = entries[index];
    if (entry) await checkExternalEntry(entry);
  }
}

async function checkExternalEntry([url, file]: [string, string]): Promise<void> {
  try {
    const response = await fetchExternalUrl(url);
    checkExternalStatus(url, file, response.status);
  } catch (error) {
    errors.push(`${relative(file)}: external link ${url} failed: ${errorMessage(error)}`);
  }
}

async function fetchExternalUrl(url: string): Promise<Response> {
  const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
  if (response.status === 405) return await fetch(url, { signal: AbortSignal.timeout(15_000) });
  return response;
}

function checkExternalStatus(url: string, file: string, status: number): void {
  if ([401, 403, 429].includes(status)) return;
  if (status >= 400) errors.push(`${relative(file)}: external link ${url} returned ${status}`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function skipExternalUrl(url: string): boolean {
  if (/[<{]|\.\.\./.test(url)) return true;
  try {
    const parsed = new URL(url);
    return ["example.com", "localhost", "127.0.0.1"].includes(parsed.hostname);
  } catch {
    return true;
  }
}

function relative(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}
