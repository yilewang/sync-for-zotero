import { NextRequest, NextResponse } from "next/server";

// Store scraped messages from the extension (latest load_chat scrape)
if (!(globalThis as any)._scrapedMessages) {
  (globalThis as any)._scrapedMessages = null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    (globalThis as any)._scrapedMessages = body.messages || [];
    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
