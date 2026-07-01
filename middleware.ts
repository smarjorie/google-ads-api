import { NextRequest, NextResponse } from "next/server";

// Protege /mcp e /sse com um Bearer token simples (MCP_ACCESS_TOKEN).
// Sem essa proteção, qualquer pessoa que descobrir a URL do seu deploy
// conseguiria gerenciar as contas de Google Ads dos seus clientes.
export function middleware(req: NextRequest) {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return NextResponse.next(); // nenhuma proteção configurada (não recomendado em produção)

  const auth = req.headers.get("authorization");
  if (auth === `Bearer ${token}`) return NextResponse.next();

  return new NextResponse("Unauthorized", { status: 401 });
}

export const config = {
  matcher: ["/mcp", "/sse"],
};
