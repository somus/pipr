import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { frontmatter } from "fumadocs-core/content/md/frontmatter";
import { type DocsOgImageContent, docsOgImageSize, renderDocsOgImage } from "../src/lib/og-image";

export type DocsOgImage = {
  file: string;
  route: string;
};

type DocsOgDirectories = {
  contentDirectory: string;
  outputDirectory: string;
};

export async function generateDocsOgImages({
  contentDirectory,
  outputDirectory,
}: DocsOgDirectories): Promise<DocsOgImage[]> {
  const images = await expectedDocsOgImages(contentDirectory, outputDirectory);

  for (const image of images) {
    const content = await readDocsOgContent(image.source);
    const response = renderDocsOgImage(content);
    await response.ready;
    const bytes = new Uint8Array(await response.arrayBuffer());
    assertExpectedDimensions(bytes, image.route);
    await mkdir(path.dirname(image.file), { recursive: true });
    await Bun.write(image.file, bytes);
  }

  await assertDocsOgImages({ contentDirectory, outputDirectory });
  return images.map(({ file, route }) => ({ file, route }));
}

export async function assertDocsOgImages({
  contentDirectory,
  outputDirectory,
}: DocsOgDirectories): Promise<void> {
  const expected = await expectedDocsOgImages(contentDirectory, outputDirectory);
  const actualFiles = await globFiles(outputDirectory, "**/image.webp");
  const expectedFiles = new Set(expected.map((image) => image.file));
  const actual = new Set(actualFiles);

  for (const image of expected) {
    if (!actual.has(image.file)) throw new Error(`missing OG image for ${image.route}`);
  }
  for (const file of actual) {
    if (!expectedFiles.has(file)) {
      throw new Error(`unexpected OG image ${path.relative(outputDirectory, file)}`);
    }
  }
  if (actual.size !== expected.length) {
    throw new Error(`expected ${expected.length} unique OG images, found ${actual.size}`);
  }

  for (const image of expected) {
    const bytes = new Uint8Array(await Bun.file(image.file).arrayBuffer());
    assertExpectedDimensions(bytes, image.route);
  }
}

export function inspectWebp(bytes: Uint8Array): { height: number; width: number } {
  if (bytes.length < 20) throw new Error("WebP container is truncated");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertWebpHeader(bytes, view);
  return inspectWebpChunks(bytes, view);
}

function assertWebpHeader(bytes: Uint8Array, view: DataView): void {
  if (ascii(bytes, 0, 4) !== "RIFF") throw new Error("invalid RIFF signature");
  const declaredLength = view.getUint32(4, true) + 8;
  if (declaredLength !== bytes.length) {
    throw new Error(`invalid RIFF byte length: declared ${declaredLength}, found ${bytes.length}`);
  }
  if (ascii(bytes, 8, 12) !== "WEBP") throw new Error("invalid WEBP signature");
}

function inspectWebpChunks(bytes: Uint8Array, view: DataView): { height: number; width: number } {
  let dimensions: { height: number; width: number } | undefined;
  let offset = 12;
  while (offset < bytes.length) {
    const chunk = inspectWebpChunk(bytes, view, offset);
    dimensions = mergeWebpDimensions(
      dimensions,
      readWebpDimensions(chunk.name, bytes, chunk.payloadOffset, chunk.size),
    );
    offset = chunk.end;
  }
  if (!dimensions) throw new Error("WebP image data is undecodable");
  return dimensions;
}

function inspectWebpChunk(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
): { end: number; name: string; payloadOffset: number; size: number } {
  if (offset + 8 > bytes.length) throw new Error("WebP chunk header is truncated");
  const name = ascii(bytes, offset, offset + 4);
  const size = view.getUint32(offset + 4, true);
  const payloadOffset = offset + 8;
  const payloadEnd = payloadOffset + size;
  const end = payloadEnd + (size % 2);
  if (end > bytes.length) throw new Error(`WebP ${name} chunk is truncated`);
  return { end, name, payloadOffset, size };
}

function mergeWebpDimensions(
  current: { height: number; width: number } | undefined,
  next: { height: number; width: number } | undefined,
): { height: number; width: number } | undefined {
  if (current && next) throw new Error("WebP contains duplicate image data");
  return current ?? next;
}

type ExpectedDocsOgImage = DocsOgImage & { source: string };

