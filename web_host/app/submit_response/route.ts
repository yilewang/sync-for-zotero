import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";
import { addMessageToSession } from "@/lib/history";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const seq = body.seq;

    if (seq !== state.active_seq) {
      return NextResponse.json({ ok: false, reason: "seq_mismatch" });
    }

    const entry = {
      seq: seq,
      text: body.response,
      error: body.error,
      timestamp: new Date().toISOString(),
      thinking: body.thinking
    };

    state.responses.push(entry);
    state.partial_text = null;
    state.partial_thinking = null;
    state.status = entry.error ? "error" : "done";

    // Save bot response to history
    if (state.activeSessionId) {
      if (entry.error) {
        addMessageToSession(state.activeSessionId, {
          speaker: "Error",
          text: entry.error,
          kind: "error",
        });
      } else {
        addMessageToSession(state.activeSessionId, {
          speaker: "ChatGPT",
          text: entry.text || "",
          kind: "bot",
          thinking: entry.thinking,
        });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}

