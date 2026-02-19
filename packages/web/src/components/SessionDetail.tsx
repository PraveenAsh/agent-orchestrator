"use client";

import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { type DashboardSession, type DashboardPR } from "@/lib/types";
import { CI_STATUS } from "@composio/ao-core/types";
import { cn } from "@/lib/cn";
import { CICheckList } from "./CIBadge";
import { DirectTerminal } from "./DirectTerminal";
import { ActivityDot } from "./ActivityDot";

interface OrchestratorZones {
  merge: number;
  respond: number;
  review: number;
  pending: number;
  working: number;
  done: number;
}

interface SessionDetailProps {
  session: DashboardSession;
  isOrchestrator?: boolean;
  orchestratorZones?: OrchestratorZones;
}

// ── Helpers ──────────────────────────────────────────────────────────

const activityMeta: Record<string, { label: string; color: string }> = {
  active:        { label: "Active",           color: "var(--color-status-working)" },
  ready:         { label: "Ready",            color: "var(--color-status-ready)" },
  idle:          { label: "Idle",             color: "var(--color-status-idle)" },
  waiting_input: { label: "Waiting for input",color: "var(--color-status-attention)" },
  blocked:       { label: "Blocked",          color: "var(--color-status-error)" },
  exited:        { label: "Exited",           color: "var(--color-status-error)" },
};

function humanizeStatus(status: string): string {
  return status
    .replace(/_/g, " ")
    .replace(/\bci\b/gi, "CI")
    .replace(/\bpr\b/gi, "PR")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function cleanBugbotComment(body: string): { title: string; description: string } {
  const isBugbot = body.includes("<!-- DESCRIPTION START -->") || body.includes("### ");
  if (isBugbot) {
    const titleMatch = body.match(/###\s+(.+?)(?:\n|$)/);
    const title = titleMatch ? titleMatch[1].replace(/\*\*/g, "").trim() : "Comment";
    const descMatch = body.match(
      /<!-- DESCRIPTION START -->\s*([\s\S]*?)\s*<!-- DESCRIPTION END -->/,
    );
    const description = descMatch ? descMatch[1].trim() : body.split("\n")[0] || "No description";
    return { title, description };
  }
  return { title: "Comment", description: body.trim() };
}

function buildGitHubBranchUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}/tree/${pr.branch}`;
}

function buildGitHubRepoUrl(pr: DashboardPR): string {
  return `https://github.com/${pr.owner}/${pr.repo}`;
}

async function askAgentToFix(
  sessionId: string,
  comment: { url: string; path: string; body: string },
  onSuccess: () => void,
  onError: () => void,
) {
  try {
    const { title, description } = cleanBugbotComment(comment.body);
    const message = `Please address this review comment:\n\nFile: ${comment.path}\nComment: ${title}\nDescription: ${description}\n\nComment URL: ${comment.url}\n\nAfter fixing, mark the comment as resolved at ${comment.url}`;
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    onSuccess();
  } catch (err) {
    console.error("Failed to send message to agent:", err);
    onError();
  }
}

// ── Orchestrator status strip ─────────────────────────────────────────

