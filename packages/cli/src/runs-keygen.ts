import { chmod, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateRunBundleIdentity } from "@usepipr/runtime";
import { ensurePrivateParent } from "./runs-identity.js";
import { defaultPiprStateRoot } from "./runs-paths.js";
import type { RunsKeygenOptions } from "./runs-types.js";

export async function runRunsKeygen(
  options: RunsKeygenOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const output = path.resolve(
    context.cwd,
    options.output ??
      path.join(await defaultPiprStateRoot(context.env), "keys", "run-observability.agekey"),
  );
  await ensurePrivateParent(path.dirname(output));
  const key = await generateRunBundleIdentity();
  await writeFile(output, `${key.identity}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(output, 0o600);
  console.log(`Identity: ${output}`);
  console.log(`Recipient: ${key.recipient}`);
}
