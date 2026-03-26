import { NextRequest, NextResponse } from "next/server";
import { loadConfig, saveConfig } from "@/lib/config";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = loadConfig();
    
    Object.assign(cfg, body.values || {});
    saveConfig(cfg);

    return NextResponse.json({ config: cfg });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
