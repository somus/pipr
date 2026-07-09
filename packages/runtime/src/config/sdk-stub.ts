import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
  type SdkDeclarationModule,
} from "@usepipr/sdk/internal";
import { embeddedSdkAssets } from "./sdk-assets.js";
import {
  resolvedSdkModulePath,
  resolvedSdkPackageRoot,
  sdkModuleStubSource,
} from "./sdk-module.js";

const sdkDeclarationModules = [{ moduleName: "@usepipr/sdk", fileName: "index.d.mts" }] as const;

export async function installTypedSdkStub(configDir: string): Promise<void> {
  const sdkRoot = path.join(configDir, "node_modules", "@usepipr", "sdk");
  await rm(sdkRoot, { recursive: true, force: true });
  await mkdir(sdkRoot, { recursive: true });
  await Bun.write(
    path.join(sdkRoot, "package.json"),
    JSON.stringify({
      name: "@usepipr/sdk",
      version: "0.0.0-pipr-runtime",
      type: "module",
      types: "./index.d.ts",
      exports: {
        ".": {
          types: "./index.d.ts",
          default: "./index.mjs",
        },
      },
    }),
  );
  await Bun.write(
    path.join(sdkRoot, "index.mjs"),
    sdkModuleStubSource(resolvedSdkModulePath(), embeddedSdkAssets().module),
  );
  await Bun.write(path.join(sdkRoot, "index.d.ts"), await sdkStubDeclaration());
}

async function sdkStubDeclaration(): Promise<string> {
  const embedded = embeddedSdkAssets().declaration;
  if (embedded?.includes('declare module "@usepipr/sdk"')) {
    assertStandaloneSdkDeclaration(embedded);
    return embedded.endsWith("\n") ? embedded : `${embedded}\n`;
  }
  const declaration = embeddedSdkDeclaration(await rawSdkDeclarations());
  assertStandaloneSdkDeclaration(declaration);
  return declaration.endsWith("\n") ? declaration : `${declaration}\n`;
}

function assertStandaloneSdkDeclaration(declaration: string): void {
  if (declaration.includes('from "zod"') || declaration.includes("z.ZodType")) {
    throw new Error("generated SDK declaration must be standalone and must not import zod");
  }
}

async function rawSdkDeclarations(): Promise<SdkDeclarationModule[]> {
  const declarations = await Promise.all(
    sdkDeclarationModules.map(async (module) => {
      const declarationPath = await sdkDeclarationPath(module.fileName);
      return declarationPath
        ? { ...module, source: await readSdkDeclarationSourceWithChunk(module, declarationPath) }
        : undefined;
    }),
  );
  if (declarations.every((declaration) => declaration !== undefined)) {
    return declarations;
  }
  const embedded = embeddedSdkAssets().declaration;
  if (embedded) {
    return [{ moduleName: sdkDeclarationModules[0].moduleName, source: embedded }];
  }
  throw new Error(
    "Unable to locate @usepipr/sdk declaration file. Build @usepipr/sdk before loading config.",
  );
}

async function sdkDeclarationPath(fileName: string): Promise<string | undefined> {
  const sdkRoot = resolvedSdkPackageRoot();
  if (!sdkRoot) {
    return undefined;
  }
  const candidate = path.join(sdkRoot, "dist", fileName);
  return (await Bun.file(candidate).exists()) ? candidate : undefined;
}
