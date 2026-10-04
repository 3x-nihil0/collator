/**
 * Prior art & credits.
 *
 * Every source Collator leans on, what it contributes, and where it stops.
 * Seeded into Sanity as `sourceManifest` (the Knowledge Base reads it back
 * through kb__knowledge_base_read) and printed in the README and the DEV post.
 *
 * The "difference" field is the honest version of the novelty claim: none of
 * these tools answers "would MY unique constraint treat THESE two strings as
 * one row" by executing that constraint.
 */
export interface PriorArtEntry {
  label: string;
  url: string;
  kind: "vendor-doc" | "spec" | "folklore" | "tool";
  contribution: string;
  difference: string;
}

export const PRIOR_ART: PriorArtEntry[] = [
  {
    label: "db-fiddle.com",
    url: "https://www.db-fiddle.com/",
    kind: "tool",
    contribution: "Run SQL against real database engines in the browser and see the result.",
    difference:
      "You write the SQL and read the output. It does not know what a UNIQUE constraint " +
      "means, has no Unicode edge-case vectors, and publishes no evidence tier - the result " +
      "is whatever you pasted, with no claim checking.",
  },
  {
    label: "sqlfiddle.com",
    url: "https://sqlfiddle.com/",
    kind: "tool",
    contribution: "Compare SQL behaviour across MySQL, PostgreSQL, SQLite and others side by side.",
    difference:
      "Same shape as db-fiddle: a scratchpad for queries you already know how to write. " +
      "Collator instead executes a fixed, sourced set of duplicate-identity pairs and checks " +
      "documented claims against what the engines actually did.",
  },
  {
    label: "DbSchema multi-engine editor",
    url: "https://www.dbschema.com/",
    kind: "tool",
    contribution: "Design schemas and run queries against several engines from one editor.",
    difference:
      "Schema design and browse tooling. It never answers whether two concrete string values " +
      "would collide, and never flags when its own documentation disagrees with the engine.",
  },
  {
    label: "sqlite.org - Datatypes In SQLite, 3.1 Built-in Collating Sequences",
    url: "https://sqlite.org/datatype3.html#collation",
    kind: "vendor-doc",
    contribution: "Authoritative NOCASE / BINARY / RTRIM semantics - the sentence NOCASE folds ASCII only.",
    difference:
      "Correct documentation of one rule. Collator executes that rule against your pair and " +
      "shows the row SQLite actually rejected.",
  },
  {
    label: "MySQL 8.0 Reference - Unicode Character Sets",
    url: "https://dev.mysql.com/doc/refman/8.0/en/unicode-charset.html",
    kind: "vendor-doc",
    contribution: "utf8mb4_0900_ai_ci vs as_cs, PAD SPACE vs NO PAD - the collation matrix.",
    difference:
      "Authoritative prose we could not execute here (no credentials on this host), so Collator " +
      "keeps MySQL findings at DOCUMENTED and says so instead of promoting them to a verdict.",
  },
  {
    label: "PostgreSQL - CREATE COLLATION",
    url: "https://www.postgresql.org/docs/current/sql-createcollation.html",
    kind: "vendor-doc",
    contribution: "Deterministic vs nondeterministic collations, ICU providers, libc providers.",
    difference:
      "Documentation. Collator runs the real thing through PGlite (PostgreSQL 18 in WASM) and " +
      "calibrates every collation before publishing a single result from it.",
  },
  {
    label: 'Stack Overflow - "case-insensitive unique column in SQLite"',
    url: "https://stackoverflow.com/questions/20914946/how-to-make-a-case-insensitive-unique-column-in-sqlite",
    kind: "folklore",
    contribution: "The advice almost everyone follows: add COLLATE NOCASE.",
    difference:
      "Execution shows the advice fails for JOSÉ vs josé - NOCASE folds ASCII only. The thread " +
      "says UNIQUE solved; the engine says two rows. Collator publishes the divergence.",
  },
  {
    label: "ShallowDepth - 5 ways to implement case-insensitive search in SQLite",
    url: "https://shallowdepth.online/posts/2022/01/5-ways-to-implement-case-insensitive-search-in-sqlite-with-full-unicode-support/",
    kind: "folklore",
    contribution: "Practical survey of NOCASE, ICU extension, and custom collations in SQLite.",
    difference:
      "A blog survey with copy-paste collations. Collator tests the same ideas on 12 vectors " +
      "and reports which ones the engine accepted, with tiers.",
  },
  {
    label: "Unicode UAX #15 - Unicode Normalization Forms",
    url: "https://www.unicode.org/reports/tr15/",
    kind: "spec",
    contribution: "NFC / NFD / NFKC / NFKD - why café and cafe+combining acute are one character apart.",
    difference:
      "Defines the transformations, not who applies them. Collator shows which engine applies " +
      "which form - or none - inside a UNIQUE constraint.",
  },
  {
    label: "Unicode UTS #39 - Unicode Security Mechanisms (confusables)",
    url: "https://www.unicode.org/reports/tr39/",
    kind: "spec",
    contribution: "Confusable detection: Cyrillic а and Latin a are the same glyph.",
    difference:
      "No database engine implements confusable folding. Collator proves that by execution: " +
      "every configuration reports DISTINCT, so the homoglyph duplicate sails through.",
  },
  {
    label: "ICU - Collation",
    url: "https://unicode-org.github.io/icu/userguide/collation/",
    kind: "spec",
    contribution: "Primary/secondary/tertiary strengths - the model behind ai_ci style collations.",
    difference:
      "ICU explains the theory; Collator checks whether a given build actually applies it. On " +
      "this host, two configurations were rejected by calibration for failing exactly that check.",
  },
];
