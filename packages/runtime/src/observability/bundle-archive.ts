import { readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "fflate";
import { bundleFilePaths } from "./bundle-files.js";
import { loadValidatedRunBundle } from "./bundle-validation.js";

export async function createRunBundleTarGz(directory: string): Promise<Uint8Array> {
  const bundle = await loadValidatedRunBundle(directory);
  return await createTarGz(directory, bundleFilePaths(bundle.manifest));
}

async function createTarGz(directory: string, relativePaths: string[]): Promise<Uint8Array> {
  const blocks: Uint8Array[] = [];
  for (const relativePath of relativePaths) {
    const contents = await readFile(path.join(directory, relativePath));
    blocks.push(tarHeader(relativePath, contents.byteLength), contents);
    const padding = (512 - (contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(concatenate(blocks), { mtime: 0 });
}

function tarHeader(name: string, size: number): Uint8Array {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Run artifact path is too long for tar: ${name}`);
  }
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
