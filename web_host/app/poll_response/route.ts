import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";

export async function GET(req: NextRequest) {
  // Passive timeout: if pipeline has been "running" for > 180s, auto-error
  if (
    state.status === "running" &&
    state.running_since > 0 &&
    Date.now() - state.running_since > 180_000
  ) {
    state.status = "error";
    state.responses.push({
      seq: state.active_seq,
      error: "Server-side timeout: pipeline running for > 180s",
      timestamp: new Date().toISOString(),
    });
  }

  const sinceMatch = req.nextUrl.searchParams.get("since");
  const since = parseInt(sinceMatch || "0", 10);

  const new_responses = state.responses.filter(r => r.seq > since);

  return NextResponse.json({
    status: state.status,
    responses: new_responses,
    partial_text: state.partial_text,
    partial_thinking: state.partial_thinking,
    current_seq: state.query.seq
  });
}
