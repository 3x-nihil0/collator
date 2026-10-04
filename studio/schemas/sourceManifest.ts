import { defineField, defineType } from "sanity";

/**
 * The Prior art & credits register, as structured content.
 *
 * This is the document the Knowledge Base is built from: every URL Collator
 * borrows from, what it contributes, and how it differs from what Collator
 * does. Cited by the submission and readable back by the agent through
 * kb__knowledge_base_read.
 */
export default defineType({
  name: "sourceManifest",
  title: "Source manifest",
  type: "document",
  fields: [
    defineField({ name: "title", title: "Title", type: "string", validation: (r) => r.required() }),
    defineField({
      name: "entries",
      title: "Sources",
      type: "array",
      of: [
        {
          type: "object",
          fields: [
            defineField({ name: "label", title: "Label", type: "string", validation: (r) => r.required() }),
            defineField({ name: "url", title: "URL", type: "url", validation: (r) => r.required() }),
            defineField({
              name: "kind",
              title: "Kind",
              type: "string",
              options: {
                list: [
                  { title: "Vendor documentation", value: "vendor-doc" },
                  { title: "Standard / spec", value: "spec" },
                  { title: "Folklore (SO / blog)", value: "folklore" },
                  { title: "Comparable tool", value: "tool" },
                ],
              },
            }),
            defineField({
              name: "contribution",
              title: "What we take from it",
              type: "text",
              validation: (r) => r.required(),
            }),
            defineField({
              name: "difference",
              title: "How Collator differs",
              type: "text",
              description: "Why this source alone does not answer the question",
            }),
          ],
          preview: {
            select: { title: "label", subtitle: "url" },
          },
        },
      ],
    }),
  ],
});
