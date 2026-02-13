import { execFile } from "node:child_process";
import type {
  PluginModule,
  Terminal,
  Session,
} from "@agent-orchestrator/core";

export const manifest = {
  name: "iterm2",
  slot: "terminal" as const,
  description: "Terminal plugin: macOS iTerm2 tab management",
  version: "0.1.0",
};

/**
 * Run an AppleScript snippet and return stdout.
 */
function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("osascript", ["-e", script], (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout.trim());
    });
  });
}

/**
 * Check if an iTerm2 tab already exists for this session by matching profile name.
 * Returns true if found (and selects it), false otherwise.
 */
async function findAndSelectExistingTab(sessionName: string): Promise<boolean> {
  const script = `
tell application "iTerm2"
    repeat with aWindow in windows
        repeat with aTab in tabs of aWindow
            repeat with aSession in sessions of aTab
                try
                    if profile name of aSession is equal to "${sessionName}" then
                        select aWindow
                        select aTab
                        return "FOUND"
                    end if
                end try
            end repeat
        end repeat
    end repeat
    return "NOT_FOUND"
end tell`;

  const result = await runAppleScript(script);
  return result === "FOUND";
}

/**
 * Open a new iTerm2 tab and attach to the given tmux session.
 */
async function openNewTab(sessionName: string): Promise<void> {
  const script = `
tell application "iTerm2"
    activate
    tell current window
        create tab with default profile
        tell current session
            set name to "${sessionName}"
            write text "printf '\\\\033]0;${sessionName}\\\\007' && tmux attach -t ${sessionName}"
        end tell
    end tell
end tell`;

  await runAppleScript(script);
}

/**
 * Open a new iTerm2 window with the first session, then add tabs for the rest.
 */
async function openNewWindow(sessionName: string): Promise<void> {
  const script = `
tell application "iTerm2"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        set name to "${sessionName}"
        write text "printf '\\\\033]0;${sessionName}\\\\007' && tmux attach -t ${sessionName}"
    end tell
end tell`;

  await runAppleScript(script);
}

function getSessionName(session: Session): string {
  // Use the runtime handle id if available (tmux session name), otherwise session id
  return session.runtimeHandle?.id ?? session.id;
}

export function create(): Terminal {
  return {
    name: "iterm2",

    async openSession(session: Session): Promise<void> {
      const sessionName = getSessionName(session);

      // Try to find and select an existing tab first
      const found = await findAndSelectExistingTab(sessionName);
      if (!found) {
        await openNewTab(sessionName);
      }
    },

    async openAll(sessions: Session[]): Promise<void> {
      if (sessions.length === 0) return;

      for (const session of sessions) {
        const sessionName = getSessionName(session);
        const found = await findAndSelectExistingTab(sessionName);
        if (!found) {
          await openNewTab(sessionName);
        }
        // Small delay between tab operations to avoid AppleScript race conditions
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    },

    async isSessionOpen(session: Session): Promise<boolean> {
      const sessionName = getSessionName(session);
      try {
        return await findAndSelectExistingTab(sessionName);
      } catch {
        return false;
      }
    },
  };
}

export default { manifest, create } satisfies PluginModule<Terminal>;
