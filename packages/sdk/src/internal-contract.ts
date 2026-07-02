import type { RuntimePlan } from "./runtime-contract.js";

export const configFactoryBrand = Symbol.for("pipr.config.factory");
export const builtinReadOnlyToolBrand = Symbol.for("pipr.builtin.readOnlyTool");

export type ConfigFactoryValue = {
  readonly kind: "pipr.config-factory";
};

export type InternalPiprConfigFactory = ConfigFactoryValue & {
  readonly [configFactoryBrand]: true;
  build(): RuntimePlan;
};
