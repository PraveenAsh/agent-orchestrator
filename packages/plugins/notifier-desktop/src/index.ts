import { execFile } from "node:child_process";
import { platform } from "node:os";
import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  EventPriority,
} from "@agent-orchestrator/core";

export const manifest = {
  name: "desktop",
  slot: "notifier" as const,
  description: "Notifier plugin: OS desktop notifications",
  version: "0.1.0",
};

interface DesktopNotifierConfig {
  /** Dashboard URL for click-through deep-links */
  dashboardUrl?: string;
  /** Whether to use sound for urgent notifications (default: true) */
  sound?: boolean;
}

/**
 * Map event priority to notification urgency:
 * - urgent: sound alert
 * - action: normal notification
 * - info/warning: silent
 */
function shouldPlaySound(priority: EventPriority, soundEnabled: boolean): boolean {
  if (!soundEnabled) return false;
  return priority === "urgent";
}

function formatTitle(event: OrchestratorEvent): string {
  const prefix = event.priority === "urgent" ? "URGENT" : "Agent Orchestrator";
  return `${prefix} [${event.sessionId}]`;
}

function formatMessage(event: OrchestratorEvent): string {
  return event.message;
}

function formatActionsMessage(event: OrchestratorEvent, actions: NotifyAction[]): string {
  const actionLabels = actions.map((a) => a.label).join(" | ");
  return `${event.message}\n\nActions: ${actionLabels}`;
}

/**
 * Send a desktop notification using osascript (macOS) or notify-send (Linux).
 * Falls back gracefully if neither is available.
 */
function sendNotification(
  title: string,
  message: string,
  options: {
    sound: boolean;
    url?: string;
  },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const os = platform();

    if (os === "darwin") {
      // macOS: use osascript with display notification
      const soundClause = options.sound ? ' sound name "default"' : "";
      const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}${soundClause}`;
      execFile("osascript", ["-e", script], (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else if (os === "linux") {
      // Linux: use notify-send
      const args = [title, message];
      if (options.sound) {
        args.push("--urgency=critical");
      }
      execFile("notify-send", args, (err) => {
        if (err) reject(err);
        else resolve();
      });
    } else {
      // Unsupported platform — log and resolve
      console.warn(`[notifier-desktop] Desktop notifications not supported on ${os}`);
      resolve();
    }
  });
}

export function create(config?: Record<string, unknown>): Notifier {
  const dashboardUrl = (config?.dashboardUrl as string) ?? "http://localhost:9847";
  const soundEnabled = (config?.sound as boolean) ?? true;

  return {
    name: "desktop",

    async notify(event: OrchestratorEvent): Promise<void> {
      const title = formatTitle(event);
      const message = formatMessage(event);
      const sound = shouldPlaySound(event.priority, soundEnabled);

      await sendNotification(title, message, {
        sound,
        url: `${dashboardUrl}/sessions/${event.sessionId}`,
      });
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      const title = formatTitle(event);
      const message = formatActionsMessage(event, actions);
      const sound = shouldPlaySound(event.priority, soundEnabled);

      await sendNotification(title, message, {
        sound,
        url: actions.find((a) => a.url)?.url ?? `${dashboardUrl}/sessions/${event.sessionId}`,
      });
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
