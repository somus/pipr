import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
  type SdkDeclarationModule,
} from "@usepipr/sdk/internal";
import { embeddedSdkAssets } from "./sdk-assets.js";

export type ConfigTypeSupportFile = {
  relativePath: string;
  contents: string;
};

const starterTsconfig = `{
  "compilerOptions": {
    "strict": true,
    "noEmit": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler"
  },
  "include": ["./**/*.ts"]
}
`;

export async function generatedTypeSupportFiles(
  relativeConfigDir: string,
  options: { tsconfig?: boolean } = {},
): Promise<ConfigTypeSupportFile[]> {
  const files: ConfigTypeSupportFile[] = [];
  if (options.tsconfig !== false) {
    files.push({
      relativePath: path.join(relativeConfigDir, "tsconfig.json"),
      contents: starterTsconfig,
    });
  }
  files.push({
    relativePath: path.join(relativeConfigDir, "types", "pipr-sdk.d.ts"),
    contents: await sdkDeclaration(),
  });
  return files;
}

export async function writeGeneratedTypeSupport(
  configDir: string,
  options: { tsconfig?: boolean } = {},
): Promise<void> {
  for (const file of await generatedTypeSupportFiles("", options)) {
    const target = path.join(configDir, file.relativePath);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, file.contents);
  }
}

async function sdkDeclaration(): Promise<string> {
  const embedded = embeddedSdkAssets().declaration;
  if (embedded?.includes('declare module "@usepipr/sdk"')) {
    assertStandaloneSdkDeclaration(embedded);
    return embedded;
  }
  const declaration = embeddedSdkDeclaration(await rawSdkDeclarations());
  assertStandaloneSdkDeclaration(declaration);
  return declaration;
}

function assertStandaloneSdkDeclaration(declaration: string): void {
  if (declaration.includes('from "zod"') || declaration.includes("z.ZodType")) {
    throw new Error("generated SDK declaration must be standalone and must not import zod");
  }
}

type SdkDeclarationAsset = {
  moduleName: string;
  fileName: string;
};

const sdkDeclarationModules: SdkDeclarationAsset[] = [
  { moduleName: "@usepipr/sdk", fileName: "index.d.mts" },
];

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
    "Unable to locate @usepipr/sdk declaration file. Build @usepipr/sdk before pipr init.",
  );
}

async function sdkDeclarationPath(fileName: string): Promise<string | undefined> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, "../../sdk/dist", fileName),
    path.resolve(moduleDir, "../../../sdk/dist", fileName),
  ];
  for (const candidate of candidates) {
    const stats = await Bun.file(candidate).exists();
    if (stats) {
      return candidate;
    }
  }
  return undefined;
}
