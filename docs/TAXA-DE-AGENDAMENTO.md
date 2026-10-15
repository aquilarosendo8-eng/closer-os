# HIGH CLOSER — Taxa de agendamento

## Cálculo e leitura

`Taxa de agendamento = leads únicos já agendados / leads recebidos no período × 100`.

A coorte usa `createdAt`, independentemente da data da call, do fechamento ou da etapa atual. Este mês e os últimos três meses seguem os limites de calendário existentes no Dashboard, no fuso do navegador. Todo o período considera a base autorizada completa. Cada ID aparece apenas uma vez; agendar novamente não cria outra conversão. A conversão é acumulada até a consulta: um lead recebido em setembro e agendado em outubro continua na coorte de setembro.

`getBookingMetrics()` recebe somente os leads que a aplicação já carregou para a empresa e o usuário. Não há consulta adicional, leitura de outros workspaces, nova permissão ou acesso comercial para o Master. `getMetrics()`, `getPeriodLeads()` e os denominadores de receita, comparecimento, no-show e fechamento permanecem inalterados.

O bloco de agendamento fica acima dos quatro cards existentes, próximo a comparecimento/no-show, sem gráficos novos. Exibe percentual, agendados/recebidos e comparação mensal em pontos percentuais quando ambas as coortes existem. Aumento é positivo e redução é negativa. Trimestre e todo o período não inventam uma base anterior. Sem leads recebidos, mostra `—`; uma base existente sem nenhum agendamento mostra `0%`.

## Persistência e compatibilidade

O documento JSON existente do lead ganhou dois campos opcionais:

- `firstScheduledAt`: instante conhecido do primeiro agendamento efetivo.
- `hasBeenScheduled`: evidência persistente de que o lead já foi agendado, inclusive quando o instante original é desconhecido.

Os fluxos locais, formulário, pipeline e salvamento autenticado compartilham `preserveFirstScheduling()`. No Supabase, um trigger registra o primeiro agendamento novo com o relógio do servidor e conserva o histórico nas atualizações posteriores, inclusive quando um cliente envia um JSON antigo sem os campos. Remarcar, concluir a call, registrar no-show, mudar de etapa ou limpar `callDate` não remove a conversão.

A migration nova `202610150012_lead_scheduling_history.sql` é necessária porque updates REST substituem o documento inteiro: apenas um ajuste no frontend não protegeria a informação em outros caminhos de gravação ou em edições concorrentes. A migration não cria tabelas/colunas, não modifica políticas RLS e não reescreve os leads antigos. As migrations 001–011 permanecem intactas.

A importação JSON mantém os mesmos guardas de autorização, validação, resolução de etapas, compatibilidade de perdas antigas e inserção sem sobrescrever IDs existentes. Somente um contexto transacional de importação histórica foi acrescentado, restaurado no sucesso e no erro. Esse contexto não altera identidade ou autorização. CSV/XLSX continuam com a whitelist e a atribuição existentes; o trigger reconhece os metadados de importação já produzidos no servidor. A integração inbound continua criando leads sem call agendada.

## Limites dos dados históricos

Uma `callDate` válida é evidência suficiente de um agendamento antigo. O sistema preserva essa evidência, mas não usa a data da reunião nem o instante da importação como se fossem o instante histórico do primeiro agendamento. Backups atuais podem restaurar um `firstScheduledAt` realmente conhecido. Somente status, comparecimento ou etapa sem evidência de data/histórico não comprovam agendamento.

Se a data de uma call antiga já havia sido apagada antes desta entrega e nenhum histórico de agendamento existe no snapshot, não é possível reconstruí-lo com segurança; o sistema não fabrica uma conversão. CSV/XLSX sem data original de criação continuam usando a data de importação conforme o contrato anterior (`importMetadata.createdAtSource = 'import'`). Registros locais antigos sem data de entrada válida ficam fora das coortes datadas, mas entram em todo o período.

## Validação desta entrega

- **543 testes unitários**, incluindo 18 de coortes e 26 de histórico/persistência.
- **76 cenários distintos de navegador**: 23 de agendamento/coortes, 18 de no-show, 12 de SDR, 13 de agendamento existente e 10 do CRM.
- **1.609 assertivas reais PostgreSQL**, incluindo 62 novas do histórico e duas da nova disputa entre primeiro agendamento e edição de JSON antigo; os **23 cenários de concorrência** passaram.
- **67 verificações de provisionamento** em PostgreSQL descartável, sem usar credenciais ou banco de produção: instalação, repetição, checksums, RLS, papéis existentes e recusa de trigger desativado/importação histórica incompleta/helpers expostos.
- Build e `git diff --check` aprovados. Temas claro/escuro, larguras de 1366/768/390 pixels, contraste AA e ausência de overflow foram verificados. Os testes de navegador locais simulam Auth/REST; a suíte SQL verifica permissões reais.

A conferência de produção será registrada após a publicação da versão validada. Testes externos usam somente contas e empresas temporárias identificadas, sem envio de e-mails, e precisam comprovar a limpeza ao terminar.

## Arquivos alterados

- `README.md`
- `docs/TAXA-DE-AGENDAMENTO.md`
- `scripts/provision-supabase.mjs`
- `scripts/test-database.sh`
- `src/App.tsx`
- `src/components/Dashboard.tsx`
- `src/components/dashboard-booking.css`
- `src/lib/analytics.ts`
- `src/lib/lead-scheduling-history.ts`
- `src/lib/pipeline.ts`
- `src/lib/useCloudData.ts`
- `src/lib/validation.ts`
- `src/types.ts`
- `supabase/migrations/202610150012_lead_scheduling_history.sql`
- `supabase/tests/lead-scheduling-history.sql`
- `tests/booking-metrics.test.ts`
- `tests/booking.spec.ts`
- `tests/lead-scheduling-history.test.ts`
- `playwright.booking.config.ts`
