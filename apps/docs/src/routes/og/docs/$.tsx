import { ImageResponse } from "@takumi-rs/image-response";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { generate as DefaultImage } from "fumadocs-ui/og/takumi";
import { getLegacyDocRedirect } from "@/lib/docs-routes";
import { appName } from "@/lib/shared";
import { source } from "@/lib/source";

export const Route = createFileRoute("/og/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = ogSegments(params._splat);
        const redirect = legacyOgRedirect(segments);
        if (redirect) return redirect;
        const response = renderOgImage(loadOgPage(segments));
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

function renderOgImage(page: NonNullable<ReturnType<typeof source.getPage>>) {
  return new ImageResponse(
    <DefaultImage
      title={page.data.title}
      description={page.data.description}
      site={`${appName} Docs`}
      primaryColor="rgba(178, 221, 91, 0.3)"
      primaryTextColor="rgb(178, 221, 91)"
    />,
    {
      width: 1200,
      height: 630,
      format: "webp",
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
      },
    },
  );
}
