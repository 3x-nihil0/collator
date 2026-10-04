# Collator

**Would a `UNIQUE` constraint treat these two strings as the same value?**

Not "what does the documentation say" but **what happens when you insert them.**
Collator answers by executing the constraint: it creates the table, declares the
unique index with that collation, inserts value A, then tries to insert value B.
If the second insert is rejected, the engine considers them one row.

Every claim Collator publishes carries an evidence tier:

| Tier | Meaning |
| --- | --- |
| `EXECUTED` | A probe ran on this machine. This is the raw outcome. |
| `DOCUMENTED` | A source says so; we could not run it here. Attribution only, never a verdict. |
| `UNAVAILABLE` | No admissible evidence. Collator **refuses**, names what could not run, and says why. It never guesses. |

The refusal is a feature. Most "AI answers your schema questions" tools hedge;
Collator's whole architecture exists so that hedging is impossible: the model
can only repeat what a tool executed, and the tool stamps every row with its tier.

## Quick start

```bash
npm install
npm run evidence     # run the oracle, write evidence/report.json
npm run serve        # open http://127.0.0.1:4173
```

The web page needs no API key: paste two values, press **Execute**, and read the
verdict. Any pair is also a shareable URL: `http://127.0.0.1:4173/?a=...&b=...`
executes on load. The narrative agent (`npm run ask -- "your question"`) needs any
OpenAI-compatible model: set `LLM_BASE_URL` / `LLM_MODEL` in `.env`
(see [.env.example](.env.example); OpenAI, OpenRouter, Groq, DeepSeek, Gemini,
Ollama all work). Sanity Context tools attach when `SANITY_MCP_*` is set
([docs/SANITY_SETUP.md](docs/SANITY_SETUP.md)).

```bash
npm run ask -- --pair "Straße" "strasse"
npm test             # vitest: verdicts, divergences, harness, API
npm run typecheck
npm run baseline     # keyword search vs structured choice: 1/5 vs 5/5
```

## What actually runs here

| Engine / policy | Version | How |
| --- | --- | --- |
| SQLite `BINARY`, `NOCASE`, `RTRIM`, custom `NFC_FOLD`, `NFKC_FOLD` | 3.50.4 | Python stdlib `sqlite3` + `create_collation` |
| DuckDB default + `NOCASE` | 1.5.6 | Python driver (when the host lets the native library load) |
| PostgreSQL `default`, `C`, `ucs_basic`, `unicode` (ICU) | 18.3 | **PGlite**: real Postgres compiled to WebAssembly, no server, no credentials |
| Python policies `lower` / `casefold` / `NFC` / `NFKC` / canonical | 3.14.7 | executed in-process |
| JavaScript policies `toLowerCase` / `normalize` / canonical | Node 26 | executed in-process. JavaScript has no `casefold()`, and that gap is the point |

**Calibration before publication.** A WASM build can accept a collation and then
quietly not apply it. Every PostgreSQL configuration is probed first
(`'a' = 'A'`? does `'a'` sort before `'B'`?) and **rejected with a reason** if the
behaviour does not match what the collation claims. On this host that rejected
`en_US.utf8` (locale not functional) and `primary-nondet` (ICU primary strength
not applied), and both show up in the report as calibration failures rather than as
confident wrong answers.

## Latest evidence run (this machine)

```
runtime      : python 3.14.7, sqlite 3.50.4, PostgreSQL 18.3 (PGlite 0.5.8)
engines      : 11 executed, 4 named but not executable here
checks       : 132 executed          (12 test vectors × engine configurations)
claims       : 14 checked, 3 DISAGREE, 4 UNVERIFIED
conflicts    : 1 source-vs-source, resolved by execution
```

### The divergences that justify the project

- **Stack Overflow folklore** ("just add `COLLATE NOCASE`", answer score 300+)
  predicts `COLLIDES` for `JOSÉ@EXAMPLE.COM` vs `josé@example.com`.
  **Execution: `DISTINCT`.** NOCASE folds ASCII letters only, two accounts for
  one identity. The sqlite.org documentation agrees with execution; the thread
  does not.
- **"Just lowercase the email"** (two variants, Python and JavaScript) predicts
  `COLLIDES` for `strasse@x.com` vs `straße@x.com`.
  **Execution: `DISTINCT` for `lower()`/`toLowerCase()`.** Sharp s casefolds to
  `ss`, lowercase does not: `casefold()` collides, and Collator shows both.
- **Source-vs-source**: sqlite.org says `NOCASE` is ASCII-only; the folklore
  says it makes columns unique. Both target `sqlite/nocase` on the same vector.
  Execution resolves it: `DISTINCT`.
