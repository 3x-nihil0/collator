# Sanity setup (Path One)

Everything Collator executes locally works with zero Sanity configuration.
These steps add the two Context endpoints so the agent can also *read* its
sources and dataset. Budget: ~15 minutes of dashboard clicks.

## 1. Create the project (if you don't have one yet)

1. <https://manage.sanity.io> → **New project** → name it `collator`.
2. Dataset: **production** (public is fine for the challenge; the submission
   template wants a public dataset URL).
3. Note the **Project ID** (`abc123xy` style): this is mandatory in your DEV
   submission.

```env
SANITY_PROJECT_ID=abc123xy
SANITY_DATASET=production
```

## 2. Two tokens, two different jobs

| Token | Where | Role | Env var | Used by |
| --- | --- | --- | --- | --- |
| Organization token | Manage → **API → Tokens** (organization level) | **Context Viewer** | `SANITY_ORGANIZATION_TOKEN` | agent's MCP calls |
| Project token | Project → **API → Tokens** | **Editor** | `SANITY_API_TOKEN` | `npm run seed` only |

Keep both server-side. They are deliberately separate: the agent can *read*
Context forever and can never write to your dataset.

## 3. Seed the dataset

```bash
npm run seed              # builds evidence if missing, then writes documents
npm run seed -- --dry-run # inspect the payload without touching the network
```

Creates, with deterministic ids (re-running replaces, never duplicates):

- `testVector` × 12, the duplicate-identity pairs
- `engineProfile`: every engine configuration, with its evidence tier
- `engineRun`: 132 executed probes (engine × vector → outcome)
- `sourceClaim` × 14, sourced claims with URLs and their checked status
- `sourceManifest.priorArt`: the Prior art & credits register

## 4. Create the Knowledge Base

Dashboard → **Context** → **Knowledge base** → new:

1. Give it sources, the seeded dataset, as a **GROQ query source**, not the
   whole dataset. The seed writes **198 documents** but a knowledge base
   indexes at most **150**, and 156 of them are `engineRun` probe rows the KB
   doesn't need. This query leaves them out and returns **42 documents**,
   every type the agent cites:

   ```groq
   *[_type in ["testVector","engineProfile","sourceClaim","sourceManifest"]]
   ```

   Optionally add this repo's README URL as a second source, then let it build.
2. Copy the **`kb…` id** printed above the outline; you'll see the same id in
   `initial_context` later.

The GROQ endpoint in step 5 needs **no** such filter. It queries the full
dataset on demand, `engineRun` rows included.

## 5. Create the two MCP endpoints

Dashboard → **Context** → **MCP endpoints** → new, twice:

| Endpoint | Mode | Sources | Env var |
| --- | --- | --- | --- |
| `collator-kb` | **knowledge_base** | the Knowledge Base from step 4 | `SANITY_MCP_KB_ENDPOINT=collator-kb` |
| `collator-data` | **groq** | dataset | `SANITY_MCP_GROQ_ENDPOINT=collator-data` |

Also copy the **organization id** → `SANITY_MCP_ORG_ID`.

An endpoint URL looks like this (the agent builds it; you don't configure it):

```
POST https://api.sanity.io/v1/context/organizations/$SANITY_MCP_ORG_ID/mcp/$ENDPOINT_NAME
Authorization: Bearer $SANITY_ORGANIZATION_TOKEN
```

Optional: append `?tools=knowledge_base_read` (comma-separated allowlist) to
restrict which tools an endpoint serves.

## 6. Verify before you trust it

```bash
curl -X POST https://api.sanity.io/v1/context/organizations/$SANITY_MCP_ORG_ID/mcp/collator-kb \
  -H "Authorization: Bearer $SANITY_ORGANIZATION_TOKEN" \
  -H "Accept: application/json, text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

- **200 with `result.tools`** → `initial_context` + `knowledge_base_read`.
  The same call against `collator-data` should list `schema_explorer` +
  `groq_query`.
- **401** → token missing or malformed.
- **403 `contextGrantRequired`** → the token is a *project* token, or lacks
  Context Viewer. Recreate it at the **organization** level.
- **Tools list empty** → endpoint mode and sources don't line up (a KB-only
  allowlist on a GROQ endpoint yields nothing).

Then run the agent:

```bash
npm run ask -- "Read the prior-art entry for the Stack Overflow NOCASE advice and say what execution showed"
```

With endpoints configured, the startup log shows no `[context] ... not
configured` warning and the system prompt carries both `initial_context`
outlines.

## 7. Studio (optional but visible to judges)

```bash
SANITY_STUDIO_PROJECT_ID=$SANITY_PROJECT_ID npm run studio
```

Opens the five document types so an editor can inspect claims, runs, and the
prior-art register without touching JSON. `npm run studio:build` produces a
static bundle in `dist/` instead (both read the same `SANITY_STUDIO_*` vars).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `[context] ... unavailable` on startup | endpoint name/org id wrong, or token lacks Context Viewer |
| `initial_context failed` warning | endpoint mode has no sources attached |
| Agent answers but never cites the KB | `SANITY_MCP_KB_ENDPOINT` unset, Context tools are skipped, by design |
| `npm run seed` exits 2 | `SANITY_PROJECT_ID` or `SANITY_API_TOKEN` missing |
