import path from "node:path";
import {
  embeddedSdkDeclaration,
  readSdkDeclarationSourceWithChunk,
  type SdkDeclarationModule,
} from "@usepipr/sdk/internal";

export type { SdkDeclarationModule };
export { embeddedSdkDeclaration };

export async function readSdkDeclarationModules(
  sourceRoot: string,
): Promise<SdkDeclarationModule[]> {
  const modules = [
    { moduleName: "@usepipr/sdk", fileName: "index.d.mts" },
    { moduleName: "@usepipr/sdk/review", fileName: "review.d.mts" },
    { moduleName: "@usepipr/sdk/tools", fileName: "tools.d.mts" },
  ];
  return await Promise.all(
    modules.map(async (module) => {
      const declarationPath = path.join(sourceRoot, "packages", "sdk", "dist", module.fileName);
      return {
        moduleName: module.moduleName,
        source: await readSdkDeclarationSourceWithChunk(module, declarationPath),
      };
    }),
  );
}
