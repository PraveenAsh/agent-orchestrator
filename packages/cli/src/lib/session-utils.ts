import type { OrchestratorConfig } from "@agent-orchestrator/core";

/** Find which project a session belongs to by matching its name against session prefixes. */
export function findProjectForSession(
  config: OrchestratorConfig,
  sessionName: string,
): string | null {
  for (const [id, project] of Object.entries(config.projects)) {
    const prefix = project.sessionPrefix || id;
    if (sessionName.startsWith(`${prefix}-`)) {
      return id;
    }
  }
  return null;
}
