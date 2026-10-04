import { defineField, defineType } from "sanity";

/**
 * One executed probe: engine configuration x test vector -> outcome.
 *
 * Seeded from evidence/report.json by `npm run seed`. This is what makes the
 * dataset queryable from Context GROQ mode - an agent can ask the dataset
 * "what did execution show for NOCASE on sharp-s?" instead of asking us.
 */
export default defineType({
  name: "engineRun",
  title: "Engine run",
  type: "document",
  fields: [
    defineField({
      name: "engineId",
      title: "Engine id",
      type: "string",
      validation: (r) => r.required(),
    }),
    defineField({
      name: "vectorId",
      title: "Vector id",
      type: "string",
      validation: (r) => r.required(),
    }),
    defineField({
      name: "outcome",
      title: "Outcome",
      type: "string",
      options: { list: ["COLLIDES", "DISTINCT", "ERROR"] },
      validation: (r) => r.required(),
    }),
    defineField({
      name: "tier",
      title: "Evidence tier",
      type: "string",
      options: { list: ["EXECUTED", "DOCUMENTED", "UNAVAILABLE"] },
      validation: (r) => r.required(),
    }),
    defineField({ name: "detail", title: "Raw detail", type: "text" }),
    defineField({ name: "generatedAt", title: "Executed at", type: "datetime" }),
  ],
  preview: {
    select: { title: "engineId", subtitle: "vectorId", description: "outcome" },
  },
});
