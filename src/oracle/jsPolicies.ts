import type { PolicyResult, Vector } from "./types.js";

/**
 * Application-side policies expressed in JavaScript.
 *
 * These model what the code *you* wrote does before the row ever reaches the
 * database. They exist here because JavaScript has no `casefold()` - only
 * `toLowerCase()` - and the gap between the two is one of the bugs this
 * product exists to surface.
 */
interface JsPolicy {
  id: string;
  label: string;
  fn: (s: string) => string;
}

export const JS_POLICIES: JsPolicy[] = [
  {
    id: "js.toLowerCase",
    label: "String.prototype.toLowerCase()",
    fn: (s) => s.toLowerCase(),
  },
  {
    id: "js.normalizeNFC",
    label: "normalize('NFC')",
    fn: (s) => s.normalize("NFC"),
  },
  {
    id: "js.normalizeNFKC",
    label: "normalize('NFKC')",
    fn: (s) => s.normalize("NFKC"),
  },
  {
    id: "js.canonical",
    label: "NFKC + toLowerCase + trim + NFC",
    fn: (s) => s.normalize("NFC").trim().toLowerCase().normalize("NFKC"),
  },
];

export function runJsPolicies(vectors: Vector[]): PolicyResult[] {
  const out: PolicyResult[] = [];
  for (const policy of JS_POLICIES) {
    for (const vector of vectors) {
      try {
        const na = policy.fn(vector.a);
        const nb = policy.fn(vector.b);
        out.push({
          policyId: policy.id,
          label: policy.label,
          side: "javascript",
          vectorId: vector.id,
          equal: na === nb,
          normalizedA: na,
          normalizedB: nb,
          tier: "EXECUTED",
        });
      } catch (err) {
        out.push({
          policyId: policy.id,
          label: policy.label,
          side: "javascript",
          vectorId: vector.id,
          equal: null,
          normalizedA: "",
          normalizedB: "",
          tier: "UNAVAILABLE",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return out;
}
