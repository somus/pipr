import { createFileRoute, notFound } from "@tanstack/react-router";
import { getLegacyDocRedirect } from "@/lib/docs-routes";
import { getLLMText, markdownPathToSlugs, source } from "@/lib/source";

export const Route = createFileRoute("/docs/{$}.md")({
  server: {
    handlers: {
      GET: async ({ params }) => {
        const slugs = markdownPathToSlugs(params._splat?.split("/") ?? []);
        const redirectTo = getLegacyDocRedirect(slugs);
        if (redirectTo) {
          return new Response(null, {
            status: 308,
            headers: { Location: `${redirectTo}.md` },
          });
        }

        const page = source.getPage(slugs);
        if (!page) throw notFound();

        return new Response(await getLLMText(page), {
          headers: {
            "Content-Type": "text/markdown",
          },
        });
      },
    },
  },
});
