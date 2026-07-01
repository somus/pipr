import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import mdx from "fumadocs-mdx/vite";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

const docsContentDirectory = fileURLToPath(new URL("./content/docs", import.meta.url));
const docsPageSlugs = getDocsPageSlugs(docsContentDirectory);
const staticDocsPages = docsPageSlugs.flatMap((slugs) => [
  {
    path: slugs.length ? `/docs/${slugs.join("/")}` : "/docs",
  },
  {
    path: `/docs/${slugsToMarkdownSegments(slugs).join("/")}`,
    prerender: {
      crawlLinks: false,
    },
  },
  {
    path: `/og/docs/${[...slugs, "image.webp"].join("/")}`,
    prerender: {
      crawlLinks: false,
    },
  },
]);

function getDocsPageSlugs(directory: string, parents: string[] = []): string[][] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return getDocsPageSlugs(join(directory, entry.name), [...parents, entry.name]);
    }

    if (!entry.name.endsWith(".mdx")) return [];

    const slug = entry.name.replace(/\.mdx$/, "");
    return [slug === "index" ? parents : [...parents, slug]];
  });
}

function slugsToMarkdownSegments(slugs: string[]) {
  const path = `${slugs.join("/")}/index`.replace(/^\/index$/, "index").replace(/\/index$/, "");
  return `${path}.md`.split("/");
}

export default defineConfig(({ command, isPreview }) => ({
  oxc: {
    jsx: {
      development: false,
    },
  },
  ssr: {
    external: ["@takumi-rs/image-response"],
  },
  server: {
    port: 3000,
    watch: {
      usePolling: true,
      interval: 250,
      ignored: [
        "**/.cache/**",
        "**/.git/**",
        "**/.output/**",
        "**/.turbo/**",
        "**/node_modules/**",
      ],
    },
  },
  plugins: [
    mdx(),
    tailwindcss(),
    tanstackStart({
      spa: {
        enabled: true,
        prerender: {
          enabled: true,
          crawlLinks: true,
        },
      },

      pages: [
        {
          path: "/docs",
        },
        {
          path: "/api/search",
          prerender: {
            crawlLinks: false,
          },
        },
        {
          path: "/llms-full.txt",
          prerender: {
            crawlLinks: false,
          },
        },
        {
          path: "/llms.txt",
          prerender: {
            crawlLinks: false,
          },
        },
        ...staticDocsPages,
      ],
    }),
    react(),
    ...(command === "build" || isPreview
      ? [
          // please see https://tanstack.com/start/latest/docs/framework/react/guide/hosting#nitro for guides on hosting
          ...nitro(),
        ]
      : []),
  ],
  resolve: {
    tsconfigPaths: true,
    alias: {
      tslib: "tslib/tslib.es6.js",
    },
  },
}));
