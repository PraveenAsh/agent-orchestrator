/**
 * Session manager factory for the CLI.
 *
 * Creates a PluginRegistry with all available plugins loaded,
 * then creates a SessionManager instance backed by core's implementation.
 * This ensures the CLI uses the same hash-based naming, metadata format,
 * and plugin abstractions as the rest of the system.
 */

import {
  createPluginRegistry,
  createSessionManager,
  type OrchestratorConfig,
  type SessionManager,
  type PluginRegistry,
} from "@composio/ao-core";

let cachedRegistry: PluginRegistry | null = null;

/**
 * Get or create the plugin registry.
 * Cached to avoid re-importing all plugins on every call.
 */
async function getRegistry(config: OrchestratorConfig): Promise<PluginRegistry> {
  if (!cachedRegistry) {
    cachedRegistry = createPluginRegistry();
    await cachedRegistry.loadFromConfig(config);
  }
  return cachedRegistry;
}

/**
 * Create a SessionManager backed by core's implementation.
 * Initializes the plugin registry from config and wires everything up.
 */
export async function getSessionManager(config: OrchestratorConfig): Promise<SessionManager> {
  const registry = await getRegistry(config);
  return createSessionManager({ config, registry });
}

