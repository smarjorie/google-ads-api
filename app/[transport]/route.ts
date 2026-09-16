import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { randomUUID } from "crypto";
import { buildAuthUrl } from "@/lib/oauth";
import { saveOAuthState, getClientToken, deleteClientToken } from "@/lib/redis";
import { getCustomerClient, listAccessibleCustomers, listSubAccounts, formatGoogleAdsError, enums } from "@/lib/google-ads";

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

const loginCustomerIdParam = z
  .string()
  .optional()
  .describe(
    "Opcional. ID da conta MCC (gerenciadora), 10 dígitos sem hífens, pela qual essa customer_id é acessada. " +
      "Obrigatório quando a conta em customer_id é uma sub-conta de uma MCC — sem isso a API rejeita a chamada " +
      "como se a conta não fosse acessível. Use google_ads_list_sub_accounts para descobrir o customer_id correto " +
      "a partir da MCC."
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

    server.registerTool(
      "google_ads_list_sub_accounts",
      {
        title: "Listar sub-contas de uma MCC",
        description:
          "Lista as sub-contas (clientes) visíveis a partir de uma conta gerenciadora (MCC). Use quando " +
          "google_ads_list_accounts só mostrar a MCC e não as contas dos clientes finais — é necessário " +
          "para achar o customer_id certo antes de criar campanhas. O customer_id retornado deve ser usado junto " +
          "com login_customer_id = ID desta MCC nas demais ferramentas.",
        inputSchema: {
          client_slug: clientSlug,
          manager_customer_id: customerId.describe("ID da conta MCC (gerenciadora), 10 dígitos sem hífens."),
          refresh_token: refreshTokenParam,
        },
      },
      async ({ client_slug, manager_customer_id, refresh_token }) => {
        const subAccounts = await listSubAccounts(client_slug, manager_customer_id, refresh_token);
        const clients = subAccounts.filter((a) => !a.isManager);
        const text = clients.length
          ? clients
              .map((a) => `- ${a.id} "${a.name ?? "(sem nome)"}" — ${a.status}`)
              .join("\n")
          : "Nenhuma sub-conta de cliente encontrada nessa MCC.";
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-contas de ${manager_customer_id}:\n${text}\n\n` +
                `Para criar/gerenciar campanhas nessas contas, passe customer_id = o ID listado acima e ` +
                `login_customer_id = ${manager_customer_id}.`,
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
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, status, refresh_token, login_customer_id }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
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
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, daily_budget, refresh_token, login_customer_id }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
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
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, name, daily_budget, refresh_token, login_customer_id }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);

          const budgetResourceNames = await customer.campaignBudgets.create([
            {
              name: `${name} - orçamento`,
              amount_micros: Math.round(daily_budget * 1_000_000),
              delivery_method: enums.BudgetDeliveryMethod.STANDARD,
              explicitly_shared: false,
            },
          ]);

          const campaignResourceNames = await customer.campaigns.create([
            {
              name,
              campaign_budget: budgetResourceNames.results[0].resource_name,
              advertising_channel_type: enums.AdvertisingChannelType.SEARCH,
              status: enums.CampaignStatus.PAUSED,
              // Obrigatório desde a atualização de conformidade com anúncios políticos da UE:
              // toda campanha nova precisa declarar se contém esse tipo de anúncio.
              contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
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
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Erro ao criar a campanha "${name}": ${formatGoogleAdsError(err)}` }],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "google_ads_create_display_campaign",
      {
        title: "Criar campanha de Display",
        description:
          "Cria uma nova campanha de Display (Rede de Display do Google) com orçamento diário e estratégia de lance manual por CPC. Criada PAUSADA por segurança.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          name: z.string().describe("Nome da campanha"),
          daily_budget: z.number().positive().describe("Orçamento diário na moeda da conta (ex: 50.00)"),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, name, daily_budget, refresh_token, login_customer_id }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);

          const budgetResourceNames = await customer.campaignBudgets.create([
            {
              name: `${name} - orçamento`,
              amount_micros: Math.round(daily_budget * 1_000_000),
              delivery_method: enums.BudgetDeliveryMethod.STANDARD,
              explicitly_shared: false,
            },
          ]);

          const campaignResourceNames = await customer.campaigns.create([
            {
              name,
              campaign_budget: budgetResourceNames.results[0].resource_name,
              advertising_channel_type: enums.AdvertisingChannelType.DISPLAY,
              status: enums.CampaignStatus.PAUSED,
              contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
              manual_cpc: {},
            },
          ]);

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ Campanha de Display "${name}" criada como PAUSADA (${campaignResourceNames.results[0].resource_name}), ` +
                  `orçamento R$ ${daily_budget.toFixed(2)}/dia. Crie um grupo de anúncios e os anúncios de display (imagem/responsivo) antes de ativar.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              { type: "text", text: `❌ Erro ao criar a campanha de Display "${name}": ${formatGoogleAdsError(err)}` },
            ],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "google_ads_create_performance_max_campaign",
      {
        title: "Criar campanha Performance Max",
        description:
          "Cria o ESQUELETO de uma campanha Performance Max (orçamento + campanha, com lance 'Maximizar conversões'), criada PAUSADA. " +
          "IMPORTANTE: uma campanha PMax só veicula anúncios depois de ter pelo menos um 'asset group' (grupo de recursos: títulos, " +
          "descrições, imagens, logo, URL final). Essa ferramenta NÃO cria o asset group — isso ainda precisa ser feito no Google Ads " +
          "Manager antes de ativar a campanha.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          name: z.string().describe("Nome da campanha"),
          daily_budget: z.number().positive().describe("Orçamento diário na moeda da conta (ex: 50.00)"),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, name, daily_budget, refresh_token, login_customer_id }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);

          const budgetResourceNames = await customer.campaignBudgets.create([
            {
              name: `${name} - orçamento`,
              amount_micros: Math.round(daily_budget * 1_000_000),
              delivery_method: enums.BudgetDeliveryMethod.STANDARD,
              explicitly_shared: false,
            },
          ]);

          const campaignResourceNames = await customer.campaigns.create([
            {
              name,
              campaign_budget: budgetResourceNames.results[0].resource_name,
              advertising_channel_type: enums.AdvertisingChannelType.PERFORMANCE_MAX,
              status: enums.CampaignStatus.PAUSED,
              contains_eu_political_advertising: enums.EuPoliticalAdvertisingStatus.DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING,
              maximize_conversions: {},
            },
          ]);

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ Campanha Performance Max "${name}" criada como PAUSADA (${campaignResourceNames.results[0].resource_name}), ` +
                  `orçamento R$ ${daily_budget.toFixed(2)}/dia.\n\n` +
                  `⚠️ Ainda NÃO vai veicular: falta adicionar o asset group (títulos, descrições, imagens, logo, URL final) no ` +
                  `Google Ads Manager antes de ativar.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: `❌ Erro ao criar a campanha Performance Max "${name}": ${formatGoogleAdsError(err)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "google_ads_add_sitelinks",
      {
        title: "Adicionar sitelinks (extensão)",
        description:
          "Cria links de site (sitelinks) e os associa a uma campanha, para aparecerem como extensão nos anúncios dela.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          campaign_id: z.string().describe("ID numérico da campanha"),
          sitelinks: z
            .array(
              z.object({
                link_text: z.string().max(25).describe("Texto do link (até 25 caracteres)"),
                final_url: z.string().url().describe("URL de destino do sitelink"),
                description1: z.string().max(35).optional().describe("Primeira linha de descrição (até 35 caracteres)"),
                description2: z.string().max(35).optional().describe("Segunda linha de descrição (até 35 caracteres)"),
              })
            )
            .min(1)
            .max(20),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, sitelinks, refresh_token, login_customer_id }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
          const campaignResourceName = `customers/${customer_id.replace(/-/g, "")}/campaigns/${campaign_id}`;

          const assetResults = await customer.assets.create(
            sitelinks.map((sl) => ({
              type: enums.AssetType.SITELINK,
              final_urls: [sl.final_url],
              sitelink_asset: {
                link_text: sl.link_text,
                ...(sl.description1 ? { description1: sl.description1 } : {}),
                ...(sl.description2 ? { description2: sl.description2 } : {}),
              },
            }))
          );

          await customer.campaignAssets.create(
            assetResults.results.map((r) => ({
              campaign: campaignResourceName,
              asset: r.resource_name,
              field_type: enums.AssetFieldType.SITELINK,
            }))
          );

          return {
            content: [
              {
                type: "text",
                text: `✅ ${sitelinks.length} sitelink(s) criado(s) e associado(s) à campanha ${campaign_id}:\n${sitelinks
                  .map((s) => `- "${s.link_text}" → ${s.final_url}`)
                  .join("\n")}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Erro ao adicionar sitelinks: ${formatGoogleAdsError(err)}` }],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "google_ads_add_callouts",
      {
        title: "Adicionar callouts (extensão)",
        description: "Cria frases de destaque (callouts) e as associa a uma campanha, como extensão dos anúncios dela.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          campaign_id: z.string().describe("ID numérico da campanha"),
          callouts: z.array(z.string().max(25)).min(1).max(20).describe("Textos dos callouts (até 25 caracteres cada)"),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, callouts, refresh_token, login_customer_id }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
          const campaignResourceName = `customers/${customer_id.replace(/-/g, "")}/campaigns/${campaign_id}`;

          const assetResults = await customer.assets.create(
            callouts.map((text) => ({
              type: enums.AssetType.CALLOUT,
              callout_asset: { callout_text: text },
            }))
          );

          await customer.campaignAssets.create(
            assetResults.results.map((r) => ({
              campaign: campaignResourceName,
              asset: r.resource_name,
              field_type: enums.AssetFieldType.CALLOUT,
            }))
          );

          return {
            content: [
              {
                type: "text",
                text: `✅ ${callouts.length} callout(s) criado(s) e associado(s) à campanha ${campaign_id}: ${callouts
                  .map((c) => `"${c}"`)
                  .join(", ")}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Erro ao adicionar callouts: ${formatGoogleAdsError(err)}` }],
            isError: true,
          };
        }
      }
    );

    server.registerTool(
      "google_ads_create_conversion_action",
      {
        title: "Criar ação de conversão (meta)",
        description:
          "Cria uma ação de conversão (meta) baseada em página web — por exemplo, 'Envio de formulário' ou 'Compra'. " +
          "Depois de criada, é preciso instalar a tag/snippet de conversão gerada pelo Google Ads no site (isso não é feito por " +
          "essa ferramenta) para a conversão começar a ser registrada de verdade.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          name: z.string().describe("Nome da ação de conversão (ex: 'Envio de formulário')"),
          category: z
            .enum([
              "DEFAULT",
              "PAGE_VIEW",
              "PURCHASE",
              "SIGNUP",
              "DOWNLOAD",
              "ADD_TO_CART",
              "BEGIN_CHECKOUT",
              "SUBMIT_LEAD_FORM",
              "CONTACT",
              "ENGAGEMENT",
            ])
            .default("DEFAULT")
            .describe("Categoria da conversão"),
          counting_type: z
            .enum(["ONE_PER_CLICK", "MANY_PER_CLICK"])
            .default("ONE_PER_CLICK")
            .describe("Contar uma conversão por clique ou várias"),
          default_value: z.number().nonnegative().optional().describe("Valor padrão da conversão (opcional)"),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({
        client_slug,
        customer_id,
        name,
        category,
        counting_type,
        default_value,
        refresh_token,
        login_customer_id,
      }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);

          const result = await customer.conversionActions.create([
            {
              name,
              type: enums.ConversionActionType.WEBPAGE,
              category: enums.ConversionActionCategory[category],
              status: enums.ConversionActionStatus.ENABLED,
              counting_type: enums.ConversionActionCountingType[counting_type],
              ...(default_value !== undefined
                ? { value_settings: { default_value, always_use_default_value: true } }
                : {}),
            },
          ]);

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ Ação de conversão "${name}" criada (${result.results[0].resource_name}).\n` +
                  `Próximo passo: instale a tag de conversão no site (Google Ads Manager → Metas → Conversões → "${name}" → Ver tag) ` +
                  `pra ela começar a registrar conversões de verdade.`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Erro ao criar a ação de conversão "${name}": ${formatGoogleAdsError(err)}` }],
            isError: true,
          };
        }
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
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, campaign_id, name, default_cpc_bid, refresh_token, login_customer_id }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
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
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({ client_slug, customer_id, ad_group_id, keywords, refresh_token, login_customer_id }) => {
        const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
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
      "google_ads_create_responsive_search_ad",
      {
        title: "Criar anúncio de pesquisa responsivo (RSA)",
        description:
          "Cria um Responsive Search Ad (RSA) dentro de um grupo de anúncios existente, com múltiplos títulos e " +
          "descrições que o Google Ads combina automaticamente.",
        inputSchema: {
          client_slug: clientSlug,
          customer_id: customerId,
          ad_group_id: z.string().describe("ID numérico do grupo de anúncios"),
          headlines: z
            .array(z.string().max(30, "Cada título tem no máximo 30 caracteres"))
            .min(3, "Mínimo de 3 títulos")
            .max(15, "Máximo de 15 títulos"),
          descriptions: z
            .array(z.string().max(90, "Cada descrição tem no máximo 90 caracteres"))
            .min(2, "Mínimo de 2 descrições")
            .max(4, "Máximo de 4 descrições"),
          final_urls: z.array(z.string().url()).min(1).describe("URL(s) de destino do anúncio"),
          path1: z.string().max(15).optional().describe("Primeiro trecho da URL exibida (opcional)"),
          path2: z.string().max(15).optional().describe("Segundo trecho da URL exibida (opcional, requer path1)"),
          status: z.enum(["ENABLED", "PAUSED"]).default("PAUSED"),
          refresh_token: refreshTokenParam,
          login_customer_id: loginCustomerIdParam,
        },
      },
      async ({
        client_slug,
        customer_id,
        ad_group_id,
        headlines,
        descriptions,
        final_urls,
        path1,
        path2,
        status,
        refresh_token,
        login_customer_id,
      }) => {
        try {
          const customer = await getCustomerClient(client_slug, customer_id, refresh_token, login_customer_id);
          const adGroupResourceName = `customers/${customer_id.replace(/-/g, "")}/adGroups/${ad_group_id}`;

          const result = await customer.adGroupAds.create([
            {
              ad_group: adGroupResourceName,
              status: enums.AdGroupAdStatus[status],
              ad: {
                final_urls,
                responsive_search_ad: {
                  headlines: headlines.map((text) => ({ text })),
                  descriptions: descriptions.map((text) => ({ text })),
                  ...(path1 ? { path1 } : {}),
                  ...(path2 ? { path2 } : {}),
                },
              },
            },
          ]);

          return {
            content: [
              {
                type: "text",
                text:
                  `✅ RSA criado (${result.results[0].resource_name}) no grupo de anúncios ${ad_group_id}, status ${status}.\n` +
                  `Títulos: ${headlines.length} | Descrições: ${descriptions.length}`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [{ type: "text", text: `❌ Erro ao criar o RSA: ${formatGoogleAdsError(err)}` }],
            isError: true,
          };
        }
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
