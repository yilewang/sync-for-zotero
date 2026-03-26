import { NextRequest, NextResponse } from "next/server";
import { state } from "@/lib/state";

export async function GET(req: NextRequest) {
  if (state.status === "pending") {
    state.status = "running";
    state.active_seq = state.query.seq;
    state.running_since = Date.now();
    
    return NextResponse.json({
      status: "pending",
      query: { ...state.query }
    });
  }

  return NextResponse.json({
    status: state.status,
    query: null
  });
}
