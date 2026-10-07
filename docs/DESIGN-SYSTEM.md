# Design visual e temas do Closer OS

Atualização de 7 de outubro de 2026. O redesenho atua somente na área interna autenticada. Login, cadastro público, convites/ativação, documentos legais e demonstração mantêm sua apresentação anterior.

## Uso

No topo da área interna, o seletor **Tema da interface** oferece **Tema Claro** e **Tema Escuro**. A troca é imediata, sem navegação, recarga ou chamadas ao backend. A preferência fica no navegador, na chave `closer-os-theme-v1`. Até uma escolha explícita, o tema acompanha a preferência do sistema operacional. Se o navegador bloquear o armazenamento, a troca continua disponível durante a visita.

Dashboard, Pipeline, formulários de leads, Calls, revisão de call, Performance, Admin, conta, tabelas, gráficos, tooltips, notificações e modais usam o mesmo conjunto de tokens visuais. A sidebar navy possui seleção discreta, hierarquia de navegação e perfil legível. Em notebooks, os elementos decorativos do card de evolução ficam compactos para deixar as ações e o perfil acessíveis. Em tablets, a sidebar permanece abaixo do cabeçalho da empresa, sem encobri-lo. No celular, o menu conserva seu comportamento existente.

## Paleta

| Token | Claro | Escuro |
| --- | --- | --- |
| Background | `#F6F7F9` | `#090E18` |
| Superfície | `#FFFFFF` | `#111827` |
| Superfície elevada | `#F9FAFB` | `#182131` |
| Sidebar | `#0B1220` | `#070B12` |
| Texto principal | `#111827` | `#F4F6F8` |
| Texto secundário | `#667085` | `#98A2B3` |
| Bordas | `#E5E7EB` | `#273244` |
| Azul de texto/gráficos | `#3157D5` | `#86A6FF` |
| Botão primário | `#3157D5` | `#4669DD` |
| Sucesso | `#147D64` | `#6BD7B1` |
| Alerta | `#996215` | `#F2C46D` |
| Erro | `#B5474D` | `#F2969B` |

Os estados possuem fundos próprios para cada tema. O modo escuro não usa inversão automática. Raios principais: 6/10/14 px; sombras discretas; Manrope para títulos e indicadores, DM Sans para corpo, labels e controles. Os gráficos usam azul, tons neutros e verde para sucesso, com eixos, grades e tooltips adaptados ao tema. Os valores de fallback preservam o visual da demonstração pública.

## Arquivos

- `src/components/AuthenticatedTheme.tsx`: contexto visual, preferência local e seletor acessível.
- `src/SaaSApp.tsx`: inserção exclusivamente visual do wrapper e seletor nos retornos internos já autenticados.
- `src/main.tsx`: imports dos estilos visuais.
- `src/visual-system.css`: tokens claro/escuro e estilos internos de sidebar, header, Dashboard, Pipeline, formulários e elementos compartilhados.
- `src/components/administration-theme.css`: apresentação interna de Admin, convites, planos, tabelas e modais.
- `src/components/calls-performance-theme.css`: apresentação de Calls, revisão e Performance.
- `src/components/Dashboard.tsx`, `Performance.tsx` e `Pipeline.tsx`: somente cores de apresentação com fallbacks anteriores; cálculos e handlers preservados.
- `tests/theme.spec.ts`, `playwright.theme.config.ts`: verificações locais de tema, contraste, responsividade e capturas com Auth/API simulados.
- `docs/DESIGN-SYSTEM.md`: este registro.

Os arquivos CSS anteriores, componentes de autenticação, bibliotecas de dados/métricas, APIs, banco/migrations, permissões, contratos legais, dependências e lockfile não foram alterados. A única funcionalidade adicionada é a preferência visual solicitada.

## Validação

- Build TypeScript/Vite concluído.
- 109 testes unitários existentes passaram.
- 44 fluxos SaaS/Admin existentes passaram.
- 10 fluxos CRM existentes passaram.
- 15 testes de tema passaram: preferências do sistema, persistência, troca sem recarregar/remontar formulários, dados/sessão preservados, armazenamento bloqueado, páginas públicas intactas, estados e contraste de textos, gráficos/tooltips/modais e responsividade em 1366×768, 1920×1080, 820×1180 e 390×844.

Os testes visuais usam dados fictícios locais e respostas HTTP controladas; não criam usuários, leads ou empresas no Supabase de produção. As capturas ficam em `.playwright/theme-shots`, fora do versionamento.

Para publicar esta alteração visual, foi preparado o output de produção da Vercel com um arquivo de configuração local fora do checkout, executando somente `npm run build`. As duas funções de convite existentes permanecem incluídas, com seus fontes intactos. O deploy prebuilt não executa `build:cloud`, migrations ou provisionamento do banco. O `vercel.json` versionado permanece inalterado.
