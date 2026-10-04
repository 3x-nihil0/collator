# Collator: it executes your UNIQUE constraint instead of quoting the docs

**Sanity Challenge, Path One** · tag: `#sanitychallenge`
**Sanity project ID:** `ak4t3xv2` (dataset: `production`)
**Public dataset URL:** <https://ak4t3xv2.api.sanity.io/v2025-02-19/data/query/production?query=*%5B_type%3D%3D%22sourceClaim%22%5D>
**Live demo:** {{LIVE_URL}}
**Repo:** {{REPO_URL}}

---

## The question nobody can answer from prose

You ship a `UNIQUE` constraint on an email column. A user registers
`JOSÉ@EXAMPLE.COM`. Then `josé@example.com`. **Same account, or two?**

Ask the documentation and you get sentences. Ask Stack Overflow and you get a
300-score answer saying *"just add `COLLATE NOCASE` and your uniqueness problem
is solved."* Ask **Collator** and it creates the table, declares the index with
that collation, inserts the first row, tries the second, and shows you which
one happened, plus the tier of evidence behind it.

`NOCASE` folds ASCII letters only. The insert **succeeds**. The folklore is
wrong for exactly the case everyone worries about.

## Why it matters

This bug class is invisible until it's expensive:

- **Accounts split.** Two rows, one human. Password resets, duplicates, GDPR
  "delete my account" that only deletes half of you.
- **Migrations lie.** SQLite → Postgres, or `utf8mb4_general_ci` →
  `utf8mb4_0900_ai_ci`, silently changes which strings collide. The constraint
  syntax never changes; the *semantics* do.
- **Application and database disagree.** Your Node code does
  `toLowerCase()`, the column does `NOCASE`, the ICU collation does full
  casefolding. Three different definitions of "same email", one write path.

Collator answers the question for **the pair you actually have**, on **the
engine you actually run**, and refuses to answer when it can't run it.

## How it works

**1. An execution oracle, not a retrieval pipeline.**
`oracle/run.py` (stdlib only) and a PGlite instance (real PostgreSQL 18 in
WebAssembly, no server, no credentials) run the same experiment for every
engine × collation × test vector: insert A, try insert B, record
`COLLIDES`/`DISTINCT`. 11 engine configurations, 12 Unicode trap vectors,
**132 executed checks** on this machine.

**2. Evidence tiers, enforced in code.**

| Tier | Meaning |
| --- | --- |
| `EXECUTED` | ran here; the only thing that may be stated as fact |
| `DOCUMENTED` | a source says so; attribution only, never a verdict |
| `UNAVAILABLE` | refused, with the reason and remediation |

The system prompt makes `UNAVAILABLE` a refusal; the tools stamp every row
with its tier; the verdict the UI shows is computed from executed rows
(`src/server/verdict.ts`), never from model prose. Four states exist:
`COLLIDES`, `DISTINCT`, `SPLIT` (engines disagree), and `REFUSED`.

**3. Calibration before publication.** A WASM Postgres can *accept* a collation
and not apply it. Every collation is probed first (`'a' = 'A'`? does `'a'`
sort before `'B'`?) and rejected with a reason if it lies. This host rejected
`en_US.utf8` and ICU primary-strength for exactly that reason. You'll find
them in the report as calibration failures, not as confident wrong answers.

**4. Claims checked against execution.** 14 sourced claims are run against the
results: **3 DISAGREE, 4 UNVERIFIED, 1 source-vs-source conflict resolved by
execution** (Stack Overflow folklore vs sqlite.org on `NOCASE`).

