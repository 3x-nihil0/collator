import { defineField, defineType } from "sanity";

/**
 * One database configuration and the equality rule it actually applies.
 *
 * The evidence tier is the load-bearing field: an engine profile may only
 * claim EXECUTED when Collator's oracle has run that configuration on this
 * host. Everything else is DOCUMENTED with a source, or UNAVAILABLE.
 */
export default defineType({
  name: "engineProfile",
  title: "Engine profile",
  type: "document",
  fields: [
    defineField({
      name: "engineId",
      title: "Engine id",
      type: "string",
      description: "Stable id used by the oracle, e.g. sqlite/nocase",
      validation: (r) => r.required(),
    }),
    defineField({ name: "engine", title: "Engine", type: "string", validation: (r) => r.required() }),
    defineField({ name: "version", title: "Version executed", type: "string" }),
    defineField({ name: "label", title: "Label", type: "string", validation: (r) => r.required() }),
    defineField({ name: "collation", title: "Collation", type: "string" }),
    defineField({
      name: "folds",
      title: "What it folds",
      type: "string",
      description: "Plain-language summary: case, accents, whitespace, compatibility forms...",
    }),
    defineField({
      name: "evidenceTier",
      title: "Evidence tier",
      type: "string",
      options: { list: ["EXECUTED", "DOCUMENTED", "UNAVAILABLE"] },
      validation: (r) => r.required(),
    }),
    defineField({
      name: "executableHere",
      title: "Executable on the build host",
      type: "boolean",
      initialValue: false,
    }),
    defineField({ name: "note", title: "Note", type: "text" }),
    defineField({
      name: "source",
      title: "Source (when DOCUMENTED)",
      type: "url",
    }),
  ],
  preview: {
    select: { title: "label", subtitle: "engine", media: "evidenceTier" },
  },
});
