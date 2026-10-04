import { CORPUS, type CorpusDoc } from "./corpus.js";
import type { EvidenceReport, Outcome, Vector } from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "in", "of", "to", "and", "or", "for", "is", "are", "on", "with",
  "how", "do", "i", "you", "it", "this", "that", "be", "as", "at", "by", "from",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏ]+/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

export interface RankedDoc {
  doc: CorpusDoc;
  score: number;
  matchedTerms: string[];
}

/** Plain TF-IDF over the corpus - the retrieval method keyword search uses. */
export function rank(query: string, corpus: CorpusDoc[] = CORPUS): RankedDoc[] {
  const qTerms = tokenize(query);
  const qSet = new Set(qTerms);
  const docsTokens = corpus.map((doc) => tokenize(`${doc.title} ${doc.title} ${doc.text}`));
  const n = corpus.length;

  const df = new Map<string, number>();
  for (const tokens of docsTokens) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const idf = (t: string) => Math.log((n + 1) / ((df.get(t) ?? 0) + 1)) + 1;

  const scored = corpus.map((doc, i) => {
    const tokens = docsTokens[i]!;
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

    let score = 0;
    const matched: string[] = [];
    for (const term of qSet) {
      const f = tf.get(term);
      if (!f) continue;
      matched.push(term);
      score += (f / tokens.length) * idf(term);
    }
    return { doc, score, matchedTerms: matched.sort() };
  });

  return scored.sort((a, b) => b.score - a.score);
}

/** What the top-ranked document tells you to do. */
export function baselineRecommendation(ranking: RankedDoc[]): {
  doc: CorpusDoc;
  engineId?: string;
  policyId?: string;
} | null {
  const top = ranking[0];
  if (!top) return null;
  return {
    doc: top.doc,
    ...(top.doc.recommends?.engineId ? { engineId: top.doc.recommends.engineId } : {}),
    ...(top.doc.recommends?.policyId ? { policyId: top.doc.recommends.policyId } : {}),
  };
}

function observed(
  report: EvidenceReport,
  target: { engineId?: string; policyId?: string },
  vectorId: string,
): Outcome | null {
  if (target.engineId) {
    const hit = report.results.find((r) => r.engineId === target.engineId && r.vectorId === vectorId);
    return hit && hit.tier === "EXECUTED" ? hit.outcome : null;
  }
  if (target.policyId) {
    const p = report.policies.find((x) => x.policyId === target.policyId && x.vectorId === vectorId);
    if (p && p.tier === "EXECUTED" && p.equal !== null) return p.equal ? "COLLIDES" : "DISTINCT";
  }
  return null;
}

export interface BaselineEvaluation {
  target: { engineId?: string; policyId?: string };
  /** vectors whose *stated* class the recommendation claims to handle */
  expectedCollideFor: string[];
  correct: number;
  total: number;
  rows: { vectorId: string; expected: Outcome; actual: Outcome | null }[];
}

/**
 * Hold the keyword result against reality.
 *
 * The claim a recommendation makes is class-level ("this makes the column
 * case insensitive", "lowercasing removes case-driven duplicates"), so every
 * vector in the matching class should COLLIDE. Anything else is a wrong answer
 * handed out with confidence.
 */
export function evaluateRecommendation(
  report: EvidenceReport,
  target: { engineId?: string; policyId?: string },
  claimClass: string,
): BaselineEvaluation {
  const vectors: Vector[] = report.vectors.filter((v) => v.klass === claimClass);
  const rows = vectors.map((v) => {
    const expected: Outcome = "COLLIDES";
    const actual = observed(report, target, v.id);
    return { vectorId: v.id, expected, actual };
  });
  const correct = rows.filter((r) => r.actual === r.expected).length;
  return {
    target,
    expectedCollideFor: vectors.map((v) => v.id),
    correct,
    total: rows.length,
    rows,
  };
}
