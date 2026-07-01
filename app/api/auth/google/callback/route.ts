import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, fetchUserEmail } from "@/lib/oauth";
import { consumeOAuthState, saveClientToken } from "@/lib/redis";

function htmlPage(title: string, body: string) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 20px; line-height: 1.6; text-align: center; }
    h1 { font-size: 22px; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const error = req.nextUrl.searchParams.get("error");

  if (error) {
    return new NextResponse(
      htmlPage("Autorização cancelada", `<h1>❌ Autorização cancelada</h1><p>${error}</p>`),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  if (!code || !state) {
    return new NextResponse(
      htmlPage("Erro", "<h1>❌ Parâmetros ausentes na URL de retorno do Google.</h1>"),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  const slug = await consumeOAuthState(state);
  if (!slug) {
    return new NextResponse(
      htmlPage(
        "Link expirado",
        "<h1>⏰ Este link de autorização expirou ou já foi usado.</h1><p>Peça um novo link.</p>"
      ),
      { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens.refresh_token) {
      return new NextResponse(
        htmlPage(
          "Não foi possível concluir",
          "<h1>⚠️ O Google não retornou um refresh_token.</h1>" +
            "<p>Isso costuma acontecer quando essa conta Google já havia autorizado este app antes. " +
            "Revogue o acesso em <a href='https://myaccount.google.com/permissions' target='_blank'>myaccount.google.com/permissions</a> e tente novamente.</p>"
        ),
        { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const email = await fetchUserEmail(tokens.access_token);

    await saveClientToken(slug, {
      refreshToken: tokens.refresh_token,
      connectedAt: new Date().toISOString(),
      email,
    });

    return new NextResponse(
      htmlPage(
        "Conectado!",
        `<h1>✅ Conta conectada com sucesso!</h1>
         <p>${email ? `Conta Google: <strong>${email}</strong><br/>` : ""}
         Cliente: <strong>${slug}</strong></p>
         <div style="text-align:left;background:#f5f5f5;padding:14px;border-radius:8px;margin-top:20px;">
           <p style="margin:0 0 8px 0;"><strong>Chave de acesso (refresh_token):</strong></p>
           <code style="display:block;word-break:break-all;font-size:12px;">${tokens.refresh_token}</code>
         </div>
         <p style="font-size:13px;color:#a00;">⚠️ Trate esse valor como uma senha — ele dá acesso à conta Google Ads.
         Só é necessário copiá-lo e informá-lo manualmente ao seu agente (parâmetro <code>refresh_token</code>) se você ainda
         não configurou um banco persistente (Upstash Redis). Com o banco configurado, isso é automático e você pode ignorar este valor.</p>
         <p>Você já pode fechar esta janela.</p>`
      ),
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  } catch (err: any) {
    return new NextResponse(
      htmlPage("Erro", `<h1>❌ Erro ao concluir autorização</h1><p>${err.message}</p>`),
      { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}
