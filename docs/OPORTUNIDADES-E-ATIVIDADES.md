# Oportunidades 360°, atividades e timeline

Esta atualização do HIGH CLOSER centraliza os dados comerciais de uma oportunidade, organiza o próximo contato e registra automaticamente seu histórico. Reutiliza leads, etapas do pipeline, pós-call e revisões existentes. A publicação desta atualização e a verificação em produção ainda precisam ser confirmadas no [registro de implantação](IMPLANTACAO.md).

## Como usar

Abra uma oportunidade no card ou na lista do Pipeline. A visão 360° possui quatro abas:

| Aba | Conteúdo |
| --- | --- |
| Visão geral | Lead, empresa, etapa, responsável, ticket, origem, última interação, próxima atividade, quantidade de calls e última nota. Dados de contato, diagnóstico, observações, call atual e resultado da oportunidade aparecem em seções próprias. |
| Calls | Conversas conhecidas daquela oportunidade, com comparecimento, nota, resumo, objeção, diagnóstico, gravação disponível e revisão da liderança. **Ver call** expande o registro histórico para consulta. |
| Atividades | Pendências atrasadas, de hoje e futuras, além de concluídas e canceladas. Permite criar, editar, concluir ou cancelar conforme a permissão. |
| Timeline | Movimentações comerciais registradas pelo banco, com data, autor e descrição legível. Os eventos mais recentes aparecem primeiro. |

O botão **Editar** abre o cadastro existente para quem pode alterá-lo. Calls continua disponível como página própria. O alerta de oportunidade parada usa a regra de mais de cinco dias sem contato; o indicador de atividade vencida usa o prazo da tarefa.

## Próxima ação e central de atividades

Em **Nova atividade**, informe oportunidade, título, tipo, data, hora, responsável e descrição opcional. Os tipos disponíveis são Follow-up, Ligação, WhatsApp, E-mail, Reunião e Outro. Eles organizam a tarefa; não realizam o contato automaticamente.

As atividades têm três estados: pendente, concluída ou cancelada. Somente pendências podem ser editadas ou finalizadas. Concluir registra a data no servidor; cancelar preserva o registro como cancelado. Uma tarefa finalizada permanece para consulta e não pode ser reaberta pela interface ou RPC.

A próxima ação é calculada pela atividade pendente com o vencimento mais próximo, incluindo uma já atrasada. Não existe uma segunda data de próxima ação mantida manualmente no lead. Ela aparece na visão 360°, no Pipeline e na rotina operacional.

**Atividades** e a área **Sua rotina hoje** no Dashboard mostram:

- **Atrasadas:** pendentes cujo horário já passou, inclusive as vencidas mais cedo no mesmo dia.
- **Para hoje:** pendentes ainda não vencidas com data de hoje no horário de Brasília.
- **Próximas:** pendentes com data posterior ao dia atual.
- **Calls de hoje:** oportunidades acessíveis cuja call atual está datada para hoje. Essa contagem vem da agenda dos leads, não das tarefas do tipo Ligação nem da consulta de todas as calls históricas.

Os grupos de tarefas são separados, evitando contar uma mesma pendência como atrasada e para hoje. Concluir ou cancelar remove a tarefa da fila operacional; o registro continua na aba Atividades da oportunidade e na timeline. O Dashboard mantém seus cálculos financeiros e de conversão existentes.

## Datas e horários

Os campos do banco usam `timestamptz`, com instantes em UTC. A interface usa `America/Bahia`, apresentado como horário de Brasília, UTC−3. Por exemplo, uma atividade para 11/10/2026 às 14h é enviada como `2026-10-11T17:00:00.000Z`.

O usuário escolhe o vencimento. Autoria, criação, atualização, conclusão e data dos eventos são determinadas pelo banco usando a sessão autenticada e o relógio do servidor. A classificação de atrasada/hoje/próxima é derivada do estado e do vencimento, sem gravar um quarto status de atividade.

## Arquitetura e migration

A migration [202610080006_lead_activities_timeline.sql](../supabase/migrations/202610080006_lead_activities_timeline.sql) acrescenta duas tabelas. As versões anteriores já instaladas permanecem imutáveis. O payload comercial existente do lead continua sendo a fonte dos dados de cadastro e pós-call.

| Tabela | Campos | Função |
| --- | --- | --- |
| `public.activities` | `id`, `workspace_id`, `lead_id`, `assigned_to`, `created_by`, `type`, `title`, `description`, `due_at`, `status`, `completed_at`, `created_at`, `updated_at` | Tarefas vinculadas à empresa, oportunidade e responsável. O título aceita até 180 caracteres; a descrição, até 4.000. |
| `public.lead_events` | `id`, `workspace_id`, `lead_id`, `actor_id`, `event_type`, `metadata`, `created_at` | Histórico comercial e snapshots de calls gerados pelos triggers. O identificador é `bigint`; a autoria pode ficar nula quando o perfil deixa de existir. |

