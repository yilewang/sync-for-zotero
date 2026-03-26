import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadConfig } from "@/lib/config";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const cfg = loadConfig();
    const output_folder = cfg.output_folder;

    if (!fs.existsSync(output_folder)) {
      fs.mkdirSync(output_folder, { recursive: true });
    }

    const sourceFilename = body.source_filename || "output";
    const content = body.content || "";

    const stem = path.basename(sourceFilename, path.extname(sourceFilename)).replace(/[^\w\-]/g, "_");
    
    // Format: YYYYMMDD_HHMMSS
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    const out_path = path.join(output_folder, `${stem}_${timestamp}.md`);
    fs.writeFileSync(out_path, content, "utf-8");

    return NextResponse.json({ saved_to: out_path });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
