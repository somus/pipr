import { GithubIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link, notFound, redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { staticFunctionMiddleware } from "@tanstack/start-static-server-functions";
import browserCollections from "collections/browser";
import { useFumadocsLoader } from "fumadocs-core/source/client";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  MarkdownCopyButton,
  ViewOptionsPopover,
} from "fumadocs-ui/layouts/docs/page";
import { Suspense } from "react";
import { getMDXComponents } from "@/components/mdx";
import { getLegacyDocRedirect } from "@/lib/docs-routes";
import { baseOptions } from "@/lib/layout.shared";
import { appName, gitConfig } from "@/lib/shared";
import { getPageImage, slugsToMarkdownPath, source } from "@/lib/source";

export const Route = createFileRoute("/docs/$")({
  loader: async ({ params }) => {
    const slugs = params._splat?.split("/") ?? [];
    const redirectTo = getLegacyDocRedirect(slugs);
    if (redirectTo) throw redirect({ href: redirectTo, statusCode: 308 });

    const data = await loader({ data: slugs });
    await clientLoader.preload(data.path);
    return data;
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};

    return {
      meta: [
        {
          title: `${loaderData.title} | ${appName} Docs`,
        },
        {
          name: "description",
          content: loaderData.description,
        },
        {
          property: "og:title",
          content: `${loaderData.title} | ${appName} Docs`,
        },
        {
          property: "og:description",
          content: loaderData.description,
        },
        {
          property: "og:image",
          content: loaderData.imageUrl,
        },
        {
          property: "og:type",
          content: "article",
        },
        {
          name: "twitter:card",
          content: "summary_large_image",
        },
        {
          name: "twitter:title",
          content: `${loaderData.title} | ${appName} Docs`,
        },
        {
          name: "twitter:description",
          content: loaderData.description,
        },
        {
          name: "twitter:image",
          content: loaderData.imageUrl,
        },
      ],
    };
  },
  component: Page,
});

const loader = createServerFn({
  method: "GET",
})
  .validator((slugs: string[]) => slugs)
  .middleware([staticFunctionMiddleware])
  .handler(async ({ data: slugs }) => {
    const page = source.getPage(slugs);
    if (!page) throw notFound();

    return {
      path: page.path,
      title: page.data.title,
      description: page.data.description,
      imageUrl: getPageImage(page).url,
      markdownUrl: slugsToMarkdownPath(page.slugs).url,
      pageTree: await source.serializePageTree(source.getPageTree()),
    };
  });

const clientLoader = browserCollections.docs.createClientLoader({
  component(
    { toc, frontmatter, default: MDX },
    // you can define props for the component
    {
      markdownUrl,
      path,
    }: {
      markdownUrl: string;
      path: string;
    },
  ) {
    return (
      <DocsPage className="pipr-docs-page" footer={{ className: "pipr-docs-footer" }} toc={toc}>
        <DocsTitle className="pipr-docs-title">{frontmatter.title}</DocsTitle>
        <DocsDescription className="pipr-docs-description">
          {frontmatter.description}
        </DocsDescription>
        <div className="pipr-docs-actions -mt-4 flex flex-row items-center gap-2 border-b pb-6">
          <MarkdownCopyButton markdownUrl={markdownUrl} />
          <ViewOptionsPopover
            markdownUrl={markdownUrl}
            githubUrl={`https://github.com/${gitConfig.user}/${gitConfig.repo}/blob/${gitConfig.branch}/apps/docs/content/docs/${path}`}
          />
        </div>
        <DocsBody className="pipr-docs-body">
          <MDX components={getMDXComponents()} />
        </DocsBody>
      </DocsPage>
    );
  },
});

function Page() {
  const { pageTree, path, markdownUrl } = useFumadocsLoader(Route.useLoaderData());

  return (
    <DocsLayout
      {...baseOptions()}
      githubUrl={undefined}
      sidebar={{
        footer: (
          <a
            className="inline-flex w-full items-center gap-2 rounded-lg border bg-fd-secondary/50 px-3 py-2 text-fd-muted-foreground transition-colors hover:bg-fd-accent/50 hover:text-fd-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring"
            href={`https://github.com/${gitConfig.user}/${gitConfig.repo}`}
            rel="noreferrer"
            target="_blank"
          >
            <HugeiconsIcon icon={GithubIcon} size={16} strokeWidth={1.8} aria-hidden="true" />
            <span>GitHub</span>
          </a>
        ),
      }}
      tree={pageTree}
    >
      <Link to={markdownUrl} hidden />
      <Suspense>{clientLoader.useContent(path, { markdownUrl, path })}</Suspense>
    </DocsLayout>
  );
}
