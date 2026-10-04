import { defineField, defineType } from "sanity";

/** A duplicate-identity failure mode: the pair of strings and why it matters. */
export default defineType({
  name: "testVector",
  title: "Test vector",
  type: "document",
  fields: [
    defineField({
      name: "vectorId",
      title: "Vector id",
      type: "string",
      description: "Stable id used by the oracle, e.g. sharp-s",
      validation: (r) => r.required(),
    }),
    defineField({
      name: "klass",
      title: "Class",
      type: "string",
      options: {
        list: ["case", "accent", "normalization", "whitespace", "confusable", "adhoc"],
      },
      validation: (r) => r.required(),
    }),
    defineField({ name: "label", title: "Label", type: "string", validation: (r) => r.required() }),
    defineField({ name: "a", title: "Value A", type: "string", validation: (r) => r.required() }),
    defineField({ name: "b", title: "Value B", type: "string", validation: (r) => r.required() }),
    defineField({
      name: "why",
      title: "Why this pair",
      type: "text",
      description: "The real-world duplicate this produces",
    }),
  ],
  preview: {
    select: { title: "label", subtitle: "klass" },
  },
});