function OrchestratorStatusStrip({
  zones,
  createdAt,
}: {
  zones: OrchestratorZones;
  createdAt: string;
}) {
  const [uptime, setUptime] = useState<string>("");

  useEffect(() => {
    const compute = () => {
      const diff = Date.now() - new Date(createdAt).getTime();
      const h = Math.floor(diff / 3_600_000);
      const m = Math.floor((diff % 3_600_000) / 60_000);
      setUptime(h > 0 ? `${h}h ${m}m` : `${m}m`);
    };
    compute();
    const id = setInterval(compute, 30_000);
    return () => clearInterval(id);
  }, [createdAt]);

  const counts: Array<{ value: number; label: string; color: string }> = [
    { value: zones.merge,   label: "merge-ready",  color: "var(--color-status-ready)" },
    { value: zones.respond, label: "responding",   color: "var(--color-status-error)" },
    { value: zones.review,  label: "review",       color: "var(--color-accent-orange)" },
    { value: zones.working, label: "working",      color: "var(--color-status-working)" },
    { value: zones.pending, label: "pending",      color: "var(--color-status-attention)" },
    { value: zones.done,    label: "done",         color: "var(--color-text-tertiary)" },
  ].filter((c) => c.value > 0);

  return (
    <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)] px-8 py-3">
      <div className="mx-auto flex max-w-[900px] items-center gap-5">
        {counts.map((c) => (
          <div key={c.label} className="flex items-baseline gap-1">
            <span className="text-[15px] font-bold leading-none" style={{ color: c.color }}>
              {c.value}
            </span>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">{c.label}</span>
          </div>
        ))}
        {counts.length === 0 && (
          <span className="text-[12px] text-[var(--color-text-tertiary)]">no active sessions</span>
        )}
        {uptime && (
          <>
            <div className="ml-auto h-px w-px" />
            <span className="ml-auto font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
              uptime {uptime}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function SessionDetail({ session, isOrchestrator = false, orchestratorZones }: SessionDetailProps) {
  const searchParams = useSearchParams();
  const startFullscreen = searchParams.get("fullscreen") === "true";
  const pr = session.pr;
  const activity = (session.activity && activityMeta[session.activity]) ?? {
    label: session.activity ?? "unknown",
    color: "var(--color-text-muted)",
  };

  const accentColor = "var(--color-accent)";
  const terminalVariant = isOrchestrator ? "orchestrator" : "agent";

  // Terminal height: for orchestrator, fill more of the viewport (less content above)
  const terminalHeight = isOrchestrator
    ? "calc(100vh - 260px)"
    : "max(440px, calc(100vh - 440px))";

  return (
    <div className="min-h-screen bg-[var(--color-bg-base)]">
      {/* Nav bar */}
      <nav className="sticky top-0 z-10 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-surface)]">
        <div className="mx-auto flex max-w-[900px] items-center gap-2 px-8 py-2.5">
          <a
            href="/"
            className="text-[11px] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
          >
            ← Agent Orchestrator
          </a>
          <span className="text-[var(--color-text-tertiary)]">/</span>
          <span className="font-[var(--font-mono)] text-[11px] text-[var(--color-text-tertiary)]">
            {session.id}
          </span>
          {isOrchestrator && (
            <span
              className="ml-1 rounded px-2 py-0.5 text-[10px] font-semibold tracking-[0.04em]"
              style={{
                color: accentColor,
                background: `color-mix(in srgb, ${accentColor} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${accentColor} 20%, transparent)`,
              }}
            >
              orchestrator
            </span>
          )}
        </div>
      </nav>

      {/* Orchestrator status strip */}
      {isOrchestrator && orchestratorZones && (
        <OrchestratorStatusStrip zones={orchestratorZones} createdAt={session.createdAt} />
      )}

      <div className="mx-auto max-w-[900px] px-8 py-6">
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="mb-6">
          <div className="flex items-center gap-3">
            <h1 className="font-[var(--font-mono)] text-[18px] font-semibold tracking-[-0.01em]">
              {session.id}
            </h1>
            {/* Activity badge */}
            <div
              className="flex items-center gap-1.5 rounded-full px-2.5 py-0.5"
              style={{
                background: `color-mix(in srgb, ${activity.color} 12%, transparent)`,
              }}
            >
              <ActivityDot activity={session.activity} dotOnly size={6} />
              <span className="text-[11px] font-semibold" style={{ color: activity.color }}>
                {activity.label}
              </span>
            </div>
          </div>

          {session.summary && (
            <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-text-secondary)]">
              {session.summary}
            </p>
          )}

          {/* Meta chips */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {session.projectId && (
              <>
                {pr ? (
                  <a
                    href={buildGitHubRepoUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
                    style={{ borderRadius: 4 }}
                  >
                    {session.projectId}
                  </a>
                ) : (
                  <span
                    className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)]"
                    style={{ borderRadius: 4 }}
                  >
                    {session.projectId}
                  </span>
                )}
                <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              </>
            )}

            {pr && (
              <>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
                  style={{ borderRadius: 4 }}
                >
                  #{pr.number}
                </a>
                {(session.branch || session.issueUrl) && (
                  <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                )}
              </>
            )}

            {session.branch && (
              <>
                {pr ? (
                  <a
                    href={buildGitHubBranchUrl(pr)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
                    style={{ borderRadius: 4 }}
                  >
                    {session.branch}
                  </a>
                ) : (
                  <span
                    className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 font-[var(--font-mono)] text-[10px] text-[var(--color-text-secondary)]"
                    style={{ borderRadius: 4 }}
                  >
                    {session.branch}
                  </span>
                )}
                {session.issueUrl && (
                  <span className="text-[var(--color-text-tertiary)]">&middot;</span>
                )}
              </>
            )}

            {session.issueUrl && (
              <a
                href={session.issueUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded bg-[var(--color-bg-elevated)] px-2 py-0.5 text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] hover:no-underline"
                style={{ borderRadius: 4 }}
              >
                {session.issueLabel || session.issueUrl}
              </a>
            )}
          </div>

          <ClientTimestamps
            status={session.status}
            createdAt={session.createdAt}
            lastActivityAt={session.lastActivityAt}
          />
        </div>

        {/* ── PR Card ─────────────────────────────────────────────── */}
        {pr && <PRCard pr={pr} sessionId={session.id} />}

        {/* ── Terminal ─────────────────────────────────────────────── */}
        <div className="mt-6">
          <h3 className="mb-3 text-[10px] font-bold uppercase tracking-[0.10em] text-[var(--color-text-tertiary)]">
            Terminal
          </h3>
          <DirectTerminal
            sessionId={session.id}
            startFullscreen={startFullscreen}
            variant={terminalVariant}
            height={terminalHeight}
          />
        </div>
      </div>
    </div>
  );
}

// ── Client-side timestamps ────────────────────────────────────────────

function ClientTimestamps({
  status,
  createdAt,
  lastActivityAt,
}: {
  status: string;
  createdAt: string;
  lastActivityAt: string;
}) {
  const [created, setCreated] = useState<string | null>(null);
  const [lastActive, setLastActive] = useState<string | null>(null);

  useEffect(() => {
    setCreated(relativeTime(createdAt));
    setLastActive(relativeTime(lastActivityAt));
  }, [createdAt, lastActivityAt]);

  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-1.5 text-[11px] text-[var(--color-text-tertiary)]">
      <span>{humanizeStatus(status)}</span>
      {created && (
        <>
          <span>&middot;</span>
          <span>created {created}</span>
        </>
      )}
      {lastActive && (
        <>
          <span>&middot;</span>
          <span>active {lastActive}</span>
        </>
      )}
    </div>
  );
}

