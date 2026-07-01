export type OfficialInitRecipeFile = {
  relativePath: string;
  contents: string;
};

export type OfficialInitRecipeWorkflowEnvSecret = {
  env: string;
  secret: string;
};

export type OfficialInitRecipe = {
  id: string;
  title: string;
  description: string;
  sourceTools: readonly string[];
  configTs: string;
  files?: readonly OfficialInitRecipeFile[];
  workflowEnvSecrets?: readonly OfficialInitRecipeWorkflowEnvSecret[];
  docsDetailsMdx?: string;
};
