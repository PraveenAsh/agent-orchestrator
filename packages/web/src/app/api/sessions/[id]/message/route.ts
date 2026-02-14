import { NextResponse, type NextRequest } from "next/server";
import { getServices } from "@/lib/services";
import type { Runtime } from "@agent-orchestrator/core";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { message } = await request.json() as { message: string };

    if (!message) {
      return NextResponse.json({ error: "Missing message" }, { status: 400 });
    }

    const { sessionManager, config, registry } = await getServices();
    const session = await sessionManager.get(id);

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (!session.runtimeHandle) {
      return NextResponse.json({ error: "Session has no runtime handle" }, { status: 400 });
    }

    // Get the runtime plugin for this session's project
    const project = config.projects[session.projectId];
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (!project.runtime) {
      return NextResponse.json({ error: "Project has no runtime configured" }, { status: 500 });
    }

    const runtime = registry.get<Runtime>("runtime", project.runtime);
    if (!runtime) {
      return NextResponse.json({ error: "Runtime plugin not found" }, { status: 500 });
    }

    try {
      // Use the Runtime plugin's sendMessage method which handles sanitization
      // and uses the correct runtime handle
      await runtime.sendMessage(session.runtimeHandle, message);
      return NextResponse.json({ success: true });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("Failed to send message:", errorMsg);
      return NextResponse.json(
        { error: `Failed to send message: ${errorMsg}` },
        { status: 500 },
      );
    }
  } catch (error) {
    console.error("Failed to send message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
