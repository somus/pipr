declare const PIPR_EMBEDDED_SDK_MODULE: string | undefined;
declare const PIPR_EMBEDDED_SDK_DECLARATION: string | undefined;

export type EmbeddedSdkAssets = {
  module?: string;
  declaration?: string;
};

export function embeddedSdkAssets(): EmbeddedSdkAssets {
  return {
    module:
      typeof PIPR_EMBEDDED_SDK_MODULE === "string" && PIPR_EMBEDDED_SDK_MODULE.length > 0
        ? PIPR_EMBEDDED_SDK_MODULE
        : undefined,
    declaration:
      typeof PIPR_EMBEDDED_SDK_DECLARATION === "string" && PIPR_EMBEDDED_SDK_DECLARATION.length > 0
        ? PIPR_EMBEDDED_SDK_DECLARATION
        : undefined,
  };
}
