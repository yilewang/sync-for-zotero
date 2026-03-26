import { NextResponse } from "next/server";
import { AppState, PendingCommand } from "@/lib/state";

export async function POST(req: Request) {
  try {
    const { chatId } = await req.json();
    if (!chatId) return NextResponse.json({ error: "Missing chatId" }, { status: 400 });

    const pending = (globalThis as any).pendingCommand as PendingCommand | null;
    if (pending) {
      return NextResponse.json({ error: "Another command is pending" }, { status: 409 });
    }

    (globalThis as any).pendingCommand = {
      type: "DELETE_CHAT",
      chatId,
    };

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
