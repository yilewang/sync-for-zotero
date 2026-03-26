import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/config";

export async function GET() {
  const cfg = loadConfig();
  return NextResponse.json({ config: cfg });
}