And because someone will ask: a TF-IDF keyword search over the same sources
scores **1/5** on the case-class vectors; its top hit is the `COLLATE NOCASE
answer. The structured engine choice scores **5/5**. The documents are
rankable; the behaviour is only knowable by running it.

## Demo

1. `npm install && npm run evidence && npm run serve` →
   <http://127.0.0.1:4173>: no API key needed for the checker.
2. Click the **sharp s** chip (`strasse@x.com` vs `straße@x.com`):

   ```
   SPLIT: 5 configuration(s) collide, 10 stay distinct — the answer depends
   on which engine and collation you actually run
   ```

   The matrix shows `python.lower: different` next to `python.casefold:
   equal`: the two functions most "just lowercase it" codebases use are not
   the same function.

3. Paste anything: homoglyphs (`admin@x.com` vs `admаin@x.com`), NFC/NFD
   macOS-vs-Windows pairs, trailing spaces. Every configuration is shown with
   its raw error detail, e.g. `IntegrityError: UNIQUE constraint failed`.

   Any pair is shareable as a URL: `/?a=...&b=...` executes on load. That is
   also how these were captured (headless Chrome, no manual clicking):

![Verdict on JOSÉ@EXAMPLE.COM vs josé@example.com: SPLIT - 2 configurations collide, 9 stay distinct of 11 executed, with the engine matrix below]({{REPO_URL}}/raw/main/docs/screenshots/verdict.png)

![Evidence panel: 132 executed checks, the three DISAGREE banners where execution overruled folklore, the sqlite.org-vs-Stack-Overflow conflict resolved by execution, citations table, and the MySQL/SQL Server refusal cards]({{REPO_URL}}/raw/main/docs/screenshots/evidence.png)

## Where Sanity Context comes in

Path One wants *meaningful* use of Context, so Context is the **read path of
the agent**, not decoration:

- **Two hosted MCP endpoints.** `collator-kb` serves only the Knowledge Base
  (search and read tools). `collator-data` serves the dataset through GROQ
  (`initial_context`, `schema_explorer`, `groq_query`). They stay separate on
  purpose, because an endpoint that mixes a dataset with a Knowledge Base
  serves the dataset and ignores the Knowledge Base. The harness in
  `src/agent/mcp.ts` lists the tools of both endpoints at startup and exposes
  them beside `run_oracle` and `check_pair`: one tool namespace, one tier
  contract.
- **Structured content, five document types:** `engineProfile`,
  `testVector`, `sourceClaim` (with URL and checked status), `engineRun` (the
  executed matrix), `sourceManifest` (prior art and credits). Seeded by
  `scripts/seed.ts` through the raw mutations API, with no SDK dependency.
  The seed writes 198 documents.
- **A Knowledge Base built around the 150 document cap.** The Knowledge Base
  indexes at most 150 documents. 156 of my 198 documents are raw `engineRun`
  probe rows, so the Knowledge Base takes a GROQ filter that leaves them out
  and keeps the 42 documents the agent actually cites (12 test vectors, 15
  engine profiles, 14 claims, 1 prior-art register). The raw runs stay
  reachable through the GROQ endpoint.
- **The agent reads its citations from Sanity.** In the run below, the agent
  first searched the Knowledge Base, then asked the dataset endpoint for the
  prior-art register and the matching claim, then executed the exact pair from
  that claim. Sanity supplied the claim, the URL and the recorded status. The
  oracle supplied the verdict.
- Everything degrades honestly: no env vars means no Context tools, a warning,
  and the oracle still answers.

The question I asked the agent was: *"Read the prior-art entry for the Stack
Overflow NOCASE advice and say what execution showed."*

![Agent run, part 1: Knowledge Base search, GROQ query for the prior-art register, then a real check of JOSÉ against josé]({{REPO_URL}}/raw/main/docs/live%20tests/result1.png)

![Agent run, part 2: the claim is read from Sanity, then its exact vector is executed]({{REPO_URL}}/raw/main/docs/live%20tests/result2.png)

![Agent run, part 3: the answer quotes the prior-art entry and the recorded claim, then lists what each engine did]({{REPO_URL}}/raw/main/docs/live%20tests/result3.png)

![Agent run, part 4: caveats, including two PostgreSQL setups it refused to judge]({{REPO_URL}}/raw/main/docs/live%20tests/result4.png)

The result: the Stack Overflow claim is stored in Sanity with the status
`DISAGREE`. The thread says `COLLATE NOCASE` solves uniqueness. The engine
accepted both rows. The agent reported both sides, said which one was measured,
and named the two configurations it could not run instead of guessing.

## What sets it apart

Collator differs in one architectural way: **the answer is a measured
observable**: a constraint violation or its absence, with sources kept
strictly separate as `DOCUMENTED` and checked against the measurement. When
the docs and the engine disagree, you see both, with the engine winning and
the URL attached.

## Prior art & credits

Collator is assembly, not invention. These did the heavy lifting:

- **[db-fiddle.com](https://www.db-fiddle.com/)** and
  **[sqlfiddle.com](https://sqlfiddle.com/)**: run SQL against real engines in
  the browser. You must know the query; no tiers, no fixed vectors, no claim
  checking.
- **[DbSchema](https://www.dbschema.com/)**: multi-engine schema editor;
  doesn't answer whether two concrete strings collide.
- **[sqlite.org datatypes §3.1 (collation)](https://sqlite.org/datatype3.html#collation)**:
  authoritative `NOCASE`/`BINARY`/`RTRIM` semantics; Collator executes them.
- **[MySQL Unicode collations](https://dev.mysql.com/doc/refman/8.0/en/unicode-charset.html)**:
  the `ai_ci` / PAD SPACE matrix, kept at DOCUMENTED tier here (no
  credentials on this host; it says so rather than guessing).
- **[PostgreSQL `CREATE COLLATION`](https://www.postgresql.org/docs/current/sql-createcollation.html)**:
  deterministic vs nondeterministic, ICU providers; run through PGlite and
  calibrated per collation.
- **[Stack Overflow: case-insensitive unique column in SQLite](https://stackoverflow.com/questions/20914946/how-to-make-a-case-insensitive-unique-column-in-sqlite)**
  and **[ShallowDepth's 5 ways to do case-insensitive search in SQLite](https://shallowdepth.online/posts/2022/01/5-ways-to-implement-case-insensitive-search-in-sqlite-with-full-unicode-support/)**:
  the folklore under test. Correct for ASCII; execution shows where it breaks.
- **[Unicode UAX #15](https://www.unicode.org/reports/tr15/)** (normalization),
  **[UTS #39](https://www.unicode.org/reports/tr39/)** (confusables),
  **[ICU collation](https://unicode-org.github.io/icu/userguide/collation/)**:
  the standards that define the folds. No engine ships confusable folding;
  Collator proves it: every configuration returns `DISTINCT` for homoglyphs.
- **[PGlite](https://pglite.dev/)**: PostgreSQL compiled to WebAssembly, which
  is how this project runs real Postgres with no server and no credentials.

## Honest limitations

- MySQL and SQL Server claims stay `UNVERIFIED` until credentials exist
  (`MYSQL_*` / `PG*`); PostgreSQL *server* results are via PGlite, not a
  locally-configured cluster.
- A host Application Control policy can block DuckDB's native library; the
  oracle then reports `UNAVAILABLE` with remediation instead of pretending.
- The Knowledge Base search is an exact keyword search. In my run, a long
  phrase matched nothing, and the agent fell back to the GROQ endpoint to find
  the entry. Short keywords work better.
- A verdict is always scoped: **named engine + named collation**, never
  "databases in general".

## Run it

```bash
npm install
npm run evidence      # 132 checks -> evidence/report.json
npm run serve         # http://127.0.0.1:4173  (checker needs no key)
npm test              # 40 tests: verdicts, divergences, harness, API, MCP config
npm run ask -- --pair "José@x.com" "Jose@x.com"   # needs LLM_* in .env
```

Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, DeepSeek,
Gemini, Ollama): set `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY`.

---

*Built for the Sanity Challenge, Path One. Structure, evidence tiers, and the
`SPLIT`/`REFUSED` states are the part I'd defend in review: a system that can
say "I could not run this, and here's why" is worth more than one that's
always confident.*
