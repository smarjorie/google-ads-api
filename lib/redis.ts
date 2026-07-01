import { Redis } from "@upstash/redis";

export type ClientTokenRecord = {
  refreshToken: string;
  connectedAt: string;
  email?: string;
};

const hasUpstash = !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

// Cliente Redis (Upstash) — usado em produção (Vercel), onde cada chamada pode
// cair em uma instância serverless diferente.
export const redis = hasUpstash ? Redis.fromEnv() : null;

if (!hasUpstash) {
  console.warn(
    "[storage] UPSTASH_REDIS_REST_URL/TOKEN não configurados — usando storage em memória. " +
      "Isso é OK para testar localmente, mas NÃO persiste entre reinícios e NÃO funciona em produção na Vercel " +
      "(cada requisição pode cair em uma instância diferente)."
  );
}

// --------- Fallback em memória (apenas para desenvolvimento local) ---------
const memTokens = new Map<string, ClientTokenRecord>();
const memStates = new Map<string, { slug: string; expiresAt: number }>();

const tokenKey = (slug: string) => `gads:client:${slug}`;
const stateKey = (state: string) => `gads:oauth:state:${state}`;

/** Salva o refresh_token de um cliente, identificado por um "slug" (ex: "loja-do-joao"). */
export async function saveClientToken(slug: string, record: ClientTokenRecord) {
  if (redis) {
    await redis.set(tokenKey(slug), JSON.stringify(record));
  } else {
    memTokens.set(slug, record);
  }
}

/** Recupera o token salvo de um cliente. Retorna null se ele nunca autorizou. */
export async function getClientToken(slug: string): Promise<ClientTokenRecord | null> {
  if (redis) {
    const raw = await redis.get<string>(tokenKey(slug));
    if (!raw) return null;
    return typeof raw === "string" ? JSON.parse(raw) : (raw as unknown as ClientTokenRecord);
  }
  return memTokens.get(slug) ?? null;
}

/** Remove a conexão de um cliente (força novo login na próxima chamada). */
export async function deleteClientToken(slug: string) {
  if (redis) {
    await redis.del(tokenKey(slug));
  } else {
    memTokens.delete(slug);
  }
}

/** Guarda o "state" do OAuth por 10 minutos, para amarrar o callback ao slug correto (CSRF). */
export async function saveOAuthState(state: string, slug: string) {
  if (redis) {
    await redis.set(stateKey(state), slug, { ex: 600 });
  } else {
    memStates.set(state, { slug, expiresAt: Date.now() + 600_000 });
  }
}

/** Consome (lê e apaga) o state do OAuth durante o callback. */
export async function consumeOAuthState(state: string): Promise<string | null> {
  if (redis) {
    const slug = await redis.get<string>(stateKey(state));
    if (slug) await redis.del(stateKey(state));
    return slug;
  }
  const entry = memStates.get(state);
  memStates.delete(state);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.slug;
}
