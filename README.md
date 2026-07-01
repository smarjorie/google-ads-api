# Google Ads MCP

Servidor MCP (Model Context Protocol) para gerenciar contas de **Google Ads dos seus clientes**, com fluxo de OAuth próprio: cada cliente faz login com a própria conta Google e concede acesso — você não precisa de conta MCC nem guarda a senha de ninguém.

Deploy pronto para **Vercel**, storage de tokens no **Upstash Redis**.

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

## Testando sem banco de dados (temporário)

Se você ainda não configurou o Upstash Redis, dá pra ver o login funcionando mesmo assim — só que de forma manual:

1. Faça o deploy normalmente na Vercel, **sem** definir `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`.
2. No seu agente, chame `google_ads_connect` com um `client_slug`. Você recebe o link de login.
3. Envie o link, o cliente loga e autoriza.
4. A página de sucesso mostra o `refresh_token` na tela (⚠️ trate como senha).
5. Copie esse valor e informe ao agente. Ele pode:
   - Chamar `google_ads_connect` de novo passando `client_slug` + `refresh_token` para "registrar" a conexão, **ou**
   - Já ir direto para qualquer outra ferramenta (`google_ads_list_campaigns`, etc.) passando `client_slug` + `refresh_token` no parâmetro opcional `refresh_token`.

**Importante:** sem o banco, essa conexão não persiste de forma confiável entre chamadas diferentes na Vercel (funções serverless não compartilham memória). Ou seja, você provavelmente vai precisar reinformar o `refresh_token` em cada nova sessão/conversa com o agente. Isso é só para validar que o fluxo de OAuth funciona ponta a ponta — para uso real com múltiplos clientes, configure o Upstash Redis (é grátis e leva ~2 minutos, ver Passo 3 abaixo).

## Passo 1 — Google Cloud: criar o OAuth Client

