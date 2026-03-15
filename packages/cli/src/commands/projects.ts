import { Command } from "commander";
import { createClient, resolveOrgId, truncate } from "../utils.js";

export const projectsCommand = new Command("projects")
  .description("List projects")
  .option("--org <orgId>", "Organization ID (auto-detected if omitted)")
  .option("--json", "Output as JSON instead of table")
  .action(async (options: {
    org?: string;
    json?: boolean;
  }) => {
    const { auth, client } = createClient();
    const orgId = await resolveOrgId(auth, options.org);

    const projects = await client.listProjects(orgId);

    if (options.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }

    if (projects.length === 0) {
      console.log("No projects found.");
      return;
    }

    const nameWidth = 30;
    const descWidth = 40;

    console.log(
      `  ${"Name".padEnd(nameWidth)}  ${"Description".padEnd(descWidth)}  Docs`
    );

    for (const project of projects) {
      const name = truncate(project.name, nameWidth);
      const desc = truncate(project.description ?? "", descWidth);
      const docs = project.docs_count ?? 0;
      console.log(
        `  ${name.padEnd(nameWidth)}  ${desc.padEnd(descWidth)}  ${docs}`
      );
    }

    console.log(`\n  ${projects.length} project(s) found.`);
  });
