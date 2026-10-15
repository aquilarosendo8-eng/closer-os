# HIGH CLOSER — SDR e taxa de no-show

## SDR — Pré-vendas

O administrador convida ou altera um membro para **SDR — Pré-vendas** no Admin da empresa. O código persistido é `sdr`; os cargos e convites existentes não são convertidos automaticamente. O novo papel ocupa um assento como os demais membros.

SDR tem o mesmo escopo operacional do Closer: consulta e edição de oportunidades atribuídas a si, qualificação, informações comerciais, pós-call e agendamento pelos fluxos existentes. A exportação e a restauração JSON anteriores permanecem restritas à sua base autorizada. SDR não configura a empresa, não gerencia membros, não redistribui leads, não revisa calls como liderança, não exclui leads nem usa a importação CSV/XLSX de Admin/Manager.

O servidor continua sendo a autoridade. A migration `202610150011_sdr_role.sql` amplia as duas constraints de cargo, as validações de convites e alteração de membros, os helpers RLS de leitura/escrita e responsável elegível, o controle de atribuição de atividades e as opções administrativas de inbound. SDR só lê/escreve leads próprios; atribuir uma atividade nunca concede acesso ao lead. Viewer e membros inativos continuam inelegíveis como responsáveis operacionais.

As integrações existentes usam o helper de responsável e passam a aceitar um SDR ativo da empresa, sem criar integrações ou alterar seu fluxo. Admin e Manager mantêm as atribuições que já possuíam. O Master não ganha vínculo nem acesso comercial por esta mudança; as funções Master preservam sua autorização e a projeção limitada de dados administrativos. Nenhum segredo administrativo é enviado ao frontend.

As migrations 001–010 permanecem intactas. A nova migration não reescreve dados de clientes, não cria tabela para métricas e preserva os limites de assentos, confirmações de conta e vínculo seguro no aceite do convite.

## Taxa de no-show

`getMetrics()` usa as mesmas contagens de comparecimento já existentes:

`faltas / (comparecimentos + faltas) × 100`

Calls pendentes não entram no denominador. Sem nenhuma call concluída, a taxa é `null` e o Dashboard mostra `—`; zero faltas com calls concluídas é uma taxa real de `0%`. A regra legada que trata uma venda ganha como comparecimento é mantida. Show rate, close rate e faturamento não tiveram suas fórmulas alteradas.

A taxa, a quantidade de faltas e a comparação ficam no card de comparecimento, mantendo os quatro cards atuais. A comparação usa pontos percentuais: redução é positiva/verde e aumento é negativo/vermelho. Sem chamadas concluídas em ambas as bases, a comparação fica neutra. A base mensal anterior é a já fornecida pelo Dashboard; trimestre e todo o período respeitam seus filtros e não inventam uma base anterior.

Cada indicador recebe somente os leads visíveis ao usuário pelo RLS e pelo período selecionado. Não existe Dashboard, módulo ou filtro exclusivo para SDR.

## Arquivos e verificação

- API e papéis: `api/invitations.mjs`, `src/lib/access-types.ts`, `src/App.tsx`, `src/SaaSApp.tsx`, `src/components/Administration.tsx`, `src/components/Calls.tsx` e ajuste do guia de cargos em `src/visual/account-administration.css`.
- Métrica: `src/lib/analytics.ts`, `src/components/Dashboard.tsx` e `src/components/dashboard-no-show.css`.
- Banco: migration 011, `supabase/tests/sdr-role.sql`, integração no `scripts/test-database.sh` e verificação das constraints/funções no provisionador.
- Testes: API de convites e link manual, serviços de acesso, responsável da importação, analytics, e fluxos de navegador em `tests/sdr.spec.ts` e `tests/no-show.spec.ts`, com suas configurações Playwright.

Os testes de navegador locais simulam HTTP de Auth/REST para validar a interface; a suíte PostgreSQL testa RLS, funções, transações e isolamento reais. A validação em produção usa somente contas e empresas temporárias e é registrada após a confirmação do deploy. Nenhuma senha, token de convite ou credencial deve aparecer nos relatórios públicos.

Validação local consolidada: **499 testes unitários**, **143 cenários distintos de navegador** (12 SDR, 18 no-show e 113 regressões), **1.545 assertivas PostgreSQL**, incluindo 105 de SDR e os 22 cenários concorrentes anteriores, e **61 verificações de provisionamento em banco descartável**, todos aprovados. O build passou; nenhum arquivo das migrations instaladas 001–010 foi modificado.
