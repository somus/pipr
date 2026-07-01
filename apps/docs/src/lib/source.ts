import { docs } from "collections/server";
import { loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/plugins/lucide-icons";
import { docsRoute } from "./shared";

export const source = loader({
  source: docs.toFumadocsSource(),
  baseUrl: docsRoute,
  plugins: [lucideIconsPlugin()],
});

export function markdownPathToSlugs(segments: string[]) {
  return segments
    .join("/")
    .replace(/\.md$/, "")
    .replace(/^index$/, "")
    .split("/")
    .filter(Boolean);
}

export function slugsToMarkdownPath(slugs: string[]) {
  const path = `${slugs.join("/")}/index`.replace(/^\/index$/, "index").replace(/\/index$/, "");
  const segments = `${path}.md`.split("/");

  return {
    segments,
    url: `${docsRoute}/${segments.join("/")}`,
  };
}

export function getPageImage(page: (typeof source)["$inferPage"]) {
  const segments = [...page.slugs, "image.webp"];

  return {
    segments,
    url: `/og/docs/${segments.join("/")}`,
  };
}

export async function getLLMText(page: (typeof source)["$inferPage"]) {
  const processed = await page.data.getText("processed");

  return `# ${page.data.title} (${page.url})

${processed}`;
}
