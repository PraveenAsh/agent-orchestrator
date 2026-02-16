/**
 * Port utilities — find available ports for the dashboard
 */

import { createServer } from "node:net";

/**
 * Check if a port is available
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close();
      resolve(true);
    });

    server.listen(port);
  });
}

/**
 * Find an available port, starting from the preferred port
 */
export async function findAvailablePort(preferredPort: number, maxAttempts = 10): Promise<number> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = preferredPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(
    `Could not find an available port after ${maxAttempts} attempts (tried ${preferredPort}-${preferredPort + maxAttempts - 1})`,
  );
}
