import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const seq = body.seq;

    if (seq !== state.active_seq) {
      return NextResponse.json({ ok: false, reason: "seq_mismatch" });
    }

    if ("text" in body) {
      state.partial_text = body.text;
    }
    if ("thinking" in body) {
      state.partial_thinking = body.thinking;
    }

    return NextResponse.json({ ok: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
