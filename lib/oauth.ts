const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

// Escopo necessário para gerenciar contas do Google Ads
const SCOPE = "https://www.googleapis.com/auth/adwords";

function getRedirectUri() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) throw new Error("Variável de ambiente PUBLIC_BASE_URL não configurada.");
  return `${base.replace(/\/$/, "")}/api/auth/google/callback`;
}

/** Monta a URL de consentimento do Google para o cliente autorizar acesso à conta Ads dele. */
export function buildAuthUrl(state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: SCOPE,
    access_type: "offline", // necessário para receber refresh_token
    prompt: "consent", // força reemissão do refresh_token mesmo se já autorizou antes
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type GoogleTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope: string;
  token_type: string;
};

/** Troca o "code" recebido no callback por um access_token + refresh_token. */
export async function exchangeCodeForTokens(code: string): Promise<GoogleTokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
      redirect_uri: getRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Falha ao trocar código por token: ${await res.text()}`);
  }
  return res.json();
}

/** Busca o e-mail da conta Google que autorizou, só para exibir na tela de sucesso. */
export async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const data = await res.json();
    return data.email;
  } catch {
    return undefined;
  }
}