async function expectedDocsOgImages(
  contentDirectory: string,
  outputDirectory: string,
): Promise<ExpectedDocsOgImage[]> {
  const sourceFiles = await globFiles(contentDirectory, "**/*.mdx");
  const routes = new Map<string, string>();
  const images: ExpectedDocsOgImage[] = [];

  for (const source of sourceFiles) {
    const segments = docsRouteSegments(contentDirectory, source);
    const route = `/og/docs/${[...segments, "image.webp"].join("/")}`;
    const duplicate = routes.get(route);
    if (duplicate) {
      throw new Error(
        `duplicate OG route ${route} from ${path.relative(contentDirectory, duplicate)} and ${path.relative(contentDirectory, source)}`,
      );
    }
    routes.set(route, source);
    images.push({
      file: path.join(outputDirectory, ...segments, "image.webp"),
      route,
      source,
    });
  }

  return images.sort((left, right) => {
    if (left.route === "/og/docs/image.webp") return -1;
    if (right.route === "/og/docs/image.webp") return 1;
    return left.route.localeCompare(right.route);
  });
}

function docsRouteSegments(contentDirectory: string, file: string): string[] {
  const relative = path.relative(contentDirectory, file).split(path.sep).join("/");
  const withoutExtension = relative.replace(/\.mdx$/, "");
  return withoutExtension
    .replace(/(^|\/)index$/, "")
    .split("/")
    .filter(Boolean);
}

async function readDocsOgContent(file: string): Promise<DocsOgImageContent> {
  const parsed = frontmatter(await readFile(file, "utf8"));
  if (!isRecord(parsed.data)) throw new Error(`${file}: frontmatter must be an object`);
  const { title, description } = parsed.data;
  if (typeof title !== "string" || typeof description !== "string") {
    throw new Error(`${file}: frontmatter requires string title and description values`);
  }
  return { description, title };
}

async function globFiles(directory: string, pattern: string): Promise<string[]> {
  const files: string[] = [];
  const glob = new Bun.Glob(pattern);
  for await (const relative of glob.scan({ cwd: directory, onlyFiles: true })) {
    files.push(path.join(directory, relative));
  }
  return files.sort();
}

function assertExpectedDimensions(bytes: Uint8Array, route: string): void {
  const dimensions = inspectWebp(bytes);
  if (dimensions.width !== docsOgImageSize.width || dimensions.height !== docsOgImageSize.height) {
    throw new Error(
      `${route}: expected ${docsOgImageSize.width}x${docsOgImageSize.height}, found ${dimensions.width}x${dimensions.height}`,
    );
  }
}

function readWebpDimensions(
  name: string,
  bytes: Uint8Array,
  offset: number,
  size: number,
): { height: number; width: number } | undefined {
  if (name === "VP8X") return readVp8xDimensions(bytes, offset, size);
  if (name === "VP8L") return readVp8lDimensions(bytes, offset, size);
  if (name === "VP8 ") return readVp8Dimensions(bytes, offset, size);
  return undefined;
}

function readVp8xDimensions(
  bytes: Uint8Array,
  offset: number,
  size: number,
): { height: number; width: number } {
  if (size < 10) throw new Error("WebP VP8X chunk is undecodable");
  return {
    width: 1 + uint24(bytes, offset + 4),
    height: 1 + uint24(bytes, offset + 7),
  };
}

function readVp8lDimensions(
  bytes: Uint8Array,
  offset: number,
  size: number,
): { height: number; width: number } {
  if (size < 5) throw new Error("WebP VP8L chunk is undecodable");
  if (bytes[offset] !== 0x2f) throw new Error("WebP VP8L chunk is undecodable");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bits = view.getUint32(offset + 1, true);
  return {
    width: (bits & 0x3fff) + 1,
    height: ((bits >>> 14) & 0x3fff) + 1,
  };
}

function readVp8Dimensions(
  bytes: Uint8Array,
  offset: number,
  size: number,
): { height: number; width: number } {
  if (size < 10) throw new Error("WebP VP8 chunk is undecodable");
  if (!hasVp8FrameSignature(bytes, offset)) throw new Error("WebP VP8 chunk is undecodable");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    width: view.getUint16(offset + 6, true) & 0x3fff,
    height: view.getUint16(offset + 8, true) & 0x3fff,
  };
}

function hasVp8FrameSignature(bytes: Uint8Array, offset: number): boolean {
  return bytes[offset + 3] === 0x9d && bytes[offset + 4] === 0x01 && bytes[offset + 5] === 0x2a;
}

function uint24(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
