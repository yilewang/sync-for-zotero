import { NextResponse } from "next/server";

export async function GET() {
  const messages = (globalThis as any)._scrapedMessages || null;
  // Clear after reading (one-shot)
  (globalThis as any)._scrapedMessages = null;
  return NextResponse.json({ messages });
}
