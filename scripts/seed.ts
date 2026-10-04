/**
 * Seed the Sanity dataset from the evidence report.
 *
 * Idempotent: every document gets a deterministic `_id`, so re-running after
 * `npm run evidence` replaces the run results in place rather than
 * duplicating them. No Sanity SDK - one HTTP POST to the mutations API, so
 * the only credential needed is a project token with write permission.
 *
 *   npm run seed               # build evidence if missing, then seed
 *   npm run seed -- --dry-run  # show what would be written, skip the network
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLAIMS } from "../src/oracle/claims.js";
import { buildEvidence, EVIDENCE_PATH } from "../src/oracle/buildEvidence.js";
import { PRIOR_ART } from "../src/oracle/priorArt.js";
import type { EvidenceReport } from "../src/oracle/types.js";

// ---------------------------------------------------------------------------
// .env loading (no dependency; .env.example documents every key)
// ---------------------------------------------------------------------------

async function loadDotEnv(): Promise<void> {
  try {
    const raw = await readFile(path.resolve(process.cwd(), ".env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* no .env is fine - environment variables alone work */
  }
}

// ---------------------------------------------------------------------------
// Document building
// ---------------------------------------------------------------------------

type SanityDoc = { _id: string; _type: string; [k: string]: unknown };

function idFor(type: string, raw: string): string {
  return `${type}.${raw.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

interface BuiltDocs {
  docs: SanityDoc[];
  counts: Record<string, number>;
}

async function loadEvidence(): Promise<EvidenceReport> {
  try {
    const raw = await readFile(EVIDENCE_PATH, "utf8");
    return JSON.parse(raw) as EvidenceReport;
  } catch {
    process.stdout.write("evidence/report.json missing - running the oracle first...\n");
    return buildEvidence();
  }
}

function buildDocs(report: EvidenceReport): BuiltDocs {
  const docs: SanityDoc[] = [];
  const generatedAt = report.generatedAt;

  // 1. Test vectors
  for (const v of report.vectors) {
    docs.push({
      _id: idFor("testVector", v.id),
      _type: "testVector",
      vectorId: v.id,
      klass: v.klass,
      label: v.label,
      a: v.a,
      b: v.b,
      why: v.why,
    });
  }

  // 2. Engine profiles - executed, calibration-rejected, and named-only
  const failedIds = new Map(report.engineFailures.map((f) => [f.engineId, f.reason]));
  for (const e of report.engines) {
    const rows = report.results.filter((r) => r.engineId === e.id);
    const executed = rows.some((r) => r.tier === "EXECUTED");
    const failure = failedIds.get(e.id);
    docs.push({
      _id: idFor("engineProfile", e.id),
      _type: "engineProfile",
      engineId: e.id,
      engine: e.engine,
      ...(e.version ? { version: e.version } : {}),
      label: e.label,
      ...(e.collation ? { collation: e.collation } : {}),
      evidenceTier: executed ? "EXECUTED" : "UNAVAILABLE",
      executableHere: executed,
      note: failure
        ? `${e.note ?? ""} [rejected by calibration: ${failure}]`.trim()
        : (e.note ?? ""),
    });
  }
  for (const u of report.unavailable) {
    docs.push({
      _id: idFor("engineProfile", u.engine),
      _type: "engineProfile",
      engineId: u.engine,
      engine: u.engine,
      label: `${u.engine} (not executable here)`,
      evidenceTier: u.tier,
      executableHere: false,
      note: u.remediation ? `${u.reason} - ${u.remediation}` : u.reason,
    });
  }

  // 3. Executed runs - one row per engine x vector probe
  for (const r of report.results) {
    docs.push({
      _id: idFor("engineRun", `${r.engineId}.${r.vectorId}`),
      _type: "engineRun",
      engineId: r.engineId,
      vectorId: r.vectorId,
      outcome: r.outcome,
      tier: r.tier,
      detail: r.detail,
      generatedAt,
    });
  }

  // 4. Source claims, with their status as checked against execution
  for (const c of CLAIMS) {
    const div = report.divergences.find((d) => d.claimId === c.id);
    docs.push({
      _id: idFor("sourceClaim", c.id),
      _type: "sourceClaim",
      claimId: c.id,
      kind: c.kind,
      source: c.source,
      url: c.sourceUrl,
      engine: c.engine,
      predicts: c.predicts,
      ...(report.vectors.some((v) => v.id === c.vectorId)
        ? { vector: { _type: "reference", _ref: idFor("testVector", c.vectorId) } }
        : {}),
      quote: c.text,
      status: div?.status ?? "UNVERIFIED",
      ...(div?.note ? { observation: div.note } : {}),
    });
  }

  // 5. Prior art & credits - the Knowledge Base's spine
  docs.push({
    _id: "sourceManifest.priorArt",
    _type: "sourceManifest",
    title: "Prior art & credits",
    entries: PRIOR_ART.map((p) => ({
      _type: "object",
      label: p.label,
      url: p.url,
      kind: p.kind,
      contribution: p.contribution,
      difference: p.difference,
    })),
  });

  const counts: Record<string, number> = {};
  for (const d of docs) counts[d._type] = (counts[d._type] ?? 0) + 1;
  return { docs, counts };
}

// ---------------------------------------------------------------------------
// Mutate
// ---------------------------------------------------------------------------

async function push(projectId: string, dataset: string, token: string, docs: SanityDoc[]): Promise<void> {
  const url = `https://${projectId}.api.sanity.io/v2024-01-01/data/mutate/${encodeURIComponent(dataset)}`;
  const BATCH = 40;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ mutations: batch.map((doc) => ({ createOrReplace: doc })) }),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`mutation batch ${i / BATCH + 1} failed (HTTP ${res.status}): ${text.slice(0, 800)}`);
    }
    process.stdout.write(`  batch ${i / BATCH + 1}: ${batch.length} documents\n`);
  }
}

async function main(): Promise<void> {
  await loadDotEnv();

  const dryRun = process.argv.includes("--dry-run");
  const projectId = process.env.SANITY_PROJECT_ID ?? "";
  const dataset = process.env.SANITY_DATASET || "production";
  const token = process.env.SANITY_API_TOKEN ?? "";

  const report = await loadEvidence();
  const { docs, counts } = buildDocs(report);

  const summary = Object.entries(counts)
    .map(([t, n]) => `${t}=${n}`)
    .join(" ");
  process.stdout.write(`seed payload: ${docs.length} documents (${summary})\n`);

  if (dryRun) {
    process.stdout.write("dry run - no network requests made\n");
    return;
  }

  if (!projectId || !token) {
    process.stderr.write(
      [
        "NOT SEEDED: SANITY_PROJECT_ID and SANITY_API_TOKEN are required.",
        "  1. create a project at manage.sanity.io",
        "  2. Project > API > Tokens > create a token with Editor permission",
        "  3. put them in .env (see .env.example) and re-run `npm run seed`",
        "",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  process.stdout.write(`seeding ${projectId}/${dataset}...\n`);
  await push(projectId, dataset, token, docs);
  process.stdout.write(
    [
      "seeded.",
      "next: Dashboard > Context > create a Knowledge Base over this dataset,",
      "then set SANITY_MCP_* in .env (docs/SANITY_SETUP.md).",
      "",
    ].join("\n"),
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
