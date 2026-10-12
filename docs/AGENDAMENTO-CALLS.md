# HIGH CLOSER — Agendamento de calls pelo pipeline

Ao arrastar uma oportunidade ou usar seu seletor de etapas para entrar em **Agendado** ou **Call agendada**, o HIGH CLOSER abre **Agendar call**. O vendedor informa a data e o horário e confirma uma única vez. A etapa, `callDate` e o comparecimento **Pendente** são enviados juntos pela atualização de oportunidade já existente.

## Uso

1. No Pipeline, arraste o card ou use **Mover para**. No editor aberto pela Oportunidade 360°, use **Status**.
2. Preencha **Data da reunião** e **Horário da reunião** com um horário futuro. Uma data já registrada aparece inicialmente para facilitar o reagendamento.
3. Clique em **Confirmar agendamento**. No editor da oportunidade, essa confirmação também salva o rascunho do formulário. Ao cadastrar diretamente na coluna de agendamento, a mesma confirmação antecede o primeiro cadastro.
4. Consulte **Calls → Próximas**. A lista e seu indicador consideram apenas reuniões com comparecimento pendente e horário futuro, ordenadas cronologicamente. Ao passar o horário, a reunião sai dessa lista em até 30 segundos, ou ao voltar o foco à página, e continua no histórico geral.

Cancelar a janela não grava a movimentação nem a data. Um erro mantém a janela e os campos preenchidos para nova tentativa. Enquanto a gravação está em andamento, os botões e novas submissões ficam bloqueados.

## Critérios e segurança

- A regra reconhece somente os nomes completos **Agendado** e **Call agendada**, normalizando caixa, acentos e espaços. A etapa precisa ser do tipo `NORMAL`; nomes parecidos e etapas `WON`/`LOST` mantêm seu comportamento atual.
- Se a etapa for desativada ou deixar de ser uma etapa de agendamento enquanto a janela estiver aberta, a confirmação é recusada até que o vendedor escolha novamente.
- Não existe configuração de fuso do workspace na arquitetura atual. Data e horário usam o fuso local do navegador, como o campo `datetime-local` já existente; a persistência usa ISO UTC e a apresentação converte para o horário local.
- O fluxo reutiliza `public.leads.data.callDate`, `stage_id` e o mesmo `PATCH`/`INSERT` do `useCloudData`. Nenhum registro separado ou duplicado de call é criado.
- Os triggers de histórico existentes preservam a reunião anterior e suas avaliações. O reagendamento não apaga eventos ou os dados do pós-call já registrados.
- As autorizações e a RLS existentes continuam responsáveis pela gravação. Viewer não pode editar; Closer mantém o escopo dos próprios leads; Admin e Manager mantêm suas permissões atuais. A função Master não oferece acesso ao pipeline ou às calls de clientes.
- As integrações de entrada, importações, autenticação, convites e regras de etapas Ganho/Perdido não foram alteradas por este fluxo.

## Verificação

- `npx vitest run tests/call-scheduling.test.ts`: 30 testes de nomes de etapas, datas reais, conversão local/UTC, exigência de futuro, transição atômica montada no cliente e filtro de próximas calls.
- `npx playwright test --config=playwright.scheduling.config.ts`: 13 cenários de navegador, incluindo arraste, seletor, cancelamento, reagendamento pelo editor, erro/repetição, bloqueio de duplicação, recarga, Calls, expiração por horário, permissões, etapa alterada durante a janela e mobile claro/escuro.
- `npm run test:db`: inclui `supabase/tests/call-scheduling.sql`, com gravações PostgreSQL reais para validar atomicidade em caso de erro, histórico e RLS de usuários de empresas diferentes. Os fixtures existem apenas no banco Docker descartável.

Não é necessária uma migration específica de agendamento, coluna adicional, variável de ambiente ou configuração manual de Supabase. A publicação utiliza o build e o deploy já existentes.