As chaves compostas de oportunidade impedem ligar uma tarefa ou evento ao lead de outra empresa. O responsável da atividade precisa pertencer ao mesmo workspace. Índices por empresa, lead, vencimento e cursor permitem consultar a fila e paginar o histórico sem varrer o histórico de todos os clientes.

## RLS e permissões

As duas tabelas têm RLS. A leitura herda o acesso ao lead e exige o vínculo/assinatura previstos pelas regras atuais. Uma atribuição de tarefa não concede acesso novo à oportunidade.

| Papel | Leitura | Alteração de atividades |
| --- | --- | --- |
| Administrador / Gestor | Oportunidades permitidas da própria empresa. | Criar, editar e finalizar tarefas; atribuir a membros ativos com permissão de edição. |
| Closer | Apenas oportunidades atribuídas a ele. | Gerenciar as tarefas desses leads; atividades novas ou reatribuídas pelo closer devem ficar em seu próprio nome. |
| Viewer | Oportunidades autorizadas para consulta. | Nenhuma. |
| Administrador da plataforma | Exige também um vínculo autorizado com a empresa. | O papel da plataforma, sozinho, não concede acesso aos leads ou às tarefas. |

Editar uma tarefa existente preserva seu responsável enquanto ele não for alterado explicitamente, inclusive quando a liderança havia atribuído a tarefa a outra pessoa. O responsável da tarefa e o responsável do lead são campos distintos: atribuir uma tarefa a um closer não substitui a distribuição do lead.

O cliente autenticado não possui `INSERT`, `UPDATE` ou `DELETE` direto nas novas tabelas. Atividades são gravadas por RPCs autorizadas; eventos são escritos pelos triggers do banco. O frontend não envia autor, data de criação ou data de conclusão. Alterar a empresa, a oportunidade ou a autoria de uma atividade existente também é bloqueado no backend. Não há chave `service_role` no navegador.

## RPCs utilizadas

Todos os métodos exigem sessão autenticada e validam a empresa e o acesso ao lead. As funções de alteração travam a oportunidade/empresa para evitar operações concorrentes sobre um estado incompatível.

| RPC | Parâmetros | Resultado |
| --- | --- | --- |
| `save_activity` | `p_workspace_id`, `p_lead_id`, `p_title`, `p_type`, `p_due_at`, `p_assigned_to?`, `p_description?`, `p_activity_id?` | Cria ou edita uma tarefa pendente. Retorna o registro com os campos determinados pelo servidor. |
| `set_activity_status` | `p_workspace_id`, `p_activity_id`, `p_status` | Conclui ou cancela uma pendência. Repetir o mesmo estado não duplica a conclusão; trocar o estado de uma tarefa já finalizada é recusado. |
| `list_lead_activities` | `p_workspace_id`, `p_lead_id?`, `p_limit?`, `p_offset?` | Sem lead, retorna somente pendências acessíveis da fila operacional. Com lead, inclui o histórico de concluídas/canceladas dessa oportunidade. |
| `list_lead_events` | `p_workspace_id`, `p_lead_id`, `p_before_id?`, `p_limit?` | Eventos da oportunidade, mais recentes primeiro, com cursor para continuar a consulta. |
| `list_lead_call_history` | `p_workspace_id`, `p_lead_id`, `p_limit?`, `p_offset?` | Calls conhecidas, quantidade, responsável e última interação registrada, com paginação. |

## Timeline automática e histórico de calls

Os triggers de `leads`, `activities` e `call_reviews` registram mudanças comerciais relevantes: criação, responsável, etapa, ticket, call agendada/registrada, pós-call, gravação adicionada, revisão da liderança, tarefa criada/alterada/concluída/cancelada, venda fechada, perda, motivo de perda e reabertura de uma oportunidade finalizada para etapa normal.

O evento e sua origem são salvos na mesma transação da alteração. A timeline não exige digitação manual nem registra cliques ou navegação. A interface traduz os eventos em descrições comerciais, sem apresentar os metadados como um log técnico.

O histórico de calls usa snapshots desses eventos, agrupados pela data/hora normalizada da call. Exibe a versão mais recente de cada data, preservando diagnóstico, nota e revisão capturada para aquela conversa. A quantidade indica registros conhecidos, inclusive calls agendadas; ela não altera o cálculo existente de calls realizadas ou conversão. Registros sem data são agrupados como call sem data; não existe uma tabela duplicada de reuniões independentes.

Para oportunidades que já existiam antes da migration, são importados somente fatos conhecidos: criação com data/autoria existentes no banco e snapshot da call atual com a revisão disponível. A call anterior aparece identificada como registro do cadastro. Isso não reconstrói reuniões ou mudanças de etapa antigas que nunca foram armazenadas. O snapshot legado não é mostrado como uma nova call realizada na timeline.

Atividades e eventos são removidos em cascata quando o lead ou a empresa é excluído, inclusive na purga autorizada de retenção. A exportação completa da empresa inclui `activities` e `lead_events`; a importação comum de leads não restaura esse histórico nem suas autorias.

## Carregamento e estados de erro

