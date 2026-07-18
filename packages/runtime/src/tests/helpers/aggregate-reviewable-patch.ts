import { mkdir } from "node:fs/promises";
import path from "node:path";

export async function writeAggregateReviewablePatchOver16MiB(rootDir: string): Promise<void> {
  const sourceDir = path.join(rootDir, "src");
  await mkdir(sourceDir, { recursive: true });
  const contents = `${Array.from({ length: 96 }, () => "x".repeat(1000)).join("\n")}\n`;
  await Promise.all(
    Array.from({ length: 192 }, (_, index) =>
      Bun.write(path.join(sourceDir, `aggregate-${index}.ts`), contents),
    ),
  );
}
