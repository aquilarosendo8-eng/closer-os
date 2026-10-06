# Closer OS

CRM para closers high ticket, com interface em português e dados de demonstração.

## Executar

Requer Node.js 22.12+ (validado com Node.js 24) e npm.

```bash
npm ci
npm run dev
```

## Publicar

**Vercel:** importe o repositório `aquilarosendo8-eng/closer-os`, selecione a branch `main` e mantenha a pasta raiz do projeto. O `vercel.json` configura Vite, instalação com `npm ci`, build com `npm run build` e saída em `dist`. Após o deploy, a Vercel fornece o link público; novos commits na `main` atualizam o site.

**GitHub Pages:** gere o site com `npm run build -- --base=./` e publique o conteúdo de `dist` na branch `gh-pages`, com `index.html` na raiz e um arquivo vazio `.nojekyll`. Em **Settings → Pages**, selecione **Deploy from a branch → gh-pages → /(root) → Save**. Após o deploy, o endereço é `https://aquilarosendo8-eng.github.io/closer-os/`.

Os leads pertencem ao navegador e ao endereço usado. Ao mudar de domínio, exporte um backup em **Configurações** e importe no novo endereço.

## Recursos

- **Dashboard:** faturamento, calls realizadas, taxas de comparecimento e fechamento, ticket médio, meta e comissão projetada. Gráficos mensais de receita, fechamento e qualificados versus fechados.
- **Pipeline:** sete etapas, movimentação por arrastar ou seletor, busca e filtro por origem. Leads abertos com mais de cinco dias desde o último contato são destacados em vermelho.
- **Calls:** agenda e histórico, comparecimento, nota de 0 a 10, erros, objeções, dor, urgência, capacidade financeira e decisor.
- **Performance:** evolução semanal das notas, erros recorrentes, objeções e conversão por origem e urgência.
- **Dados:** persistência local, exportação CSV, backup JSON e importação de leads sem substituir registros existentes. As configurações permitem remover somente a demonstração.

Ao fechar um lead, informe o valor fechado. Receita, ticket médio, comissão e gráficos são recalculados automaticamente. A receita é atribuída à data de fechamento. O show rate exclui calls pendentes; o close rate considera vendas fechadas sobre comparecimentos. A central de ajuda explica os denominadores.

A leitura assistida de resumos é uma análise local por regras, com sugestões editáveis. Não chama um serviço de IA nem exige uma chave.

## Validação

```bash
npm test
npm run build
npm run test:e2e
```

Os testes de navegador usam Chromium. Neste ambiente ele está em `/usr/bin/chromium`. Em outras máquinas, defina `CHROMIUM_PATH` para uma instalação compatível ou instale o browser do Playwright com `npx playwright install chromium`; sem `CHROMIUM_PATH` e sem o Chromium do sistema, o runner usa a instalação do Playwright. O servidor de teste é iniciado automaticamente quando necessário.

## Armazenamento e limites

Esta versão funciona sem backend: os dados ficam no `localStorage` do navegador e não são sincronizados entre dispositivos ou usuários. Faça backups antes de limpar o navegador. A importação aceita backups completos da versão 1, adiciona IDs ainda não existentes e preserva os leads e configurações atuais.

Dados demonstrativos são gerados em relação à data do primeiro acesso e identificados na interface. Você pode removê-los em **Configurações → Remover dados de demonstração**, preservando seus leads.

Não há autenticação, integração com calendário, WhatsApp ou provedor de IA nesta versão. O modelo e os componentes estão separados para facilitar a futura integração com uma API e banco de dados.

## Estrutura

- `src/App.tsx`: navegação, armazenamento, pesquisa, backup e configurações.
- `src/components/`: dashboard, pipeline, cadastro, calls e performance.
- `src/lib/`: dados de demonstração, métricas e validação de backups.
- `tests/`: testes de métricas, validação e fluxos de navegador.
