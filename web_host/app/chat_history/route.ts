import { NextResponse } from "next/server";

export async function GET() {
  const history = (globalThis as any).mirroredHistory || [];
  return NextResponse.json({
    sessions: history.map((s: any) => ({
      id: s.id,
      title: s.title,
      chatUrl: s.chatUrl,
    })),
  });
}
