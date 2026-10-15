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

Validação local consolidada: **499 testes unitários**, **143 cenários distintos de navegador** (12 SDR, 18 no-show e 113 regressões), **1.545 assertivas PostgreSQL**, incluindo 105 de SDR, **22 cenários concorrentes** e **61 verificações de provisionamento em banco descartável**, todos aprovados. O build passou; nenhum arquivo das migrations instaladas 001–010 foi modificado.

## Validação em produção — 15/10/2026

O commit funcional `2d6907cec6f9503db68c013dccddb29650396dd2` foi enviado ao GitHub e publicado pela integração nativa da Vercel. O deployment `dpl_FjMuoYHMVY7JJgVsrzKZDzNsX1EH` ficou `READY`, e o endereço canônico `https://closer-os-rho-three.vercel.app/` foi conferido com esse mesmo SHA. O build aplicou somente a migration 011, validou os 11 checksums de migrations e manteve 18 tabelas públicas protegidas por RLS. Não há configuração manual adicional no Supabase ou na Vercel para esta entrega.

Foram aprovadas **57 verificações reais em produção**, com cinco contas Auth confirmadas e duas empresas temporárias. O fluxo criou um convite SDR pendente no servidor, aceitou-o na interface, ativou o vínculo correto e realizou login. Foram conferidos leitura/edição/qualificação/agendamento próprios, bloqueio de leads de outros responsáveis e empresas, ausência de administração, alteração Closer ↔ SDR, atribuição administrativa, inbound e preservação das restrições do Master.

Com registros reais de teste, o SDR viu no-show de **25%** (1 falta / 4 calls concluídas), e o Admin viu **50%** (4 / 8), respeitando as respectivas bases autorizadas. Calls pendentes foram excluídas; a redução de 50 pontos percentuais em relação ao mês anterior foi positiva. Todo o período e o estado neutro com apenas calls pendentes foram conferidos, assim como os indicadores legados, os temas claro/escuro e as larguras de 1366 e 390 pixels.

O teste terminou sem erros de execução. Nenhum e-mail foi disparado por essas verificações: o convite foi criado pelo RPC existente e seu aceite foi exercitado na página real; o envio server-side e o link manual são cobertos pelos testes das APIs. Esta rodada não comprova uma nova entrega SMTP.

As cinco contas, duas empresas e todos os registros temporários foram removidos e a limpeza foi verificada. A comparação posterior dos hashes confirmou a preservação dos **454 registros originais nas 18 tabelas**, sem diferenças. HTML e sete assets de produção responderam corretamente; o worker de importação e os bloqueios de método das APIs existentes permaneceram disponíveis. Nenhum valor de credencial privilegiada foi encontrado nos assets publicados.

## Manifesto dos arquivos desta entrega

- `README.md`
- `api/invitations.mjs`
- `docs/SDR-E-NO-SHOW.md`
- `playwright.no-show.config.ts`
- `playwright.sdr.config.ts`
- `scripts/provision-supabase.mjs`
- `scripts/test-database.sh`
- `src/App.tsx`
- `src/SaaSApp.tsx`
- `src/components/Administration.tsx`
- `src/components/Calls.tsx`
- `src/components/Dashboard.tsx`
- `src/components/dashboard-no-show.css`
- `src/lib/access-types.ts`
- `src/lib/analytics.ts`
- `src/visual/account-administration.css`
- `supabase/migrations/202610150011_sdr_role.sql`
- `supabase/tests/sdr-role.sql`
- `tests/access-services.test.ts`
- `tests/analytics.test.ts`
- `tests/invitation-link-api.test.ts`
- `tests/invitations-api.test.ts`
- `tests/lead-import-reader.test.ts`
- `tests/no-show.spec.ts`
- `tests/sdr.spec.ts`
