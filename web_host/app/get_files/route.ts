import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { loadConfig } from "@/lib/config";

export async function GET() {
  try {
    const cfg = loadConfig();
    const pdf_folder = cfg.pdf_folder;
    const prompt_file = cfg.prompt_file;

    if (!fs.existsSync(pdf_folder)) {
      return NextResponse.json({ error: `No PDF files found in: ${pdf_folder}` });
    }

    const all_files = fs.readdirSync(pdf_folder);
    const pdfs = all_files
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => {
        const fullPath = path.join(pdf_folder, f);
        return {
          name: f,
          fullPath,
          stat: fs.statSync(fullPath),
        };
      })
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);

    if (pdfs.length === 0) {
      return NextResponse.json({ error: `No PDF files found in: ${pdf_folder}` });
    }

    if (!fs.existsSync(prompt_file)) {
      return NextResponse.json({ error: `prompt.txt not found at: ${prompt_file}` });
    }

    const prompt_text = fs.readFileSync(prompt_file, "utf-8").trim();
    if (!prompt_text) {
      return NextResponse.json({ error: "prompt.txt is empty" });
    }

    const pdfBase64 = fs.readFileSync(pdfs[0].fullPath).toString("base64");

    return NextResponse.json({
      pdf_base64: pdfBase64,
      pdf_filename: pdfs[0].name,
      prompt: prompt_text,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
