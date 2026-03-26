import { NextResponse } from "next/server";
import { state } from "@/lib/state";

export async function GET() {
  const cmd = state.pendingCommand;
  if (cmd) {
    state.pendingCommand = null;
    return NextResponse.json({ command: cmd });
  }
  return NextResponse.json({ command: null });
}
