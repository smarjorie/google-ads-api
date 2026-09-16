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

/**
 * Retorna um Customer client (google-ads-api) autenticado com o refresh_token do cliente.
 *
 * loginCustomerId é o ID da conta MCC (gerenciadora) pela qual o login enxerga o customerId —
 * obrigatório sempre que customerId for uma sub-conta acessada através de uma MCC. Sem isso, a
 * API do Google Ads recusa a chamada como se a conta não existisse/não fosse acessível, mesmo
 * que o login tenha permissão (é o erro típico de "não consigo criar campanha" quando a conta é
 * gerenciada por uma MCC).
 */
export async function getCustomerClient(
  slug: string,
  customerId: string,
  refreshTokenOverride?: string,
  loginCustomerId?: string
) {
  const refreshToken = await resolveRefreshToken(slug, refreshTokenOverride);
  return googleAdsClient.Customer({
    customer_id: customerId.replace(/-/g, ""),
    refresh_token: refreshToken,
    ...(loginCustomerId ? { login_customer_id: loginCustomerId.replace(/-/g, "") } : {}),
  });
}

/**
 * Formata o erro retornado pela biblioteca google-ads-api de forma legível.
 *
 * Erros da Google Ads API não chegam como Error comuns — vêm como um objeto de falha
 * estruturado (GoogleAdsFailure) com uma lista em `.errors`, cada um com `error_code` e
 * `message`. Sem tratar isso explicitamente, o erro vira "[object Object]" quando
 * serializado, escondendo o motivo real da rejeição (orçamento, política, permissão, etc).
 */
export function formatGoogleAdsError(err: unknown): string {
  const anyErr = err as any;
  let summary: string | null = null;

  if (Array.isArray(anyErr?.errors) && anyErr.errors.length) {
    summary = anyErr.errors
      .map((e: any) => {
        const code = e?.error_code ? JSON.stringify(e.error_code) : null;
        const fieldPath = e?.location?.field_path_elements
          ?.map((el: any) => el?.field_name)
          .filter(Boolean)
          .join(".");
        return `${e?.message ?? "Erro sem mensagem"}${code ? ` (${code})` : ""}${
          fieldPath ? ` [campo: ${fieldPath}]` : ""
        }`;
      })
      .join(" | ");
  } else if (anyErr?.message && typeof anyErr.message === "string") {
    summary = anyErr.message;
  } else if (err instanceof Error) {
    summary = err.message;
  }

  let raw: string;
  try {
    raw = JSON.stringify(anyErr, Object.getOwnPropertyNames(anyErr ?? {}), 2);
  } catch {
    raw = String(err);
  }

  return summary ? `${summary}\n\nDetalhe bruto: ${raw}` : `Detalhe bruto: ${raw}`;
}

export type SubAccount = {
  id: string;
  name: string | null;
  isManager: boolean;
  status: string;
  level: number;
};

/**
 * Lista as sub-contas (clientes) visíveis a partir de uma conta gerenciadora (MCC).
 * listAccessibleCustomers só retorna as contas ligadas diretamente ao login — não desce na
 * hierarquia da MCC. Para achar o customer_id real de um cliente final, é preciso consultar
 * customer_client a partir da própria MCC, com login_customer_id = a própria MCC.
 */
export async function listSubAccounts(
  slug: string,
  managerCustomerId: string,
  refreshTokenOverride?: string
): Promise<SubAccount[]> {
  const refreshToken = await resolveRefreshToken(slug, refreshTokenOverride);
  const managerId = managerCustomerId.replace(/-/g, "");
  const manager = googleAdsClient.Customer({
    customer_id: managerId,
    login_customer_id: managerId,
    refresh_token: refreshToken,
  });

  const rows = await manager.query(`
    SELECT customer_client.id, customer_client.descriptive_name,
           customer_client.manager, customer_client.status, customer_client.level
    FROM customer_client
    WHERE customer_client.level <= 2
  `);

  return rows.map((r: any) => ({
    id: String(r.customer_client.id),
    name: r.customer_client.descriptive_name ?? null,
    isManager: !!r.customer_client.manager,
    status: r.customer_client.status,
    level: r.customer_client.level,
  }));
}

/** Lista os customer IDs que o login do cliente consegue acessar. */
export async function listAccessibleCustomers(slug: string, refreshTokenOverride?: string): Promise<string[]> {
  const refreshToken = await resolveRefreshToken(slug, refreshTokenOverride);
  const res = await googleAdsClient.listAccessibleCustomers(refreshToken);
  return res.resource_names.map((rn: string) => rn.split("/")[1]);
}
