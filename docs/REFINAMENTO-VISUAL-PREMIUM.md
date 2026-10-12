# Refinamento visual premium — HIGH CLOSER

## Escopo

Refinamento incremental da área autenticada, mantendo DM Sans, Manrope, paletas, marca, navegação e funcionalidades. Não há mudanças no backend, Auth, permissões, banco, métricas ou integração. O parser de qualificação permanece intacto.

## Diagnóstico e decisões de UX

- Os tokens operacionais anteriores definiam corpo em 13 px, texto secundário em 12 px e labels em 11 px. As camadas finais aplicavam esses tamanhos também a responsáveis, datas, tabelas e contexto de investimento. Foram ajustados para 14/13/12 px, preservando tamanhos menores nos elementos auxiliares de marca e navegação.
- O resumo do Lead 360 usava seis colunas estreitas no desktop. Três colunas em duas linhas permitem ler etapa, responsável, próxima ação e contexto sem comprimir os valores. Mobile mantém duas colunas.
- A qualificação vinha depois do diagnóstico; agora aparece logo após os dados de contato. A mudança é somente a ordem do bloco JSX, sem alterar valores, condições, callbacks ou parsing.
- A descrição da empresa, os labels e os investimentos da qualificação ganharam legibilidade. O texto completo e as observações livres continuam disponíveis.
- Os valores do Kanban passaram a 16 px e os KPIs gerais a 28 px. A largura das colunas, margens e estrutura dos cards foram preservadas. Hover usa o primary existente; o indicador vermelho de atraso permanece.
- Controles normais têm 36 px, compactos 32 px e áreas de toque base 44 px. Os tokens refinados estão restritos a `.crm-visual`: os padrões globais usados pelas telas públicas/Auth permanecem intactos. Calls, Atividades e Admin reutilizam os mesmos tokens; não foi criada uma nova camada de CSS. Os controles de visualização e adição nas colunas do Kanban também têm 44 px no celular.
- Os ticks dos gráficos usam a escala de labels de 12 px. Séries, filtros, formatadores, domínios e cálculos permanecem iguais. A área principal de receita recebeu 14 px adicionais de altura.

## Arquitetura preservada

`visual-system.css` mantém identidade e cores. `operational-ui.css` continua importando foundation, pipeline/opportunity, worklists/performance e account/administration na ordem existente. Os ajustes foram feitos nas regras existentes que determinam a apresentação final. Admin herda os tokens; `account-administration.css` não precisou de uma camada adicional.

## Arquivos alterados

- `src/visual/operational-foundation.css`
- `src/visual/pipeline-opportunity.css`
- `src/visual/worklists-performance.css`
- `src/components/lead-360.css`
- `src/components/Lead360.tsx` — apenas ordem do bloco de diagnóstico
- `playwright.premium.config.ts`
- `tests/premium-visual.spec.ts`
- `docs/REFINAMENTO-VISUAL-PREMIUM.md`

## Comparações

Baseline do código `146abd20dcb18f6fb625bb373280ee8bae47446b`. Foram capturados os mesmos onze estados em 1366, 1440, 820 e 390 px, em claro e escuro: **88 pares antes/depois**, com dados fictícios e relógio fixo. Há quatro verificações adicionais de identidades longas.

As imagens e o comparador ficam em `/workspace/closer-os-artifacts/premium-visual/`. Abra `comparacao.html` para selecionar tela, tema e resolução. Nenhum dado real de cliente foi usado nas capturas.

Comandos da suite visual:

```bash
HIGH_CLOSER_VISUAL_PHASE=before npx playwright test --config=playwright.premium.config.ts
npx playwright test --config=playwright.premium.config.ts
```

O baseline deve ser capturado antes de alterar os estilos. Os testes verificam overflow horizontal, conteúdo extenso, limites do modal, preservação dos leads e ausência de mutações durante a navegação.

## Validação

Build e **343 testes de código passaram**. O aviso existente de bundle acima de 500 kB não impediu o build; não foram adicionadas dependências.

**179 testes de navegador passaram:** 12 premium/identidades longas, 32 de oportunidades, 21 de Pipeline/Calls, 15 de temas/contraste, 44 de SaaS/Admin, 28 de perfis, 17 de integrações e 10 de CRM. A captura anterior também passou nas oito combinações de tema/resolução. As fixtures usam Supabase simulado; não se trata de um teste de ingestão real em produção.

Os testes conferiram callbacks e fluxos existentes, permissões na interface, foco, modais, contraste, responsividade, leitura de textos extensos e ausência de gravações durante a navegação visual. Nenhuma regressão foi identificada nas suites finais. A revisão da diff confirmou que API, schema, RLS, Auth, métricas, integração, parser, dependências, cores e imports do design system permaneceram inalterados.

A publicação e a conferência de assets/dados de produção serão realizadas depois deste registro de validação local, sem adicionar fixtures ou enviar e-mails em produção.

## Limites

Kanban e tabelas extensas conservam rolagem horizontal dentro de seus próprios contêineres. Textos extensos permanecem completos e roláveis; não foram truncados para obter capturas menores. Não foram executadas migrações ou alterações de configuração visual no Supabase.
