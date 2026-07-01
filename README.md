# Google Ads MCP

Servidor MCP (Model Context Protocol) para gerenciar contas de **Google Ads dos seus clientes**, com fluxo de OAuth próprio: cada cliente faz login com a própria conta Google e concede acesso

## O que ele faz

- `google_ads_connect` — gera um link de login para um cliente conectar a conta dele
- `google_ads_disconnect` — revoga a conexão salva
- `google_ads_list_accounts` — lista as contas Google Ads acessíveis pelo login do cliente
- `google_ads_list_campaigns` / `google_ads_campaign_performance` — leitura de campanhas e métricas
- `google_ads_update_campaign_status` / `google_ads_update_campaign_budget` — pausar, ativar, remover, mudar orçamento
- `google_ads_create_search_campaign` / `google_ads_create_ad_group` — criação de campanha e grupo de anúncios
- `google_ads_add_keywords` / `google_ads_update_keyword_bid` / `google_ads_list_keywords` — gestão de palavras-chave e lances

Campanhas criadas por `google_ads_create_search_campaign` nascem **pausadas** por segurança — revise antes de ativar.

---
