import { defineConfig } from "sanity";
import { structureTool } from "sanity/structure";
import { schemaTypes } from "./schemas";

/**
 * Collator Studio.
 *
 * The dataset holds the structured half of the argument: which engines were
 * executed and what they returned (engineRun), what the sources claim
 * (sourceClaim), the pairs under test (testVector), and the prior-art
 * register (sourceManifest). Context reads this schema - structureTool is the
 * default inspector, no custom layout required.
 */
const projectId = process.env.SANITY_STUDIO_PROJECT_ID ?? "yourprojectid";
const dataset = process.env.SANITY_STUDIO_DATASET ?? "production";

export default defineConfig({
  name: "collator",
  title: "Collator",
  projectId,
  dataset,
  plugins: [structureTool()],
  schema: { types: schemaTypes },
});
