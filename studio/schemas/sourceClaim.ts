import { defineField, defineType } from "sanity";

/**
 * A sourced claim about how an engine behaves, kept separately from what the
 * oracle observed, so the two can be compared honestly.
 *
 * vendor-doc and spec are authoritative in their own domain; folklore is
 * Stack Overflow / blog advice. The status field records the result of
 * checking this claim against execution.
 */
export default defineType({
  name: "sourceClaim",
  title: "Source claim",
  type: "document",
  fields: [
    defineField({
      name: "claimId",
      title: "Claim id",
      type: "string",
      validation: (r) => r.required(),
    }),
    defineField({
      name: "kind",
      title: "Kind",
      type: "string",
      options: { list: ["vendor-doc", "spec", "folklore"] },
      validation: (r) => r.required(),
    }),
    defineField({ name: "source", title: "Source", type: "string", validation: (r) => r.required() }),
    defineField({ name: "url", title: "URL", type: "url", validation: (r) => r.required() }),
    defineField({ name: "engine", title: "Engine this is about", type: "string" }),
    defineField({
      name: "predicts",
      title: "Predicts",
      type: "string",
      options: { list: ["COLLIDES", "DISTINCT"] },
      validation: (r) => r.required(),
    }),
    defineField({
      name: "vector",
      title: "Checked against vector",
      type: "reference",
      to: [{ type: "testVector" }],
    }),
    defineField({ name: "quote", title: "Quoted text", type: "text" }),
    defineField({
      name: "status",
      title: "Checked against execution",
      type: "string",
      options: { list: ["AGREE", "DISAGREE", "UNVERIFIED"] },
      description: "Set by `npm run evidence`; DISAGREE means execution overruled this source",
    }),
    defineField({ name: "observation", title: "What execution showed", type: "text" }),
  ],
  preview: {
    select: { title: "claimId", subtitle: "source", description: "status" },
  },
});
