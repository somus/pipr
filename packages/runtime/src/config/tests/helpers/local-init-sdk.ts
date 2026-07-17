import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type SharedInitDependencies = {
  dependencyRoot: string;
  users: number;
  previousEnvironment: {
    sdk: string | undefined;
    typesBun: string | undefined;
    typescript: string | undefined;
    offline: string | undefined;
  };
};

let sharedInitDependencies: Promise<SharedInitDependencies> | undefined;

export async function useLocalInitSdk(): Promise<() => Promise<void>> {
  if (!sharedInitDependencies) {
    sharedInitDependencies = createSharedInitDependencies();
  }
  const shared = await sharedInitDependencies;
  shared.users += 1;
  let cleaned = false;
  return async () => {
    if (cleaned) return;
    cleaned = true;
    shared.users -= 1;
    if (shared.users > 0) return;
    restoreEnvironment("PIPR_INTERNAL_INIT_SDK_VERSION", shared.previousEnvironment.sdk);
    restoreEnvironment("PIPR_INTERNAL_INIT_TYPES_BUN_VERSION", shared.previousEnvironment.typesBun);
    restoreEnvironment(
      "PIPR_INTERNAL_INIT_TYPESCRIPT_VERSION",
      shared.previousEnvironment.typescript,
    );
    restoreEnvironment("PIPR_INTERNAL_INIT_OFFLINE", shared.previousEnvironment.offline);
    await rm(shared.dependencyRoot, { recursive: true, force: true });
    sharedInitDependencies = undefined;
  };
}

async function createSharedInitDependencies(): Promise<SharedInitDependencies> {
  const previousEnvironment = {
    sdk: process.env.PIPR_INTERNAL_INIT_SDK_VERSION,
    typesBun: process.env.PIPR_INTERNAL_INIT_TYPES_BUN_VERSION,
    typescript: process.env.PIPR_INTERNAL_INIT_TYPESCRIPT_VERSION,
    offline: process.env.PIPR_INTERNAL_INIT_OFFLINE,
  };
  const fixtureRoot = path.resolve(import.meta.dirname, "../fixtures/init-dependencies");
  const dependencyRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-init-dependencies-"));
  const typescriptSource = await realpath(
    path.resolve(import.meta.dirname, "../../../../../../node_modules/typescript"),
  );
  const typescriptFixture = path.join(dependencyRoot, "typescript");
  await cp(typescriptSource, typescriptFixture, { recursive: true });
  const typescriptPackageJsonPath = path.join(typescriptFixture, "package.json");
  const typescriptPackageJson = JSON.parse(await Bun.file(typescriptPackageJsonPath).text());
  delete typescriptPackageJson.devDependencies;
  await Bun.write(typescriptPackageJsonPath, `${JSON.stringify(typescriptPackageJson, null, 2)}\n`);
  process.env.PIPR_INTERNAL_INIT_SDK_VERSION = `file:${path.join(fixtureRoot, "sdk")}`;
  process.env.PIPR_INTERNAL_INIT_TYPES_BUN_VERSION = `file:${path.join(fixtureRoot, "types-bun")}`;
  process.env.PIPR_INTERNAL_INIT_TYPESCRIPT_VERSION = `file:${typescriptFixture}`;
  process.env.PIPR_INTERNAL_INIT_OFFLINE = "1";
  return { dependencyRoot, users: 0, previousEnvironment };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
