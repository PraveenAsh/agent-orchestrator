/**
 * Terminal server that manages ttyd instances for tmux sessions.
 *
 * Runs alongside Next.js. Spawns a ttyd process per session on demand,
 * each on a unique port. The dashboard embeds ttyd via iframe.
 *
 * ttyd handles all the hard parts: xterm.js, WebSocket, ANSI rendering,
 * cursor positioning, resize, input — battle-tested and correct.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";

interface TtydInstance {
  sessionId: string;
  port: number;
  process: ChildProcess;
}

const instances = new Map<string, TtydInstance>();
let nextPort = 7800; // Start ttyd instances from port 7800

function getOrSpawnTtyd(sessionId: string): TtydInstance {
  const existing = instances.get(sessionId);
  if (existing) return existing;

  const port = nextPort++;
  console.log(`[Terminal] Spawning ttyd for ${sessionId} on port ${port}`);

  // Enable mouse mode so scroll works as scrollback, not input cycling
  spawn("tmux", ["set-option", "-t", sessionId, "mouse", "on"]);

  // Hide the green status bar for cleaner appearance
  spawn("tmux", ["set-option", "-t", sessionId, "status", "off"]);

  const proc = spawn("ttyd", [
    "--writable",
    "--port", String(port),
    "--base-path", `/${sessionId}`,
    "tmux", "attach-session", "-t", sessionId,
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    console.log(`[Terminal] ttyd ${sessionId}: ${data.toString().trim()}`);
  });

  proc.on("exit", (code) => {
    console.log(`[Terminal] ttyd ${sessionId} exited with code ${code}`);
    instances.delete(sessionId);
  });

  proc.on("error", (err) => {
    console.error(`[Terminal] ttyd ${sessionId} error:`, err.message);
    instances.delete(sessionId);
  });

  const instance: TtydInstance = { sessionId, port, process: proc };
  instances.set(sessionId, instance);
  return instance;
}

// Simple HTTP API for the dashboard to request terminal URLs
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  // CORS for dashboard
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // GET /terminal?session=ao-1 → returns { url, port }
  if (url.pathname === "/terminal") {
    const sessionId = url.searchParams.get("session");
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing session parameter" }));
      return;
    }

    const instance = getOrSpawnTtyd(sessionId);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      url: `http://localhost:${instance.port}/${sessionId}/`,
      port: instance.port,
      sessionId,
    }));
    return;
  }

  // GET /health
  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      instances: Object.fromEntries(
        [...instances.entries()].map(([id, inst]) => [id, { port: inst.port }])
      ),
    }));
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

const PORT = parseInt(process.env.TERMINAL_PORT ?? "3001", 10);

server.listen(PORT, () => {
  console.log(`[Terminal] Server listening on port ${PORT}`);
});

// Graceful shutdown — kill all ttyd instances
process.on("SIGINT", () => {
  console.log("[Terminal] Shutting down...");
  for (const [, instance] of instances) {
    instance.process.kill();
  }
  server.close();
  process.exit(0);
});
