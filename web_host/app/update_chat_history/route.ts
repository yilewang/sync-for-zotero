import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const { sessions } = await req.json();
    if (Array.isArray(sessions)) {
      (globalThis as any).mirroredHistory = sessions;
    }
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
