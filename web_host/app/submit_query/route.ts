import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";
import { createSession, addMessageToSession } from "@/lib/history";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    if (state.status === "pending" || state.status === "running") {
      if (state.status === "running" && Date.now() - state.running_since > 120000) {
        state.status = "error";
      } else {
        return NextResponse.json({ error: "pipeline_busy", status: state.status });
      }
    }

    // Auto-create a new session when a PDF is attached (new conversation)
    const isNewConversation = !!body.pdf_base64;
    if (isNewConversation || !state.activeSessionId) {
      const session = createSession(body.pdf_filename || null);
      state.activeSessionId = session.id;
    }

    // Save the user message to history
    if (state.activeSessionId) {
      addMessageToSession(state.activeSessionId, {
        speaker: "You",
        text: body.prompt || "",
        kind: "user",
      });
    }

    // Clear stale state from previous query to prevent cross-query contamination
    state.responses = [];
    state.active_seq = 0;  // force seq mismatch for any late-arriving partials
    state.partial_text = null;
    state.partial_thinking = null;

    state.query.seq += 1;
    state.query.prompt = body.prompt || "";
    state.query.pdf_base64 = body.pdf_base64 || null;
    state.query.pdf_filename = body.pdf_filename || null;
    (state.query as any).images = body.images || null;
    (state.query as any).chatgpt_mode = body.chatgpt_mode || null;

    state.status = "pending";

    return NextResponse.json({ ok: true, seq: state.query.seq, sessionId: state.activeSessionId });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

