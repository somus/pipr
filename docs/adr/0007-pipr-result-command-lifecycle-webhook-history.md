# Pipr Result, command lifecycle, and webhook history

Status: Accepted

Pipr exposes one strict Pipr Result V2 contract from `@usepipr/sdk`. The GitHub Action `result` output, `pipr review --json`, and webhook history all use the same runtime converter and schema validation. V2 replaces V1 without a compatibility serializer. It includes a safe Review Run summary and bounded publication counts, while excluding Diff Manifests, publication plans, trusted-config identity, native comment IDs, credentials, internal markers, and raw errors.

Command execution reuses one Pipr-owned comment keyed to the source command. Pipr writes `accepted` after authorization and input validation, changes it to `running` before task execution, and replaces it with `completed`, the final command response, `failed`, or `superseded`. Operational lifecycle updates may follow head drift so users can see the terminal state. Model-generated responses and review publication still require the live change request head to match the reviewed head.

The trusted webhook runner stores Pipr Result V2 bodies in its existing SQLite delivery database. Results are optional operational history, not a hosted service: individual bodies are capped at 512 KiB, retained bodies are capped at 32 MiB, and delivery rows remain for deduplication when a body is omitted or evicted. `pipr webhook status` reads this local database. Pipr does not add a hosted control plane, dashboard, or administration API.
