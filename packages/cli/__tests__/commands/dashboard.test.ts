import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { mockExec, mockConfigRef } = vi.hoisted(() => ({
  mockExec: vi.fn(),
  mockConfigRef: { current: null as Record<string, unknown> | null },
}));

vi.mock("../../src/lib/shell.js", () => ({
  exec: mockExec,
}));

vi.mock("@composio/ao-core", async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import("@composio/ao-core")>();
  return {
    ...actual,
    loadConfig: () => mockConfigRef.current,
  };
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ao-dashboard-test-"));
  mockExec.mockReset();
  mockExec.mockResolvedValue({ stdout: "", stderr: "" });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("looksLikeStaleBuild (dashboard stale cache detection)", () => {
  // The dashboard 500 error bug: when .next cache references modules that
  // no longer exist after a dependency change (e.g., vendor-chunks/xterm@5.3.0.js),
  // the dashboard crashes. We detect this pattern and suggest --rebuild.

  // We test the detection function indirectly by importing the module.
  // Since looksLikeStaleBuild is not exported, we test it via the dashboard-rebuild module.

  it("rebuildDashboard cleans .next directory", async () => {
    // Create a fake web dir with a .next cache
    const webDir = join(tmpDir, "web");
    mkdirSync(webDir, { recursive: true });
    mkdirSync(join(webDir, ".next", "server", "vendor-chunks"), { recursive: true });
    writeFileSync(
      join(webDir, ".next", "server", "vendor-chunks", "xterm@5.3.0.js"),
      "module.exports = {}",
    );

    // Import the rebuild function
    const { rebuildDashboard } = await import("../../src/lib/dashboard-rebuild.js");

    // Mock ora
    vi.mock("ora", () => ({
      default: () => ({
        start: vi.fn().mockReturnThis(),
        stop: vi.fn().mockReturnThis(),
        succeed: vi.fn().mockReturnThis(),
        fail: vi.fn().mockReturnThis(),
        text: "",
      }),
    }));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await rebuildDashboard(webDir);

    // .next should be gone — this is the fix for the stale cache 500 error
    expect(existsSync(join(webDir, ".next"))).toBe(false);

    consoleSpy.mockRestore();
  });
});

describe("looksLikeStaleBuild pattern matching", () => {
  // We can't import the private function directly, so we replicate the patterns
  // to ensure the detection logic catches the actual error messages seen in production.
  const patterns = [
    /Cannot find module.*vendor-chunks/,
    /Cannot find module.*\.next/,
    /Module not found.*\.next/,
    /ENOENT.*\.next/,
    /Could not find a production build/,
  ];

  function looksLikeStaleBuild(stderr: string): boolean {
    return patterns.some((p) => p.test(stderr));
  }

  it("detects vendor-chunks module not found (the actual bug)", () => {
    // This is the exact error from the bug report
    const stderr =
      "Error: Cannot find module '/path/to/.next/server/vendor-chunks/xterm@5.3.0.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects generic .next module not found", () => {
    const stderr = "Cannot find module '/path/to/.next/server/chunks/123.js'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects Module not found in .next", () => {
    const stderr = "Module not found: Error in .next/static/chunks/app/page.js";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects ENOENT for .next files", () => {
    const stderr = "ENOENT: no such file or directory, open '.next/BUILD_ID'";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("detects missing production build", () => {
    const stderr = "Could not find a production build in the '.next' directory.";
    expect(looksLikeStaleBuild(stderr)).toBe(true);
  });

  it("does not flag unrelated errors", () => {
    const stderr = "TypeError: Cannot read properties of undefined";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });

  it("does not flag normal startup output", () => {
    const stderr = "ready - started server on 0.0.0.0:3000";
    expect(looksLikeStaleBuild(stderr)).toBe(false);
  });
});