1. Acesse o [Google Cloud Console](https://console.cloud.google.com/) e crie (ou reutilize) um projeto.
2. Vá em **APIs e Serviços → Tela de consentimento OAuth**. Configure como "Externo", preencha nome do app, e-mail de suporte etc. Em "Escopos", adicione `https://www.googleapis.com/auth/adwords`.
   - Enquanto o app estiver em modo **Teste**, só e-mails que você adicionar como "usuários de teste" vão conseguir logar. Para liberar geral, publique o app (Google pode pedir verificação, já que o escopo do Ads é sensível).
3. Vá em **APIs e Serviços → Credenciais → Criar credenciais → ID do cliente OAuth**, tipo **"Aplicativo da Web"**.
4. Em **URIs de redirecionamento autorizados**, adicione (troque pelo seu domínio da Vercel depois do primeiro deploy):
   ```
   https://SEU-DOMINIO.vercel.app/api/auth/google/callback
   ```
5. Copie o **Client ID** e o **Client Secret**.

## Passo 2 — Google Ads: developer token

1. Você precisa de uma conta **Google Ads Manager (MCC)** própria para obter um **Developer Token**, mesmo gerenciando contas de clientes fora de uma estrutura MCC — o token identifica sua integração perante a API, não dá acesso às contas por si só.
2. Na conta MCC, vá em **Ferramentas e configurações → Configuração → Centro da API**, solicite o developer token.
3. Tokens novos começam em nível **Teste** (só funcionam com contas de teste do Google Ads). Para uso em produção com contas reais de clientes, solicite acesso **Básico** ou superior — a aprovação do Google pode levar alguns dias.

## Passo 3 — Upstash Redis (storage dos tokens)

1. Crie uma conta gratuita em [console.upstash.com](https://console.upstash.com).
2. Crie um banco Redis (região próxima da região do seu deploy na Vercel).
3. Copie `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`.

## Passo 4 — Deploy

```bash
# dentro da pasta do projeto
git init
git add .
git commit -m "Google Ads MCP"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/google-ads-mcp.git
git push -u origin main
```

Depois, na [Vercel](https://vercel.com/new), importe o repositório e configure as variáveis de ambiente (Project Settings → Environment Variables):

| Variável | Valor |
|---|---|
| `PUBLIC_BASE_URL` | `https://SEU-DOMINIO.vercel.app` (sem barra no final) |
| `GOOGLE_ADS_CLIENT_ID` | do Passo 1 |
| `GOOGLE_ADS_CLIENT_SECRET` | do Passo 1 |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | do Passo 2 |
| `UPSTASH_REDIS_REST_URL` | do Passo 3 |
| `UPSTASH_REDIS_REST_TOKEN` | do Passo 3 |
| `MCP_ACCESS_TOKEN` | uma string aleatória qualquer, ex: gerada com `openssl rand -hex 32` |

Depois do primeiro deploy, volte no Google Cloud Console e confirme que a URL de redirecionamento cadastrada bate exatamente com `https://SEU-DOMINIO.vercel.app/api/auth/google/callback`.

**Recomendado:** habilite **Fluid Compute** nas configurações do projeto na Vercel — melhora a performance de servidores MCP, que ficam boa parte do tempo ociosos esperando chamadas de ferramentas.

## Passo 5 — Adicionar no seu agente

O endpoint MCP fica em `https://SEU-DOMINIO.vercel.app/mcp` (streamable HTTP) ou `/sse` para clientes mais antigos.

Como o servidor está protegido por Bearer token (`MCP_ACCESS_TOKEN`), configure seu agente para enviar o header `Authorization: Bearer SEU_TOKEN`. Exemplo genérico de configuração (formato `mcpServers`, usado por Claude Code, Claude Desktop e outros):

```json
{
  "mcpServers": {
    "google-ads": {
      "type": "http",
      "url": "https://SEU-DOMINIO.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer SEU_TOKEN"
      }
    }
  }
}
```

Se o seu agente não suportar headers customizados, remova a variável `MCP_ACCESS_TOKEN` da Vercel (o servidor fica sem proteção — só recomendado para testes rápidos) ou me avise que ajustamos para autenticação via query string.

---

## Como funciona o login do cliente na prática

1. No seu agente, você chama a ferramenta `google_ads_connect` com um `client_slug` (um identificador que você escolhe, ex: `"loja-do-joao"`).
2. Se o cliente ainda não conectou, a ferramenta retorna um link. Envie esse link para o cliente (WhatsApp, e-mail etc.).
3. O cliente abre o link, faz login com a conta Google que administra o Google Ads dele, e autoriza o acesso.
4. A partir daí, use o mesmo `client_slug` em todas as outras ferramentas (`google_ads_list_campaigns`, etc.) para operar na conta desse cliente.
5. Um mesmo `client_slug` pode ter acesso a mais de uma conta Google Ads (ex: MCC próprio do cliente) — use `google_ads_list_accounts` para ver quais `customer_id` estão disponíveis.

## Limitações conhecidas / próximos passos

- Renovação de `refresh_token` expirado: se o cliente revogar o acesso pelo Google, as chamadas passam a falhar com erro de autenticação — trate isso reconectando (`google_ads_connect` de novo).
- O link gerado por `google_ads_connect` não expira automaticamente antes de ser usado (validade de 10 min) — depois disso, gere um novo.
- As ferramentas de criação cobrem o essencial (campanha Search, grupo de anúncios, palavras-chave, lances, orçamento). Para anúncios responsivos de pesquisa, públicos, extensões etc., me chame para irmos adicionando ferramentas — a estrutura já está pronta para isso, é só seguir o mesmo padrão em `app/[transport]/route.ts`.
- Todos os valores monetários assumem a moeda configurada na conta Google Ads do cliente.

## Rodar localmente

```bash
npm install
cp .env.example .env.local
# preencha o .env.local (use ngrok ou similar para PUBLIC_BASE_URL em testes de OAuth local)
npm run dev
```
