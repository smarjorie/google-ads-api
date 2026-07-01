import { GoogleAdsApi, enums } from "google-ads-api";
import { getClientToken, saveClientToken } from "./redis";

export { enums };

export const googleAdsClient = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID!,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
});

class NotConnectedError extends Error {
  constructor(slug: string) {
    super(
      `O cliente "${slug}" ainda não conectou a conta do Google Ads (ou o storage não é persistente e o token se perdeu). ` +
        `Use a ferramenta google_ads_connect para gerar o link de autorização, ou passe o parâmetro refresh_token diretamente nesta chamada.`
    );
    this.name = "NotConnectedError";
  }
}

/**
 * Resolve o refresh_token de um cliente: usa o override explícito se informado
 * (útil enquanto não há storage persistente configurado), senão busca no storage salvo.
 */
async function resolveRefreshToken(slug: string, refreshTokenOverride?: string): Promise<string> {
  if (refreshTokenOverride) {
    // Aproveita e salva no storage disponível (memória local ou Redis, se configurado),
    // assim chamadas seguintes na mesma sessão não precisam repetir o token.
    await saveClientToken(slug, {
      refreshToken: refreshTokenOverride,
      connectedAt: new Date().toISOString(),
    }).catch(() => {});
    return refreshTokenOverride;
  }

  const record = await getClientToken(slug);
  if (!record) throw new NotConnectedError(slug);
  return record.refreshToken;
}

/** Retorna um Customer client (google-ads-api) autenticado com o refresh_token do cliente. */
export async function getCustomerClient(slug: string, customerId: string, refreshTokenOverride?: string) {
  const refreshToken = await resolveRefreshToken(slug, refreshTokenOverride);
  return googleAdsClient.Customer({
    customer_id: customerId.replace(/-/g, ""),
    refresh_token: refreshToken,
  });
}

/** Lista os customer IDs que o login do cliente consegue acessar. */
export async function listAccessibleCustomers(slug: string, refreshTokenOverride?: string): Promise<string[]> {
  const refreshToken = await resolveRefreshToken(slug, refreshTokenOverride);
  const res = await googleAdsClient.listAccessibleCustomers(refreshToken);
  return res.resource_names.map((rn: string) => rn.split("/")[1]);
}
