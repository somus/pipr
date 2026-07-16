import { Buffer } from "node:buffer";

const htmlMetadataPattern = /^<!--\s*(pipr:[^>\r\n]+?)\s*-->$/gm;
const markdownMetadataPattern = /^\[pipr-metadata-[A-Za-z0-9_-]+-\d+\]: # "([A-Za-z0-9_-]+)"$/gm;

export function renderBitbucketMarkdown(body: string): string {
  let metadataIndex = 0;
  return body
    .replace(htmlMetadataPattern, (_line, metadata: string) => {
      const encoded = Buffer.from(metadata).toString("base64url");
      metadataIndex += 1;
      return `[pipr-metadata-${encoded.slice(0, 12)}-${metadataIndex}]: # "${encoded}"`;
    })
    .replace(/^# <img [^>]+> Pipr Review$/m, "# Pipr Review")
    .replace(/<details>\s*<summary>([^<]+)<\/summary>\s*/g, "### $1\n\n")
    .replace(/\s*<\/details>/g, "")
    .replace(/<sub>([^<]*)<\/sub>/g, "$1")
    .replace(/<br\s*\/?>/gi, ", ")
    .replace(/<code>([^<]*)<\/code>/g, "`$1`");
}

export function normalizeBitbucketMarkdown(body: string): string {
  return body.replace(markdownMetadataPattern, (line, encoded: string) => {
    try {
      const metadata = Buffer.from(encoded, "base64url").toString();
      return metadata.startsWith("pipr:") ? `<!-- ${metadata} -->` : line;
    } catch {
      return line;
    }
  });
}
