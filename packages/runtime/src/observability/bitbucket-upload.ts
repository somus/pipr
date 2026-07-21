import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "fflate";
import { z } from "zod";
import { loadValidatedRunBundle } from "./archive.js";
import { resolveBitbucketCollectionPageUrl } from "./bitbucket-url.js";
import { bundleFilePaths } from "./bundle-files.js";

type UploadFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const downloadsPageSchema = z.object({
  values: z.array(
    z.object({
      name: z.string(),
      created_on: z.string().optional(),
    }),
  ),
  next: z.string().url().optional(),
});

export async function uploadBitbucketRunBundle(options: {
  directory: string;
  repository?: string;
  changeNumber?: number;
  executionId: string;
  email?: string;
  token?: string;
  readEmail?: string;
  readToken?: string;
  retentionDays?: number;
  now?: Date;
  fetch?: UploadFetch;
}): Promise<{ status: "available" | "failed"; error?: string; warning?: string }> {
  const target = validateUploadOptions(options);
  if (!target.valid) return await failUpload(options.directory, target.error);

  const request = options.fetch ?? fetch;
  const writeHeaders = basicAuthorization(target.email, target.token);
  const readHeaders =
    options.readEmail && options.readToken
      ? basicAuthorization(options.readEmail, options.readToken)
      : writeHeaders;
  const baseUrl = `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(target.workspace)}/${encodeURIComponent(target.repository)}/downloads`;
  try {
    const warning = await cleanupExpiredDownloads(options, request, baseUrl, {
      readHeaders,
      writeHeaders,
    });
    await updateExternalUploadState(options.directory, "available");
    await uploadBundle(
      { ...options, changeNumber: target.changeNumber },
      request,
      baseUrl,
      writeHeaders,
    );
    return warning ? { status: "available", warning } : { status: "available" };
  } catch (error) {
    return await failUpload(
      options.directory,
      error instanceof Error ? error.message : "Bitbucket artifact upload failed",
    );
  }
}

function validateUploadOptions(options: {
  email?: string;
  token?: string;
  changeNumber?: number;
  repository?: string;
}):
  | {
      valid: true;
      email: string;
      token: string;
      changeNumber: number;
      workspace: string;
      repository: string;
    }
  | { valid: false; error: string } {
  if (!options.email || !options.token) {
    return { valid: false, error: "Bitbucket artifact upload credentials are not configured" };
  }
  if (!options.changeNumber) {
    return { valid: false, error: "Bitbucket artifact upload requires a PR number" };
  }
  const match = /^([^/]+)\/([^/]+)$/.exec(options.repository ?? "");
  if (!match) {
    return { valid: false, error: "Bitbucket repository must be workspace/repository" };
  }
  return {
    valid: true,
    email: options.email,
    token: options.token,
    changeNumber: options.changeNumber,
    workspace: match[1],
    repository: match[2],
  };
}

function basicAuthorization(email: string, token: string): Record<string, string> {
  return {
    Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  };
}

async function cleanupExpiredDownloads(
  options: { now?: Date; retentionDays?: number },
  request: UploadFetch,
  url: string,
  headers: { readHeaders: Record<string, string>; writeHeaders: Record<string, string> },
): Promise<string | undefined> {
  try {
    await deleteExpiredReservedDownloads({
      request,
      url,
      ...headers,
      cutoff:
        (options.now ?? new Date()).getTime() - (options.retentionDays ?? 14) * 24 * 60 * 60 * 1000,
    });
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "Bitbucket expired artifact cleanup failed";
  }
}

async function uploadBundle(
  options: { directory: string; changeNumber: number; executionId: string },
  request: UploadFetch,
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  const archive = await createBundleTarGz(options.directory);
  const filename = `pipr-run-v1-pr-${options.changeNumber}-${options.executionId}.tar.gz`;
  const body = new FormData();
  body.append("files", new Blob([archive], { type: "application/gzip" }), filename);
  const response = await request(url, { method: "POST", headers, body });
  if (response.status !== 201) {
    await throwHttpError(response, "Bitbucket artifact upload failed");
  }
}

async function deleteExpiredReservedDownloads(options: {
  request: UploadFetch;
  url: string;
  readHeaders: Record<string, string>;
  writeHeaders: Record<string, string>;
  cutoff: number;
}): Promise<void> {
  let next: string | undefined = options.url;
  while (next) {
    const pageUrl = bitbucketDownloadsPageUrl(next, options.url);
    const response = await options.request(pageUrl, { headers: options.readHeaders });
    if (!response.ok) await throwHttpError(response, "Bitbucket Downloads lookup failed");
    const page = downloadsPageSchema.parse(await response.json());
    for (const download of page.values) {
      if (!download.name.startsWith("pipr-run-v1-") || !download.created_on) continue;
      if (Date.parse(download.created_on) >= options.cutoff) continue;
      const deletion = await options.request(
        `${options.url}/${encodeURIComponent(download.name)}`,
        {
          method: "DELETE",
          headers: options.writeHeaders,
        },
      );
      if (!deletion.ok) {
        await throwHttpError(deletion, "Bitbucket expired artifact cleanup failed");
      }
    }
    next = page.next;
  }
}

function bitbucketDownloadsPageUrl(value: string, collectionUrl: string): string {
  return resolveBitbucketCollectionPageUrl(value, collectionUrl);
}

async function throwHttpError(response: Response, message: string): Promise<never> {
  const status = response.status;
  await response.body?.cancel().catch(() => undefined);
  throw new Error(`${message} with HTTP ${status}`);
}

async function failUpload(
  directory: string,
  error: string,
): Promise<{ status: "failed"; error: string }> {
  try {
    await updateExternalUploadState(directory, "failed");
  } catch {
    // The review is already complete; an unavailable local manifest must not mask that result.
  }
  return { status: "failed", error };
}

async function updateExternalUploadState(
  directory: string,
  state: "available" | "failed",
): Promise<void> {
  const manifestPath = path.join(directory, "run.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.export.externalUpload = state;
  const temporary = path.join(directory, "run.json.upload.tmp");
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, manifestPath);
}

async function createBundleTarGz(directory: string): Promise<Uint8Array> {
  const bundle = await loadValidatedRunBundle(directory);
  const blocks: Uint8Array[] = [];
  for (const relativePath of bundleFilePaths(bundle.manifest)) {
    const contents = await readFile(path.join(directory, relativePath));
    blocks.push(tarHeader(relativePath, contents.byteLength), contents);
    const padding = (512 - (contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(concatenate(blocks), { mtime: 0 });
}

function tarHeader(name: string, size: number): Uint8Array {
  if (Buffer.byteLength(name) > 100)
    throw new Error(`Run artifact path is too long for tar: ${name}`);
  const header = new Uint8Array(512);
  writeAscii(header, 0, 100, name);
  writeAscii(header, 100, 8, "0000600\0");
  writeAscii(header, 108, 8, "0000000\0");
  writeAscii(header, 116, 8, "0000000\0");
  writeAscii(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeAscii(header, 136, 12, "00000000000\0");
  writeAscii(header, 148, 8, "        ");
  header[156] = "0".charCodeAt(0);
  writeAscii(header, 257, 8, "ustar\x000");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}

function concatenate(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
