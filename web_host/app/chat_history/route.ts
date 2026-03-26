import { NextRequest, NextResponse } from "next/server";

// Scraped messages storage (from extension DOM scraping)
if (!(globalThis as any)._scrapedMessages) {
  (globalThis as any)._scrapedMessages = null;
}

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action");

  // GET /chat_history?action=get_scraped → return scraped messages (one-shot)
  if (action === "get_scraped") {
    const messages = (globalThis as any)._scrapedMessages;
    (globalThis as any)._scrapedMessages = null;
    return NextResponse.json({ messages });
  }

  // GET /chat_history → return mirrored history from ChatGPT sidebar
  const history = (globalThis as any).mirroredHistory || [];
  return NextResponse.json({
    sessions: history.map((s: any) => ({
      id: s.id,
      title: s.title,
      chatUrl: s.chatUrl,
    })),
  });
}

// POST /chat_history → store scraped messages from extension
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    if (body.action === "submit_scraped") {
      (globalThis as any)._scrapedMessages = body.messages || [];
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
