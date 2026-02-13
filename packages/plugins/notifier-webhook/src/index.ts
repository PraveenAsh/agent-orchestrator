import type {
  PluginModule,
  Notifier,
  OrchestratorEvent,
  NotifyAction,
  NotifyContext,
} from "@agent-orchestrator/core";

export const manifest = {
  name: "webhook",
  slot: "notifier" as const,
  description: "Notifier plugin: generic HTTP webhook",
  version: "0.1.0",
};

interface WebhookNotifierConfig {
  /** Target URL to POST events to */
  url?: string;
  /** Custom headers to include (e.g. Authorization) */
  headers?: Record<string, string>;
  /** Maximum retry attempts on failure (default: 2) */
  retries?: number;
  /** Retry delay in ms (default: 1000) */
  retryDelayMs?: number;
}

interface WebhookPayload {
  type: "notification" | "notification_with_actions" | "message";
  event?: {
    id: string;
    type: string;
    priority: string;
    sessionId: string;
    projectId: string;
    timestamp: string;
    message: string;
    data: Record<string, unknown>;
  };
  actions?: Array<{
    label: string;
    url?: string;
    callbackEndpoint?: string;
  }>;
  message?: string;
  context?: NotifyContext;
}

async function postWithRetry(
  url: string,
  payload: WebhookPayload,
  headers: Record<string, string>,
  retries: number,
  retryDelayMs: number,
): Promise<void> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) return;

      const body = await response.text();
      lastError = new Error(`Webhook POST failed (${response.status}): ${body}`);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }

  throw lastError;
}

function serializeEvent(event: OrchestratorEvent): WebhookPayload["event"] {
  return {
    id: event.id,
    type: event.type,
    priority: event.priority,
    sessionId: event.sessionId,
    projectId: event.projectId,
    timestamp: event.timestamp.toISOString(),
    message: event.message,
    data: event.data,
  };
}

export function create(config?: Record<string, unknown>): Notifier {
  const url = config?.url as string | undefined;
  const customHeaders = (config?.headers as Record<string, string>) ?? {};
  const retries = (config?.retries as number) ?? 2;
  const retryDelayMs = (config?.retryDelayMs as number) ?? 1000;

  if (!url) {
    console.warn("[notifier-webhook] No url configured — notifications will be no-ops");
  }

  return {
    name: "webhook",

    async notify(event: OrchestratorEvent): Promise<void> {
      if (!url) return;

      await postWithRetry(
        url,
        { type: "notification", event: serializeEvent(event) },
        customHeaders,
        retries,
        retryDelayMs,
      );
    },

    async notifyWithActions(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void> {
      if (!url) return;

      await postWithRetry(
        url,
        {
          type: "notification_with_actions",
          event: serializeEvent(event),
          actions: actions.map((a) => ({
            label: a.label,
            url: a.url,
            callbackEndpoint: a.callbackEndpoint,
          })),
        },
        customHeaders,
        retries,
        retryDelayMs,
      );
    },

    async post(message: string, context?: NotifyContext): Promise<string | null> {
      if (!url) return null;

      await postWithRetry(
        url,
        { type: "message", message, context },
        customHeaders,
        retries,
        retryDelayMs,
      );
      return null;
    },
  };
}

export default { manifest, create } satisfies PluginModule<Notifier>;
