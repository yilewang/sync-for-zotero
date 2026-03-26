import { NextRequest, NextResponse } from "next/server";
import { state, resetState } from "@/lib/state";
import { createSession } from "@/lib/history";

export async function POST(req: NextRequest) {
  try {
    // Reset pipeline state
    resetState();

    // Tell the extension to navigate to a fresh ChatGPT page
    state.pendingCommand = { type: "NEW_CHAT" };

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
