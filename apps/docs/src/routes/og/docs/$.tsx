import { createFileRoute, notFound } from "@tanstack/react-router";
import { getLegacyDocRedirect } from "@/lib/docs-routes";
import { renderDocsOgImage } from "@/lib/og-image";
import { source } from "@/lib/source";

export const Route = createFileRoute("/og/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = ogSegments(params._splat);
        const redirect = legacyOgRedirect(segments);
        if (redirect) return redirect;
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

function legacyOgRedirect(segments: string[]): Response | undefined {
  const redirectTo = getLegacyDocRedirect(segments);
  if (!redirectTo) return undefined;
  return new Response(null, {
    status: 308,
    headers: { Location: `/og${redirectTo}/image.webp` },
  });
}

function loadOgPage(segments: string[]) {
  const page = source.getPage(segments);
  if (!page) throw notFound();
  return page;
}
