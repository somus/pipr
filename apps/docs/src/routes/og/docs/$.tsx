import { ImageResponse } from "@takumi-rs/image-response";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { generate as DefaultImage } from "fumadocs-ui/og/takumi";
import { appName } from "@/lib/shared";
import { source } from "@/lib/source";

export const Route = createFileRoute("/og/docs/$")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const segments = params._splat?.split("/") ?? [];
        if (segments.at(-1) !== "image.webp") throw notFound();

        const page = source.getPage(segments.slice(0, -1));
        if (!page) throw notFound();

        const response = new ImageResponse(
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

        await response.ready;
        return response;
      },
    },
  },
});