A central carrega somente tarefas pendentes, em páginas de até 200 itens. Concluídas e canceladas são consultadas quando uma oportunidade é aberta. O detalhe busca a primeira página de calls desse lead para o resumo e suas atividades completas; a timeline é buscada ao entrar nessa aba. Mais calls e eventos são carregados pelos respectivos botões de paginação, em páginas iniciais de 20 e 30 itens.

As respostas são vinculadas à empresa, usuário e oportunidade selecionados. Uma resposta antiga não pode preencher a tela de outra oportunidade/empresa. A fila é atualizada após alterações e periodicamente enquanto a página estiver visível. Falhas mostram opção de tentar novamente; um erro ao salvar mantém o rascunho, e um erro ao concluir mantém a pendência.

## Arquivos principais

- `src/components/Lead360.tsx` e `lead-360.css`: detalhe, abas, calls e timeline.
- `src/components/Activities.tsx`, `ActivityForm.tsx` e `activities.css`: central, formulário e ações de tarefas.
- `src/components/OperationalToday.tsx` e `opportunity-integration.css`: resumo operacional no Dashboard e integração visual.
- `src/lib/opportunity-types.ts`, `opportunity.ts` e `opportunity-service.ts`: contratos, datas, próxima ação, apresentação e chamadas públicas de RPC.
- `src/lib/useOpportunityData.ts`: fila pendente e contexto de acesso da nuvem.
- `src/lib/useDemoOpportunity.ts`: demonstração local isolada, sem comunicação com o Supabase.
- `src/lib/dialog-scroll.ts`: rolagem de modais aninhados, inclusive ao trocar de conta ou empresa.
- `src/App.tsx`, `src/SaaSApp.tsx` , `src/components/Dashboard.tsx` e `src/components/Pipeline.tsx`: entrada no detalhe, navegação, permissões e indicadores do Pipeline.
- `supabase/migrations/202610080006_lead_activities_timeline.sql`: tabelas, RLS, funções, triggers, snapshots anteriores e portabilidade.

## Validação e publicação

A suíte de PostgreSQL isolado passou **639 verificações**, incluindo atividades, eventos, autoria protegida, papéis, isolamento, snapshots anteriores e concorrência. Os **195 testes unitários** e `npm run build` passaram; o provisionamento isolado passou **25 verificações**. Os **138 cenários de navegador** passaram: 28 de oportunidades, 10 de CRM, 21 de Pipeline/Calls, 44 de SaaS/Admin, 20 de perfil e 15 de temas. A verificação de produção será registrada após a publicação. As suítes de navegador usam API simulada; não equivalem a uma verificação do novo deploy no Supabase real.

```bash
npm test
npm run build
npx playwright test --config=playwright.opportunity.config.ts
npm run test:db
```

O deploy na Vercel executa `npm run build:cloud`. O provisionamento aplica a migration006 pendente, verifica seus checksums e confere **16 tabelas públicas com RLS**, além da ausência de escrita direta do cliente nas novas tabelas e das RPCs necessárias. Nesse fluxo integrado, a atualização do schema é automática; não reaplique o SQL manualmente.

Depois de confirmar o deploy e o schema em produção, não será necessária uma configuração manual adicional no Supabase ou na Vercel para estas funções. A confirmação da versão publicada, do build e dos fluxos reais deve ficar no [registro da implantação](IMPLANTACAO.md).

## Relação de arquivos desta implementação

- `README.md`
- `scripts/provision-supabase.mjs`
- `scripts/test-database.sh`
- `scripts/test-live.mjs`
- `src/App.tsx`
- `src/SaaSApp.tsx`
- `src/components/Dashboard.tsx`
- `src/components/Pipeline.tsx`
- `src/lib/cloud-types.ts`
- `src/types.ts`
- `tests/admin.spec.ts`
- `tests/crm.spec.ts`
- `tests/features.spec.ts`
- `tests/fixtures/features.ts`
- `tests/fixtures/profile.ts`
- `tests/saas.spec.ts`
- `tests/theme.spec.ts`
- `docs/OPORTUNIDADES-E-ATIVIDADES.md`
- `playwright.opportunity.config.ts`
- `src/components/Activities.tsx`
- `src/components/ActivityForm.tsx`
- `src/components/Lead360.tsx`
- `src/components/OperationalToday.tsx`
- `src/components/activities.css`
- `src/components/lead-360.css`
- `src/components/opportunity-integration.css`
- `src/lib/dialog-scroll.ts`
- `src/lib/opportunity-service.ts`
- `src/lib/opportunity-types.ts`
- `src/lib/opportunity.ts`
- `src/lib/useDemoOpportunity.ts`
- `src/lib/useOpportunityData.ts`
- `supabase/migrations/202610080006_lead_activities_timeline.sql`
- `supabase/tests/lead-activities.sql`
- `supabase/tests/post-activities-migration.sql`
- `supabase/tests/pre-activities-migration.sql`
- `tests/fixtures/opportunity.ts`
- `tests/opportunity-services.test.ts`
- `tests/opportunity.spec.ts`
- `tests/opportunity.test.ts`
