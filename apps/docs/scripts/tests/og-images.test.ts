import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderDocsOgImage } from "../../src/lib/og-image";
import { assertDocsOgImages, generateDocsOgImages, inspectWebp } from "../og-images";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })),
  );
  temporaryDirectories.clear();
});

describe("documentation OG images", () => {
  it("accepts complete 1200 by 630 WebP output and rejects corrupt containers", async () => {
    const response = renderDocsOgImage({
      title: "Pipr",
      description: "Code-owned AI review.",
    });
    await response.ready;
    const valid = new Uint8Array(await response.arrayBuffer());

    expect(inspectWebp(valid)).toEqual({ height: 630, width: 1200 });
    expect(() => inspectWebp(valid.subarray(0, valid.length - 1))).toThrow("RIFF byte length");

    const invalidSignature = valid.slice();
    invalidSignature.set(new TextEncoder().encode("NOPE"), 8);
    expect(() => inspectWebp(invalidSignature)).toThrow("WEBP signature");
  });

  it("generates and verifies exactly one image for every documentation route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-og-images-"));
    temporaryDirectories.add(root);
    const contentDirectory = path.join(root, "content");
    const outputDirectory = path.join(root, "public", "og", "docs");
    await mkdir(path.join(contentDirectory, "guide"), { recursive: true });
    await Bun.write(
      path.join(contentDirectory, "index.mdx"),
      '---\ntitle: "Pipr"\ndescription: "Docs index."\n---\n',
    );
    await Bun.write(
      path.join(contentDirectory, "guide", "quickstart.mdx"),
      '---\ntitle: "Quickstart"\ndescription: "Install Pipr."\n---\n',
    );

    const generated = await generateDocsOgImages({ contentDirectory, outputDirectory });

    expect(generated.map((image) => image.route)).toEqual([
      "/og/docs/image.webp",
      "/og/docs/guide/quickstart/image.webp",
    ]);
    await assertDocsOgImages({ contentDirectory, outputDirectory });

    await unlink(path.join(outputDirectory, "guide", "quickstart", "image.webp"));
    await expect(assertDocsOgImages({ contentDirectory, outputDirectory })).rejects.toThrow(
      "missing OG image",
    );
  });

  it("rejects documentation files that map to the same OG route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-og-duplicates-"));
    temporaryDirectories.add(root);
    const contentDirectory = path.join(root, "content");
    const outputDirectory = path.join(root, "output");
    await mkdir(path.join(contentDirectory, "guide"), { recursive: true });
    await Bun.write(
      path.join(contentDirectory, "guide.mdx"),
      '---\ntitle: "Guide"\ndescription: "Guide."\n---\n',
    );
    await Bun.write(
      path.join(contentDirectory, "guide", "index.mdx"),
      '---\ntitle: "Guide index"\ndescription: "Guide index."\n---\n',
    );

    await expect(generateDocsOgImages({ contentDirectory, outputDirectory })).rejects.toThrow(
      "duplicate OG route",
    );
  });
});
