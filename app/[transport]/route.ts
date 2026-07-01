import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { randomUUID } from "crypto";
import { buildAuthUrl } from "@/lib/oauth";
import { saveOAuthState, getClientToken, deleteClientToken } from "@/lib/redis";
import { getCustomerClient, listAccessibleCustomers, enums } from "@/lib/google-ads";

const clientSlug = z
  .string()
  .min(1)
  .describe(
    "Identificador único e estável do cliente (ex: 'loja-do-joao'). Use sempre o mesmo slug para o mesmo cliente em todas as chamadas."
  );

const customerId = z
  .string()
  .describe("ID da conta do Google Ads, 10 dígitos, sem hífens (ex: '1234567890').");

const refreshTokenParam = z
  .string()
  .optional()
  .describe(
    "Opcional. Só use se o servidor NÃO tiver um banco persistente configurado (Upstash Redis): cole aqui o refresh_token mostrado na página de sucesso após o login do cliente. Se o banco estiver configurado, não é necessário informar isso."
  );

function money(microAmount: number | string | null | undefined) {
  const v = Number(microAmount ?? 0) / 1_000_000;
  return v.toFixed(2);
}

function dateRange(days: number) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

const handler = createMcpHandler(
  (server) => {
    // ---------------------------------------------------------------------
    // CONEXÃO / OAUTH
    // ---------------------------------------------------------------------
    server.registerTool(
      "google_ads_connect",
      {
        title: "Conectar conta do Google Ads de um cliente",
        description:
          "Verifica se um cliente já autorizou acesso à conta Google Ads dele. Se ainda não, gera um link de login que deve ser enviado ao cliente para ele abrir no navegador e conceder acesso. Chame esta ferramenta ANTES de qualquer outra ação para um novo cliente, e sempre que outra ferramenta retornar erro de 'não conectado'. Se o servidor não tiver banco persistente, você pode passar refresh_token (copiado da página de sucesso do login) para registrar a conexão diretamente.",
        inputSchema: { client_slug: clientSlug, refresh_token: refreshTokenParam },
      },
      async ({ client_slug, refresh_token }) => {
        if (refresh_token) {
          const { saveClientToken } = await import("@/lib/redis");
          await saveClientToken(client_slug, {
            refreshToken: refresh_token,
            connectedAt: new Date().toISOString(),
          });
          return {
            content: [
              { type: "text", text: `✅ Cliente "${client_slug}" conectado manualmente com o refresh_token informado.` },
            ],
          };
        }

        const existing = await getClientToken(client_slug);
        if (existing) {
          return {
            content: [
              {
                type: "text",
                text:
                  `✅ O cliente "${client_slug}" já está conectado` +
                  (existing.email ? ` (conta: ${existing.email})` : "") +
                  ` desde ${new Date(existing.connectedAt).toLocaleString("pt-BR")}.\n` +
                  `Pode usar diretamente as demais ferramentas do Google Ads para essa conta.`,
              },
            ],
          };
        }

        const state = randomUUID();
        await saveOAuthState(state, client_slug);
        const url = buildAuthUrl(state);

        return {
          content: [
            {
              type: "text",
              text:
                `🔗 O cliente "${client_slug}" ainda não conectou a conta. Envie o link abaixo para ele abrir e fazer login com a conta Google que administra o Google Ads dele:\n\n${url}\n\n` +
                `Depois que ele autorizar, use novamente esta ferramenta (ou qualquer outra) para confirmar a conexão.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "google_ads_disconnect",
      {
        title: "Desconectar conta do Google Ads de um cliente",
        description: "Remove o acesso salvo de um cliente, forçando um novo login na próxima vez.",
        inputSchema: { client_slug: clientSlug },
      },
      async ({ client_slug }) => {
        await deleteClientToken(client_slug);
        return {
          content: [{ type: "text", text: `🔌 Cliente "${client_slug}" desconectado.` }],
        };
      }
    );

    server.registerTool(
      "google_ads_list_accounts",
      {
        title: "Listar contas do Google Ads",
        description:
          "Lista os customer IDs de Google Ads que a conta conectada do cliente consegue acessar.",
        inputSchema: { client_slug: clientSlug, refresh_token: refreshTokenParam },
      },
      async ({ client_slug, refresh_token }) => {
        const ids = await listAccessibleCustomers(client_slug, refresh_token);
        return {
          content: [
            {
              type: "text",
              text: ids.length
                ? `Contas acessíveis para "${client_slug}":\n${ids.map((id) => `- ${id}`).join("\n")}`
                : "Nenhuma conta acessível encontrada para esse login.",
            },
          ],
        };
      }
    );

    // ---------------------------------------------------------------------
    // LEITURA: CAMPANHAS E PERFORMANCE
    // ---------------------------------------------------------------------
    server.registerTool(
      "google_ads_list_campaigns",
      {
        title: "Listar campanhas",
        description: "Lista as campanhas de uma conta, com status, tipo e orçamento diário.",
        inputSchema: { client_slug: clientSlug, customer_id: customerId, refresh_token: refreshTokenParam },
      },
      async ({ client_slug, customer_id, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const rows = await customer.query(`
          SELECT campaign.id, campaign.name, campaign.status,
                 campaign.advertising_channel_type, campaign_budget.amount_micros
          FROM campaign
          ORDER BY campaign.id
        `);
        const text = rows
          .map(
            (r: any) =>
              `#${r.campaign.id} "${r.campaign.name}" — ${r.campaign.status} — ${r.campaign.advertising_channel_type} — orçamento: R$ ${money(r.campaign_budget?.amount_micros)}/dia`
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "Nenhuma campanha encontrada nessa conta." }] };
      }
    );

    server.registerTool(
      "google_ads_campaign_performance",
      {
        title: "Performance das campanhas",
        description:
          "Retorna métricas agregadas (impressões, cliques, CTR, custo, conversões) de todas as campanhas no período informado.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          days: z.number().int().min(1).max(90).default(7).describe("Janela de dias para o relatório (padrão 7)"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, days, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const { start, end } = dateRange(days);
        const rows = await customer.query(`
          SELECT campaign.name, campaign.status,
                 metrics.impressions, metrics.clicks, metrics.ctr,
                 metrics.cost_micros, metrics.conversions
          FROM campaign
          WHERE segments.date BETWEEN '${start}' AND '${end}'
          ORDER BY metrics.cost_micros DESC
        `);
        const text = rows
          .map((r: any) => {
            const m = r.metrics;
            return (
              `"${r.campaign.name}" (${r.campaign.status})\n` +
              `  impressões: ${m.impressions ?? 0} | cliques: ${m.clicks ?? 0} | CTR: ${(
                (m.ctr ?? 0) * 100
              ).toFixed(2)}%\n` +
              `  custo: R$ ${money(m.cost_micros)} | conversões: ${m.conversions ?? 0}`
            );
          })
          .join("\n\n");
        return {
          content: [
            {
              type: "text",
              text: text
                ? `Performance de ${start} a ${end}:\n\n${text}`
                : "Sem dados de performance nesse período.",
            },
          ],
        };
      }
    );

    // ---------------------------------------------------------------------
    // GESTÃO DE ORÇAMENTO E STATUS
    // ---------------------------------------------------------------------
    server.registerTool(
      "google_ads_update_campaign_status",
      {
        title: "Pausar / ativar / remover campanha",
        description: "Altera o status de uma campanha: ENABLED (ativa), PAUSED (pausada) ou REMOVED (removida).",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          campaign_id: z.string().describe("ID numérico da campanha"),
          status: z.enum(["ENABLED", "PAUSED", "REMOVED"]),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, status, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const resourceName = `customers/${customer_id.replace(/-/g, "")}/campaigns/${campaign_id}`;
        await customer.campaigns.update([
          { resource_name: resourceName, status: enums.CampaignStatus[status] },
        ]);
        return {
          content: [{ type: "text", text: `✅ Campanha ${campaign_id} atualizada para status ${status}.` }],
        };
      }
    );

    server.registerTool(
      "google_ads_update_campaign_budget",
      {
        title: "Atualizar orçamento diário de uma campanha",
        description: "Altera o orçamento diário (em reais/unidade da conta) de uma campanha.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          campaign_id: z.string().describe("ID numérico da campanha"),
          daily_budget: z.number().positive().describe("Novo orçamento diário, na moeda da conta (ex: 50.00)"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, daily_budget, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const rows = await customer.query(`
          SELECT campaign_budget.resource_name
          FROM campaign
          WHERE campaign.id = ${campaign_id}
          LIMIT 1
        `);
        if (!rows.length) {
          return { content: [{ type: "text", text: `❌ Campanha ${campaign_id} não encontrada.` }] };
        }
        const budgetResourceName = rows[0].campaign_budget?.resource_name;
        if (!budgetResourceName) {
          return {
            content: [{ type: "text", text: `❌ Não foi possível encontrar o orçamento da campanha ${campaign_id}.` }],
          };
        }
        await customer.campaignBudgets.update([
          { resource_name: budgetResourceName, amount_micros: Math.round(daily_budget * 1_000_000) },
        ]);
        return {
          content: [
            { type: "text", text: `✅ Orçamento da campanha ${campaign_id} atualizado para R$ ${daily_budget.toFixed(2)}/dia.` },
          ],
        };
      }
    );

    // ---------------------------------------------------------------------
    // CRIAÇÃO: CAMPANHA, GRUPO DE ANÚNCIOS, PALAVRAS-CHAVE
    // ---------------------------------------------------------------------
    server.registerTool(
      "google_ads_create_search_campaign",
      {
        title: "Criar campanha de pesquisa (Search)",
        description:
          "Cria uma nova campanha de Rede de Pesquisa com orçamento diário e estratégia de lance manual por CPC. A campanha é criada PAUSADA por segurança — ative com google_ads_update_campaign_status depois de revisar.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          name: z.string().describe("Nome da campanha"),
          daily_budget: z.number().positive().describe("Orçamento diário na moeda da conta (ex: 50.00)"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, name, daily_budget, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);

        const budgetResourceNames = await customer.campaignBudgets.create([
          {
            name: `${name} - orçamento`,
            amount_micros: Math.round(daily_budget * 1_000_000),
            delivery_method: enums.BudgetDeliveryMethod.STANDARD,
          },
        ]);

        const campaignResourceNames = await customer.campaigns.create([
          {
            name,
            campaign_budget: budgetResourceNames.results[0].resource_name,
            advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
            status: enums.CampaignStatus.PAUSED,
            manual_cpc: {},
            network_settings: {
              target_google_search: true,
              target_search_network: true,
              target_content_network: false,
              target_partner_search_network: false,
            },
          },
        ]);

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Campanha "${name}" criada como PAUSADA (${campaignResourceNames.results[0].resource_name}), ` +
                `orçamento R$ ${daily_budget.toFixed(2)}/dia. Crie um grupo de anúncios com google_ads_create_ad_group e ative quando estiver pronta.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "google_ads_create_ad_group",
      {
        title: "Criar grupo de anúncios",
        description: "Cria um grupo de anúncios dentro de uma campanha existente, com lance de CPC padrão.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          campaign_id: z.string().describe("ID numérico da campanha"),
          name: z.string().describe("Nome do grupo de anúncios"),
          default_cpc_bid: z.number().positive().describe("Lance de CPC padrão, na moeda da conta (ex: 1.50)"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, name, default_cpc_bid, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const campaignResourceName = `customers/${customer_id.replace(/-/g, "")}/campaigns/${campaign_id}`;

        const adGroupResourceNames = await customer.adGroups.create([
          {
            name,
            campaign: campaignResourceName,
            status: enums.AdGroupStatus.ENABLED,
            type: enums.AdGroupType.SEARCH_STANDARD,
            cpc_bid_micros: Math.round(default_cpc_bid * 1_000_000),
          },
        ]);

        return {
          content: [
            {
              type: "text",
              text: `✅ Grupo de anúncios "${name}" criado (${adGroupResourceNames.results[0].resource_name}). Agora adicione palavras-chave com google_ads_add_keywords.`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "google_ads_add_keywords",
      {
        title: "Adicionar palavras-chave",
        description: "Adiciona uma ou mais palavras-chave a um grupo de anúncios existente.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          ad_group_id: z.string().describe("ID numérico do grupo de anúncios"),
          keywords: z
            .array(
              z.object({
                text: z.string().describe("Texto da palavra-chave"),
                match_type: z.enum(["EXACT", "PHRASE", "BROAD"]).default("BROAD"),
                cpc_bid: z.number().positive().optional().describe("Lance de CPC específico (opcional)"),
              })
            )
            .min(1),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, ad_group_id, keywords, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const adGroupResourceName = `customers/${customer_id.replace(/-/g, "")}/adGroups/${ad_group_id}`;

        const operations = keywords.map((kw) => ({
          ad_group: adGroupResourceName,
          status: enums.AdGroupCriterionStatus.ENABLED,
          keyword: { text: kw.text, match_type: enums.KeywordMatchType[kw.match_type] },
          ...(kw.cpc_bid ? { cpc_bid_micros: Math.round(kw.cpc_bid * 1_000_000) } : {}),
        }));

        await customer.adGroupCriteria.create(operations);

        return {
          content: [
            {
              type: "text",
              text: `✅ ${keywords.length} palavra(s)-chave adicionada(s) ao grupo de anúncios ${ad_group_id}:\n${keywords
                .map((k) => `- "${k.text}" (${k.match_type})`)
                .join("\n")}`,
            },
          ],
        };
      }
    );

    server.registerTool(
      "google_ads_update_keyword_bid",
      {
        title: "Atualizar lance de uma palavra-chave",
        description: "Altera o lance de CPC de uma palavra-chave específica dentro de um grupo de anúncios.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          ad_group_id: z.string().describe("ID numérico do grupo de anúncios"),
          criterion_id: z.string().describe("ID do critério (palavra-chave) — obtido via google_ads_list_keywords"),
          cpc_bid: z.number().positive().describe("Novo lance de CPC na moeda da conta"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, ad_group_id, criterion_id, cpc_bid, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const resourceName = `customers/${customer_id.replace(/-/g, "")}/adGroupCriteria/${ad_group_id}~${criterion_id}`;

        await customer.adGroupCriteria.update([
          { resource_name: resourceName, cpc_bid_micros: Math.round(cpc_bid * 1_000_000) },
        ]);

        return {
          content: [{ type: "text", text: `✅ Lance atualizado para R$ ${cpc_bid.toFixed(2)}.` }],
        };
      }
    );

    server.registerTool(
      "google_ads_list_keywords",
      {
        title: "Listar palavras-chave de um grupo de anúncios",
        description: "Lista as palavras-chave, tipo de correspondência, status e lance de um grupo de anúncios.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          ad_group_id: z.string().describe("ID numérico do grupo de anúncios"),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, customer_id, ad_group_id, refresh_token }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token);
        const rows = await customer.query(`
          SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text,
                 ad_group_criterion.keyword.match_type, ad_group_criterion.status,
                 ad_group_criterion.cpc_bid_micros
          FROM ad_group_criterion
          WHERE ad_group_criterion.type = 'KEYWORD'
            AND ad_group.id = ${ad_group_id}
        `);
        const text = rows
          .map(
            (r: any) =>
              `#${r.ad_group_criterion.criterion_id} "${r.ad_group_criterion.keyword.text}" — ${r.ad_group_criterion.keyword.match_type} — ${r.ad_group_criterion.status} — lance: R$ ${money(r.ad_group_criterion.cpc_bid_micros)}`
          )
          .join("\n");
        return { content: [{ type: "text", text: text || "Nenhuma palavra-chave encontrada nesse grupo." }] };
      }
    );
  },
  {},
  { basePath: "", maxDuration: 300, verboseLogs: true }
);

export { handler as GET, handler as POST, handler as DELETE };
