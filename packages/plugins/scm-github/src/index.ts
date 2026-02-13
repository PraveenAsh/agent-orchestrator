/**
 * scm-github plugin — GitHub PRs, CI checks, reviews, merge readiness.
 *
 * Uses the `gh` CLI for all GitHub API interactions.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  PluginModule,
  SCM,
  Session,
  ProjectConfig,
  PRInfo,
  PRState,
  MergeMethod,
  CICheck,
  CIStatus,
  Review,
  ReviewDecision,
  ReviewComment,
  AutomatedComment,
  MergeReadiness,
} from "@agent-orchestrator/core";

const execFileAsync = promisify(execFile);

/** Known bot logins that produce automated review comments */
const BOT_AUTHORS = new Set([
  "cursor[bot]",
  "github-actions[bot]",
  "codecov[bot]",
  "sonarcloud[bot]",
  "dependabot[bot]",
  "renovate[bot]",
  "codeclimate[bot]",
  "deepsource-autofix[bot]",
  "snyk-bot",
  "lgtm-com[bot]",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("gh", args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

function repoFlag(pr: PRInfo): string {
  return `${pr.owner}/${pr.repo}`;
}

function parseDate(val: string | undefined | null): Date {
  return val ? new Date(val) : new Date();
}

// ---------------------------------------------------------------------------
// SCM implementation
// ---------------------------------------------------------------------------

function createGitHubSCM(): SCM {
  return {
    name: "github",

    async detectPR(
      session: Session,
      project: ProjectConfig,
    ): Promise<PRInfo | null> {
      if (!session.branch) return null;

      const [owner, repo] = project.repo.split("/");
      try {
        const raw = await gh([
          "pr",
          "list",
          "--repo",
          project.repo,
          "--head",
          session.branch,
          "--json",
          "number,url,title,headRefName,baseRefName,isDraft",
          "--limit",
          "1",
        ]);

        const prs: Array<{
          number: number;
          url: string;
          title: string;
          headRefName: string;
          baseRefName: string;
          isDraft: boolean;
        }> = JSON.parse(raw);

        if (prs.length === 0) return null;

        const pr = prs[0];
        return {
          number: pr.number,
          url: pr.url,
          title: pr.title,
          owner,
          repo,
          branch: pr.headRefName,
          baseBranch: pr.baseRefName,
          isDraft: pr.isDraft,
        };
      } catch {
        return null;
      }
    },

    async getPRState(pr: PRInfo): Promise<PRState> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "state",
      ]);
      const data: { state: string } = JSON.parse(raw);
      const s = data.state.toUpperCase();
      if (s === "MERGED") return "merged";
      if (s === "CLOSED") return "closed";
      return "open";
    },

    async mergePR(pr: PRInfo, method: MergeMethod = "squash"): Promise<void> {
      const flag =
        method === "rebase"
          ? "--rebase"
          : method === "merge"
            ? "--merge"
            : "--squash";

      await gh([
        "pr",
        "merge",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        flag,
        "--delete-branch",
      ]);
    },

    async closePR(pr: PRInfo): Promise<void> {
      await gh([
        "pr",
        "close",
        String(pr.number),
        "--repo",
        repoFlag(pr),
      ]);
    },

    async getCIChecks(pr: PRInfo): Promise<CICheck[]> {
      try {
        const raw = await gh([
          "pr",
          "checks",
          String(pr.number),
          "--repo",
          repoFlag(pr),
          "--json",
          "name,state,conclusion,detailsUrl,startedAt,completedAt",
        ]);

        const checks: Array<{
          name: string;
          state: string;
          conclusion: string;
          detailsUrl: string;
          startedAt: string;
          completedAt: string;
        }> = JSON.parse(raw);

        return checks.map((c) => {
          let status: CICheck["status"];
          const state = c.state?.toUpperCase();
          const conclusion = c.conclusion?.toUpperCase();

          if (state === "PENDING" || state === "QUEUED") {
            status = "pending";
          } else if (state === "IN_PROGRESS") {
            status = "running";
          } else if (conclusion === "SUCCESS") {
            status = "passed";
          } else if (conclusion === "FAILURE" || conclusion === "TIMED_OUT") {
            status = "failed";
          } else if (conclusion === "SKIPPED" || conclusion === "NEUTRAL") {
            status = "skipped";
          } else {
            status = "pending";
          }

          return {
            name: c.name,
            status,
            url: c.detailsUrl || undefined,
            conclusion: c.conclusion || undefined,
            startedAt: c.startedAt ? new Date(c.startedAt) : undefined,
            completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
          };
        });
      } catch {
        return [];
      }
    },

    async getCISummary(pr: PRInfo): Promise<CIStatus> {
      const checks = await this.getCIChecks(pr);
      if (checks.length === 0) return "none";

      const hasFailing = checks.some((c) => c.status === "failed");
      if (hasFailing) return "failing";

      const hasPending = checks.some(
        (c) => c.status === "pending" || c.status === "running",
      );
      if (hasPending) return "pending";

      return "passing";
    },

    async getReviews(pr: PRInfo): Promise<Review[]> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviews",
      ]);
      const data: {
        reviews: Array<{
          author: { login: string };
          state: string;
          body: string;
          submittedAt: string;
        }>;
      } = JSON.parse(raw);

      return data.reviews.map((r) => {
        let state: Review["state"];
        const s = r.state?.toUpperCase();
        if (s === "APPROVED") state = "approved";
        else if (s === "CHANGES_REQUESTED") state = "changes_requested";
        else if (s === "DISMISSED") state = "dismissed";
        else if (s === "PENDING") state = "pending";
        else state = "commented";

        return {
          author: r.author?.login ?? "unknown",
          state,
          body: r.body || undefined,
          submittedAt: parseDate(r.submittedAt),
        };
      });
    },

    async getReviewDecision(pr: PRInfo): Promise<ReviewDecision> {
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "reviewDecision",
      ]);
      const data: { reviewDecision: string } = JSON.parse(raw);

      const d = (data.reviewDecision ?? "").toUpperCase();
      if (d === "APPROVED") return "approved";
      if (d === "CHANGES_REQUESTED") return "changes_requested";
      if (d === "REVIEW_REQUIRED") return "pending";
      return "none";
    },

    async getPendingComments(pr: PRInfo): Promise<ReviewComment[]> {
      try {
        const raw = await gh([
          "api",
          `repos/${repoFlag(pr)}/pulls/${pr.number}/comments`,
        ]);

        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          in_reply_to_id?: number;
          created_at: string;
          html_url: string;
        }> = JSON.parse(raw);

        // Top-level comments only (not replies) that aren't from bots
        return comments
          .filter(
            (c) =>
              !c.in_reply_to_id && !BOT_AUTHORS.has(c.user?.login ?? ""),
          )
          .map((c) => ({
            id: String(c.id),
            author: c.user?.login ?? "unknown",
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? c.original_line ?? undefined,
            isResolved: false,
            createdAt: parseDate(c.created_at),
            url: c.html_url,
          }));
      } catch {
        return [];
      }
    },

    async getAutomatedComments(pr: PRInfo): Promise<AutomatedComment[]> {
      try {
        // Get review comments from bots
        const raw = await gh([
          "api",
          `repos/${repoFlag(pr)}/pulls/${pr.number}/comments`,
        ]);

        const comments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = JSON.parse(raw);

        // Also get reviews from bots (like cursor[bot] which leaves reviews)
        let botReviewComments: Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          original_line: number | null;
          created_at: string;
          html_url: string;
        }> = [];

        try {
          const reviewsRaw = await gh([
            "api",
            `repos/${repoFlag(pr)}/pulls/${pr.number}/reviews`,
          ]);
          const reviews: Array<{
            id: number;
            user: { login: string };
          }> = JSON.parse(reviewsRaw);

          // For each bot review, get the review comments
          for (const review of reviews) {
            if (!BOT_AUTHORS.has(review.user?.login ?? "")) continue;
            try {
              const reviewCommentsRaw = await gh([
                "api",
                `repos/${repoFlag(pr)}/pulls/${pr.number}/reviews/${review.id}/comments`,
              ]);
              const rc: typeof botReviewComments = JSON.parse(reviewCommentsRaw);
              botReviewComments = botReviewComments.concat(rc);
            } catch {
              // Skip if we can't fetch review comments
            }
          }
        } catch {
          // Skip if we can't fetch reviews
        }

        const allBotComments = [
          ...comments.filter((c) => BOT_AUTHORS.has(c.user?.login ?? "")),
          ...botReviewComments,
        ];

        // Deduplicate by id
        const seen = new Set<number>();
        const unique = allBotComments.filter((c) => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        });

        return unique.map((c) => {
          // Determine severity from body content
          let severity: AutomatedComment["severity"] = "info";
          const bodyLower = c.body.toLowerCase();
          if (
            bodyLower.includes("error") ||
            bodyLower.includes("bug") ||
            bodyLower.includes("critical") ||
            bodyLower.includes("potential issue")
          ) {
            severity = "error";
          } else if (
            bodyLower.includes("warning") ||
            bodyLower.includes("suggest") ||
            bodyLower.includes("consider")
          ) {
            severity = "warning";
          }

          return {
            id: String(c.id),
            botName: c.user?.login ?? "unknown",
            body: c.body,
            path: c.path || undefined,
            line: c.line ?? c.original_line ?? undefined,
            severity,
            createdAt: parseDate(c.created_at),
            url: c.html_url,
          };
        });
      } catch {
        return [];
      }
    },

    async getMergeability(pr: PRInfo): Promise<MergeReadiness> {
      const blockers: string[] = [];

      // Fetch PR details with merge state
      const raw = await gh([
        "pr",
        "view",
        String(pr.number),
        "--repo",
        repoFlag(pr),
        "--json",
        "mergeable,reviewDecision,mergeStateStatus,isDraft",
      ]);

      const data: {
        mergeable: string;
        reviewDecision: string;
        mergeStateStatus: string;
        isDraft: boolean;
      } = JSON.parse(raw);

      // CI
      const ciStatus = await this.getCISummary(pr);
      const ciPassing = ciStatus === "passing" || ciStatus === "none";
      if (!ciPassing) {
        blockers.push(`CI is ${ciStatus}`);
      }

      // Reviews
      const reviewDecision = (data.reviewDecision ?? "").toUpperCase();
      const approved = reviewDecision === "APPROVED";
      if (reviewDecision === "CHANGES_REQUESTED") {
        blockers.push("Changes requested in review");
      } else if (reviewDecision === "REVIEW_REQUIRED") {
        blockers.push("Review required");
      }

      // Conflicts
      const mergeable = (data.mergeable ?? "").toUpperCase();
      const noConflicts = mergeable !== "CONFLICTING";
      if (!noConflicts) {
        blockers.push("Merge conflicts");
      }

      // Draft
      if (data.isDraft) {
        blockers.push("PR is still a draft");
      }

      return {
        mergeable: blockers.length === 0,
        ciPassing,
        approved,
        noConflicts,
        blockers,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "github",
  slot: "scm" as const,
  description: "SCM plugin: GitHub PRs, CI checks, reviews, merge readiness",
  version: "0.1.0",
};

export function create(): SCM {
  return createGitHubSCM();
}

export default { manifest, create } satisfies PluginModule<SCM>;
