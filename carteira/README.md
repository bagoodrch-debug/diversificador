# Distribui Rico — Simulador de Alocação de Carteira

Site estático (HTML + CSS + JS puro, sem build) que reproduz o simulador de
alocação de carteira, pronto para publicar no GitHub Pages.

## Estrutura de pastas

```
carteira/
├── index.html                 # Página do simulador (home)
├── sobre.html
├── metodologia.html
├── sitemap.xml
├── robots.txt
├── README.md
│
├── .github/workflows/
│   └── atualizar-cotacoes.yml # Busca cotações periodicamente (Yahoo + Tesouro Direto via Brapi, sem token)
├── scripts/
│   └── atualizar-cotacoes.mjs # Script Node executado pelo workflow acima
├── dados/
│   └── cotacoes.json          # Gerado automaticamente — sem nenhuma credencial
├── cloudflare-worker/
│   └── cotacao-proxy.js       # Proxy de busca manual de ticker (Yahoo, sem token)
│
├── css/
│   ├── tokens.css
│   ├── base.css
│   ├── layout.css
│   ├── components.css
│   └── pages/
│       ├── home.css
│       └── content.css
│
├── js/
│   ├── core/        (dom.js, format.js, store.js)
│   ├── data/        (categorias.data.js, ativos.data.js)
│   ├── services/    (alocacao-service.js, api.js)
│   ├── components/  (toast.js, loading.js, skeleton.js, grafico-canvas.js, tabela-ativos.js)
│   └── pages/
│       └── simulador.page.js
│
└── assets/
    ├── icons/favicon.svg
    └── og/distribui-rico-og.png
```

## Sobre as fontes de dados — sem chave nem token

O site usa duas fontes gratuitas, nenhuma delas exige token ou chave secreta:

- **Ações, BDRs, FIIs, ETF de ouro e busca manual de ticker** — endpoint
  público (não-oficial) do Yahoo Finance.
- **Tesouro Direto** — endpoint sandbox público da Brapi, também sem token.

Isso significa que não existe nenhuma credencial pra guardar como Secret no
GitHub nem no Cloudflare. O workflow (`.github/workflows/atualizar-cotacoes.yml`)
e o Cloudflare Worker (`cloudflare-worker/cotacao-proxy.js`) funcionam com o
código como está, sem configuração extra de chave.

A única ressalva: o endpoint do Yahoo é não-oficial (o mesmo que o site deles
usa por trás dos panos) — não tem contrato nem SLA, e o Yahoo pode
mudar ou bloquear isso sem aviso. Por isso a atualização automática roda a
cada 30 minutos, não mais frequente, pra não parecer abuso de uso.

## Passo a passo para publicar

### 1. Criar o repositório
1. Crie um repositório novo no GitHub (ex: `carteira`), público ou privado
   (GitHub Pages funciona nos dois, mas privado exige plano pago para Pages).
2. Envie todos os arquivos desta pasta para a raiz do repositório.

### 2. Dar permissão de escrita para o workflow
1. Em **Settings → Actions → General → Workflow permissions**.
2. Selecione **Read and write permissions**.
3. Salve.
   (Isso permite que o workflow grave `dados/cotacoes.json` de volta no
   repositório.)

### 3. Ativar o GitHub Pages
1. Em **Settings → Pages**.
2. Em "Build and deployment", escolha **Deploy from a branch**.
3. Branch: `main` (ou `master`), pasta `/ (root)`.
4. Salve. O GitHub mostrará a URL pública (algo como
   `https://SEU-USUARIO.github.io/carteira/`).

### 4. Rodar o workflow pela primeira vez
1. Vá na aba **Actions** do repositório.
2. Clique no workflow **Atualizar cotações**.
3. Clique em **Run workflow** para rodar manualmente uma vez (não precisa
   esperar os 30 minutos).
4. Confira se ele terminou com sucesso (✔️) e se `dados/cotacoes.json` foi
   atualizado no repositório.

### 5. Ajustar URLs
Troque `SEU-USUARIO` pelo seu usuário/organização do GitHub nos arquivos:
- `index.html`, `sobre.html`, `metodologia.html` (tags `<link rel="canonical">` e `og:url`)
- `sitemap.xml`
- `robots.txt`

Pronto — o site estará no ar, atualizando cotações sozinho a cada 30 minutos,
sem nunca expor sua chave.

## Rodando localmente

Como o site usa ES Modules (`<script type="module">`) e `fetch` para ler o
JSON, ele precisa ser servido por um servidor HTTP (não funciona abrindo o
`index.html` direto com `file://`). Qualquer servidor estático simples
resolve, por exemplo:

```bash
cd carteira
python3 -m http.server 8080
# depois abra http://localhost:8080
```

## Limitações conhecidas

- As cotações têm até ~30 minutos de atraso (frequência do workflow), não são
  tempo real.
- A busca por ticker no formulário "Adicionar ativo" procura dentro da base
  já acompanhada pelo site (lista em `js/data/ativos.data.js` e
  `scripts/atualizar-cotacoes.mjs`). Para acompanhar mais tickers, adicione-os
  nas duas listas.
- Todo o estado do simulador (valor total, percentuais, ativos personalizados)
  fica só no `localStorage` do navegador de cada visitante — não há conta de
  usuário nem sincronização entre dispositivos.
