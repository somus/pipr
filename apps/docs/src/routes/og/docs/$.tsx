import { createFileRoute, notFound } from "@tanstack/react-router";
import { renderDocsOgImage } from "@/lib/og-image";
import { source } from "@/lib/source";

export const Route = createFileRoute("/og/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = ogSegments(params._splat);
        const page = loadOgPage(segments);
        const response = renderDocsOgImage({
          title: page.data.title,
          description: page.data.description ?? "",
        });
        await response.ready;
        return response;
      },
    },
  },
});

function ogSegments(splat: string | undefined): string[] {
  if (splat === undefined) throw notFound();
  const segments = splat.split("/");
  if (segments.at(-1) !== "image.webp") throw notFound();
  return segments.slice(0, -1);
}

function loadOgPage(segments: string[]) {
  const page = source.getPage(segments);
  if (!page) throw notFound();
  return page;
}
