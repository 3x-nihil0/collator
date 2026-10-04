import { buildEvidence } from "./buildEvidence.js";
import { baselineRecommendation, evaluateRecommendation, rank } from "./baseline.js";

/**
 * Prints the argument the whole product rests on:
 * a keyword search hands you a confident wrong answer, and here is the proof.
 */
async function main(): Promise<void> {
  const report = await buildEvidence();
  const query = "case insensitive unique column sqlite email";

  const ranking = rank(query);
  const top = ranking[0];
  const recommendation = baselineRecommendation(ranking);

  const out: string[] = [];
  out.push(`query: "${query}"`);
  out.push("");
  out.push("TF-IDF ranking over the document pile");
  out.push("  rank  score  document");
  ranking.forEach((r, i) => {
    out.push(
      `  ${String(i + 1).padEnd(5)}  ${r.score.toFixed(4)}  ${r.doc.title.slice(0, 62)}` +
        `${r.score === top?.score ? "   <-- top hit" : ""}`,
    );
    out.push(`         terms: ${r.matchedTerms.join(", ") || "(none)"}`);
  });

  if (!recommendation) {
    out.push("\nno recommendation found");
    process.stdout.write(out.join("\n") + "\n");
    return;
  }

  out.push("");
  out.push(`top hit      : ${recommendation.doc.title}`);
  out.push(`source       : ${recommendation.doc.source}`);
  out.push(`url          : ${recommendation.doc.url}`);
  const targetId = recommendation.engineId ?? recommendation.policyId ?? "(no advice)";
  out.push(`recommends   : ${targetId}`);

  const evaluation = evaluateRecommendation(report, recommendation, "case");
  out.push("");
  out.push(`it promises case-insensitive uniqueness, so all ${evaluation.total} case-class vectors should COLLIDE`);
  out.push("  vector              predicted   actually observed");
  for (const row of evaluation.rows) {
    out.push(
      `  ${row.vectorId.padEnd(20)}${row.expected.padEnd(12)}${row.actual ?? "not executable"}`,
    );
  }
  out.push("");
  out.push(
    `KEYWORD BASELINE: ${evaluation.correct}/${evaluation.total} correct ` +
      `(${Math.round((evaluation.correct / evaluation.total) * 100)}%)`,
  );

  // The same class, handled by a configuration chosen from structured facts.
  const contrastId = "sqlite/nfkc_fold";
  const contrast = evaluateRecommendation(report, { engineId: contrastId }, "case");
  out.push(
    `COLLATOR CHOSEN : ${contrast.correct}/${contrast.total} correct using ${contrastId}`,
  );
  out.push("");

  process.stdout.write(out.join("\n") + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
