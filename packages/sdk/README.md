# @usepipr/sdk

`@usepipr/sdk` is the public TypeScript API for `.pipr/config.ts`. Use it to configure models, reviewers, tasks, commands, tools, schemas, and comment publication.

## Quick start

Initialize a repository to install the SDK and create a starter config:

```bash
pipr init
```

Define review behavior from the package root:

```ts
import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });

  pipr.review({
    id: "review",
    model,
    instructions: {
      findings: "Report actionable correctness, security, and testing issues.",
      summary: "Summarize the change and its main risks.",
    },
  });
});
```

Run `pipr check` after editing the config.

See [Configuration](https://pipr.run/docs/guide/configuration) for common options and the [SDK reference](https://pipr.run/docs/reference/sdk-reference) for the complete API.
