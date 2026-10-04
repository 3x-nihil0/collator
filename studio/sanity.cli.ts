import { defineCliConfig } from "sanity/cli";

/**
 * CLI config (required by `sanity dev` / `sanity build` since Sanity v4).
 *
 * Reads the same env vars as sanity.config.ts so one .env drives both the
 * bundle and the CLI - see docs/SANITY_SETUP.md step 7.
 */
const projectId = process.env.SANITY_STUDIO_PROJECT_ID ?? "yourprojectid";
const dataset = process.env.SANITY_STUDIO_DATASET || "production";

export default defineCliConfig({
  api: {
    projectId,
    dataset,
  },
});
