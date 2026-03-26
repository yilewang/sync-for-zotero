import { NextRequest, NextResponse } from "next/server";
import { state, resetState } from "@/lib/state";
import { getSession } from "@/lib/history";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const sessionId = body.sessionId;

    let session = getSession(sessionId);
    
    // If not found in local history.json, check if it's a scraped mirrored history session
    if (!session) {
      const mirroredHistory = (globalThis as any).mirroredHistory || [];
      const mirroredSession = mirroredHistory.find((s: any) => s.id === sessionId);
      
      if (mirroredSession) {
        session = {
          id: mirroredSession.id,
          title: mirroredSession.title,
          chatUrl: mirroredSession.chatUrl,
          messages: [], // We don't have local messages for native ChatGPT sessions
        } as any;
      } else {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
    }

    // Reset pipeline state  
    resetState();

    // Set active session
    state.activeSessionId = sessionId;

    // If the session has a ChatGPT URL, tell extension to navigate there
    if (session!.chatUrl) {
      state.pendingCommand = { type: "LOAD_CHAT", chatUrl: session!.chatUrl };
    }

    return NextResponse.json({
      ok: true,
      session: {
        id: session!.id,
        title: session!.title,
        pdfFilename: session!.pdfFilename,
        chatUrl: session!.chatUrl,
        messages: session!.messages || [],
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
