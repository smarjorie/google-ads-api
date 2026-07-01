import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { buildAuthUrl } from "@/lib/oauth";
import { saveOAuthState } from "@/lib/redis";

export async function GET(req: NextRequest) {
  const slug = req.nextUrl.searchParams.get("slug");
  if (!slug) {
    return NextResponse.json({ error: "Parâmetro 'slug' é obrigatório." }, { status: 400 });
  }

  const state = randomUUID();
  await saveOAuthState(state, slug);
  const url = buildAuthUrl(state);

  return NextResponse.redirect(url);
}