- **MySQL claims stay `UNVERIFIED`**: a server listens on `:3306` but no
  credentials exist here, so Collator keeps them at `DOCUMENTED` and refuses to
  promote them. Same for SQL Server. That discipline is why the 3 DISAGREEs
  mean something.

### Why keyword search can't answer this

`npm run baseline` scores a TF-IDF keyword search over the same sources
(`"case insensitive unique column sqlite email`) against the 12 vectors:
**top hit is the Stack Overflow `COLLATE NOCASE` answer → 1/5 (20%) correct.**
Collator's structured engine choice (`sqlite/nfkc_fold`) scores **5/5**.
The gap is exactly the folklore-vs-execution gap above: the documents are
rankable, the *behaviour* is only knowable by running it.

## Sanity Context (Path One)

Collator connects to two hosted Context MCP endpoints and exposes their tools
to the agent loop alongside the oracle:

- **Knowledge Base mode** (endpoint `collator-kb`; search and read tools):
  serves a Knowledge Base built from 42 of the 198 seeded documents (the four
  types the agent cites). The Knowledge Base holds at most 150 documents, and
  156 of the 198 are raw `engineRun` probe rows, so a GROQ filter leaves them
  out. Its search is an exact keyword search: short keywords match, long
  phrases may not.
- **GROQ mode** (endpoint `collator-data`; `initial_context`, `schema_explorer`,
  `groq_query`): serves the full dataset: engine profiles, executed runs,
  sourced claims with URLs. The two endpoints stay separate, because an
  endpoint that mixes a dataset with a Knowledge Base ignores the Knowledge
  Base.

Real agent runs are saved in [docs/live tests](docs/live%20tests).

The dataset schema lives in [studio/schemas](studio/schemas): `engineProfile`,
`testVector`, `sourceClaim`, `engineRun`, `sourceManifest`. Seed it with
`npm run seed` (idempotent: deterministic `_id`s, one HTTP mutate call, no SDK).
Endpoints degrade gracefully: no env vars, no Context tools, warning instead of
crash. The oracle works without Sanity; Sanity makes the answer *sourced*.

## Prior art & credits

Collator stands on these; the "novelty" is only in wiring them together as one
executable answer. Full register: [src/oracle/priorArt.ts](src/oracle/priorArt.ts)
(seeded into Sanity as `sourceManifest`).

- **db-fiddle.com** / **sqlfiddle.com**: run SQL against real engines in the
  browser. You must already know the query; no tiers, no fixed vectors, no claim
  checking.
- **DbSchema**: multi-engine schema editor; never answers "would these two
  concrete strings collide".
- **sqlite.org datatypes §3.1 (collation)**: authoritative `NOCASE` semantics;
  Collator executes them instead of quoting them.
- **MySQL Unicode collations**: the `ai_ci` / `as_cs` / PAD SPACE matrix
  (DOCUMENTED tier here; no credentials on this host).
- **PostgreSQL `CREATE COLLATION`**: deterministic vs nondeterministic, ICU
  providers; Collator runs them through PGlite and calibrates each one.
- **Stack Overflow "case-insensitive unique column in SQLite"** and the
  **ShallowDepth 5-ways SQLite post**: the folklore this project checks.
- **Unicode UAX #15** (normalization), **UTS #39** (confusables),
  **ICU collation**: the standards that define the folds; no database ships
  confusable folding, which Collator proves by execution.

## Layout

```
oracle/run.py            execution oracle (stdlib-only): SQLite + Unicode policies + engine probes
src/oracle/              evidence model: engines, claims, divergence detection, baseline, pair checks
src/agent/               provider-agnostic chat client, Sanity Context MCP wiring, harness loop
src/server/              four-route HTTP API + verdict derivation
web/index.html           the page: verdict banner, engine×collation matrix, citations, refusals
studio/                  Sanity Studio: the five document types behind Context
scripts/seed.ts          idempotent dataset seeding (raw mutations API, no SDK)
tests/                   vitest: verdicts, known divergences, harness (scripted LLM), API
evidence/report.json     generated evidence, regenerate with `npm run evidence`
```

## Honest limitations

- MySQL / PostgreSQL *servers* on this host have no credentials: those claims
  stay `DOCUMENTED`/`UNVERIFIED` forever until someone sets `MYSQL_*`/`PG*`.
- A host Application Control policy can block DuckDB's native library; the
  oracle reports `UNAVAILABLE` with remediation in that case (this machine
  currently loads it, and the tests accept either state honestly).
- Collator answers for **named configurations**, never "databases in general".
