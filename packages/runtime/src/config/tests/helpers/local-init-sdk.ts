import path from "node:path";

export function useLocalInitSdk(): void {
  process.env.PIPR_INTERNAL_INIT_SDK_VERSION = `file:${path.resolve(
    import.meta.dirname,
    "../../../../../sdk",
  )}`;
}