// ── PR Card ───────────────────────────────────────────────────────────

function PRCard({ pr, sessionId }: { pr: DashboardPR; sessionId: string }) {
  const [sendingComments, setSendingComments] = useState<Set<string>>(new Set());
  const [sentComments, setSentComments] = useState<Set<string>>(new Set());
  const [errorComments, setErrorComments] = useState<Set<string>>(new Set());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
    };
  }, []);

  const handleAskAgentToFix = async (comment: { url: string; path: string; body: string }) => {
    setSentComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
    setErrorComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
    setSendingComments((prev) => new Set(prev).add(comment.url));

    await askAgentToFix(
      sessionId,
      comment,
      () => {
        setSendingComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
        setSentComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setSentComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
      () => {
        setSendingComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
        setErrorComments((prev) => new Set(prev).add(comment.url));
        const existing = timersRef.current.get(comment.url);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          setErrorComments((prev) => { const next = new Set(prev); next.delete(comment.url); return next; });
          timersRef.current.delete(comment.url);
        }, 3000);
        timersRef.current.set(comment.url, timer);
      },
    );
  };

  const allGreen =
    pr.mergeability.mergeable &&
    pr.mergeability.ciPassing &&
    pr.mergeability.approved &&
    pr.mergeability.noConflicts;

  const failedChecks = pr.ciChecks.filter((c) => c.status === "failed");

  return (
    <div className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-bg-surface)]">
      {/* Title row */}
      <div className="border-b border-[var(--color-border-subtle)] px-4 py-3">
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] font-medium text-[var(--color-text-primary)] transition-colors hover:text-[var(--color-accent)] hover:no-underline"
        >
          PR #{pr.number}: {pr.title}
        </a>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span>
            <span className="text-[var(--color-status-ready)]">+{pr.additions}</span>{" "}
            <span className="text-[var(--color-status-error)]">-{pr.deletions}</span>
          </span>
          {pr.isDraft && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span className="font-semibold text-[var(--color-text-tertiary)]">Draft</span>
            </>
          )}
          {pr.state === "merged" && (
            <>
              <span className="text-[var(--color-text-tertiary)]">&middot;</span>
              <span className="font-semibold text-[var(--color-text-secondary)]">Merged</span>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-4 py-3">
        {/* Ready-to-merge banner */}
        {allGreen ? (
          <div className="flex items-center gap-2 rounded-[4px] border border-[rgba(34,197,94,0.2)] bg-[rgba(34,197,94,0.06)] px-3 py-2">
            <svg className="h-4 w-4 shrink-0 text-[var(--color-status-ready)]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path d="M20 6L9 17l-5-5" />
            </svg>
            <span className="text-[13px] font-semibold text-[var(--color-status-ready)]">
              Ready to merge
            </span>
          </div>
        ) : (
          <IssuesList pr={pr} />
        )}

        {/* CI Checks */}
        {pr.ciChecks.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
            <CICheckList checks={pr.ciChecks} layout={failedChecks.length > 0 ? "expanded" : "inline"} />
          </div>
        )}

        {/* Unresolved comments */}
        {pr.unresolvedComments.length > 0 && (
          <div className="mt-3 border-t border-[var(--color-border-subtle)] pt-3">
            <h4 className="mb-2 text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              Unresolved Comments ({pr.unresolvedThreads})
            </h4>
            <div className="space-y-1">
              {pr.unresolvedComments.map((c) => {
                const { title, description } = cleanBugbotComment(c.body);
                return (
                  <details key={c.url} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-2 rounded px-2 py-1.5 text-[12px] transition-colors hover:bg-[var(--color-bg-elevated)]">
                      <svg
                        className="h-3 w-3 shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        viewBox="0 0 24 24"
                      >
                        <path d="M9 5l7 7-7 7" />
                      </svg>
                      <span className="font-medium text-[var(--color-text-secondary)]">{title}</span>
                      <span className="text-[var(--color-text-tertiary)]">· {c.author}</span>
                      <a
                        href={c.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="ml-auto text-[10px] text-[var(--color-accent)] hover:underline"
                      >
                        view →
                      </a>
                    </summary>
                    <div className="ml-5 mt-1 space-y-1.5 px-2 pb-2">
                      <div className="font-[var(--font-mono)] text-[10px] text-[var(--color-text-tertiary)]">
                        {c.path}
                      </div>
                      <p className="border-l-2 border-[var(--color-border-default)] pl-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
                        {description}
                      </p>
                      <button
                        onClick={() => handleAskAgentToFix(c)}
                        disabled={sendingComments.has(c.url)}
                        className={cn(
                          "mt-1.5 rounded px-3 py-1 text-[11px] font-medium transition-colors",
                          sentComments.has(c.url)
                            ? "bg-[var(--color-status-ready)] text-white"
                            : errorComments.has(c.url)
                              ? "bg-[var(--color-status-error)] text-white"
                              : "bg-[var(--color-accent)] text-white hover:opacity-90 disabled:opacity-50",
                        )}
                        style={{ borderRadius: 4 }}
                      >
                        {sendingComments.has(c.url)
                          ? "Sending…"
                          : sentComments.has(c.url)
                            ? "Sent ✓"
                            : errorComments.has(c.url)
                              ? "Failed"
                              : "Ask Agent to Fix"}
                      </button>
                    </div>
                  </details>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Issues list (pre-merge blockers) ─────────────────────────────────

function IssuesList({ pr }: { pr: DashboardPR }) {
  const issues: Array<{ icon: string; color: string; text: string }> = [];

  if (pr.ciStatus === CI_STATUS.FAILING) {
    const failCount = pr.ciChecks.filter((c) => c.status === "failed").length;
    issues.push({
      icon: "✗",
      color: "var(--color-status-error)",
      text: failCount > 0
        ? `CI failing — ${failCount} check${failCount !== 1 ? "s" : ""} failed`
        : "CI failing",
    });
  } else if (pr.ciStatus === CI_STATUS.PENDING) {
    issues.push({ icon: "●", color: "var(--color-status-attention)", text: "CI pending" });
  }

  if (pr.reviewDecision === "changes_requested") {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Changes requested" });
  } else if (!pr.mergeability.approved) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Not approved — awaiting reviewer" });
  }

  if (pr.state !== "merged" && !pr.mergeability.noConflicts) {
    issues.push({ icon: "✗", color: "var(--color-status-error)", text: "Merge conflicts" });
  }

  if (!pr.mergeability.mergeable && issues.length === 0) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Not mergeable" });
  }

  if (pr.unresolvedThreads > 0) {
    issues.push({
      icon: "●",
      color: "var(--color-status-attention)",
      text: `${pr.unresolvedThreads} unresolved comment${pr.unresolvedThreads !== 1 ? "s" : ""}`,
    });
  }

  if (pr.isDraft) {
    issues.push({ icon: "○", color: "var(--color-text-tertiary)", text: "Draft PR" });
  }

  if (issues.length === 0) return null;

  return (
    <div className="space-y-1.5">
      <h4 className="text-[10px] font-bold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        Issues
      </h4>
      {issues.map((issue) => (
        <div key={issue.text} className="flex items-center gap-2 text-[12px]">
          <span className="w-3 shrink-0 text-center text-[11px]" style={{ color: issue.color }}>
            {issue.icon}
          </span>
          <span className="text-[var(--color-text-secondary)]">{issue.text}</span>
        </div>
      ))}
    </div>
  );
}
