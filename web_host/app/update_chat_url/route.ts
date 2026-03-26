import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";
import { updateSessionChatUrl } from "@/lib/history";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const chatUrl = body.chat_url;

    if (state.activeSessionId && chatUrl) {
      updateSessionChatUrl(state.activeSessionId, chatUrl);
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
