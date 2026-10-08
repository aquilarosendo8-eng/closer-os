# Pipeline por empresa e revisão de calls

O HIGH CLOSER mantém um pipeline principal por empresa. Os registros antigos, o acesso privado, os papéis da equipe e os temas claro/escuro continuam compatíveis.

## Pipeline personalizável

Em **Pipeline → Configurar pipeline**, administradores e gestores podem adicionar etapas, editar nome e cor, reorganizar por arraste ou pelas setas, e desativar etapas. A configuração mostra a quantidade de leads em cada etapa. Etapas ocupadas podem ser desativadas; continuam visíveis enquanto tiverem leads. Para excluir uma etapa ou mudar seu tipo, primeiro mova os leads.

Cada etapa tem identidade própria, posição, cor e tipo `NORMAL`, `WON` ou `LOST`. A configuração exige exatamente uma etapa ativa `WON` e uma ativa `LOST`. Renomear “Fechado” para “Contrato assinado” mantém as vendas e o faturamento, porque o cálculo usa o tipo. Uma etapa terminal antiga pode ficar inativa para preservar seu histórico quando outra assumir essa função.

Os cards mantêm responsável, ticket, origem, alertas e atraso no contato. Mover para `WON` exige o valor realmente fechado quando ainda não existe; mover para `LOST` abre o formulário de motivo da perda e comentário. Também é possível alterar a etapa no formulário do lead. Closer e viewer usam a configuração da empresa; viewer permanece sem edição.

## Pós-call e gravação

Em **Calls → Revisar**, o vendedor registra nota, resumo, dor, urgência, capacidade financeira, decisor, objeção, erro, próximo passo e link da gravação. O closer edita apenas suas próprias oportunidades, conforme a permissão já aplicada no servidor.

O link deve usar HTTPS. Não são aceitos esquemas executáveis, credenciais no endereço ou caracteres de controle. Não há upload, iframe ou incorporação automática. **Assistir gravação** abre uma nova aba com `noopener noreferrer`. A disponibilidade da gravação e as permissões no serviço de origem continuam sob controle do proprietário desse link.

## Revisão da liderança

No mesmo detalhe, administradores e gestores preenchem **Feedback da liderança** e **Nota da liderança**, de 0 a 10, e selecionam **Marcar como revisada**. O servidor registra o usuário autenticado e a data; o navegador não escolhe a autoria. O closer lê esse feedback sem editar. O viewer lê apenas as calls às quais já tem acesso.

A lista mostra **Pendente de revisão** ou **Revisada** e permite filtrar **Todas**, **Pendentes** e **Revisadas**. A avaliação da liderança fica em uma tabela separada do pós-call; alterar ou importar o JSON de um lead não concede permissão de revisar.

## Migração e estrutura

Migração nova: `supabase/migrations/202610070004_custom_pipeline_call_reviews.sql`. As três migrations anteriores permanecem intactas.

- `pipelines`: pipeline com `workspace_id`, nome, flag de principal e criação; a estrutura comporta expansão futura, mas a interface opera somente o principal.
- `pipeline_stages`: etapas com `workspace_id`, `pipeline_id`, nome, posição, cor, tipo, ativo, criação e referência de compatibilidade `legacy_status`.
- `leads.stage_id`: vínculo obrigatório composto com a empresa, impedindo referência a etapas de outra empresa.
- `leads.loss_reason_grandfathered`: marcador interno, sem escrita pelo cliente, para preservar perdas históricas sem motivo registrado.
- Novos dados opcionais do lead: `stageId`, `stageName`, `stageType`, `lossReason`, `lossComment`, `recordingUrl` e `nextStep`.
- `call_reviews`: empresa, lead, feedback, nota, autor e data da revisão.

A migration transacional cria as sete etapas originais para cada empresa e vincula os leads pelo status anterior. O backfill acrescenta somente o vínculo e os metadados derivados da etapa, preservando o conteúdo original, os valores, os responsáveis e os timestamps. Nenhum lead é excluído. As empresas criadas depois da migration recebem automaticamente o mesmo pipeline inicial.

O status antigo fica como compatibilidade de backups e clientes anteriores; a lógica de vitória e perda usa `WON`/`LOST`. Backups antigos continuam importáveis sem sobrescrever IDs existentes. Referências de etapas de outro workspace são remapeadas dentro da empresa de destino; avaliações de liderança não são restauradas por JSON do vendedor.

As novas tabelas têm RLS, as configurações e avaliações usam RPCs autenticadas, e o registro de autoria vem do servidor. Não há chave administrativa no frontend. A exportação administrativa inclui a configuração do pipeline e as avaliações da liderança, além dos dados anteriores.

## Verificação e publicação

Comandos de verificação: `npm run build`, `npm test`, `npm run test:e2e`, `npm run test:saas`, `npx playwright test --config=playwright.theme.config.ts`, `npx playwright test --config=playwright.features.config.ts` e `npm run test:db`.

Os testes locais de autenticação usam fixtures HTTP; os testes de banco usam PostgreSQL descartável. O teste real `scripts/test-live.mjs` usa contas e empresas temporárias no Supabase, verificadas e removidas ao finalizar, sem enviar e-mails nem alterar contas de clientes.

A publicação da Vercel executa o provisionador existente, que verifica os checksums das migrations instaladas e aplica somente a migration nova. Não são necessárias novas variáveis, chaves ou mudanças no SMTP.

Verificação local em 07/10/2026: build aprovado; 123 testes unitários; 90 E2E (10 CRM, 44 SaaS/Admin, 15 temas e 21 funcionalidades); 321 verificações de banco (incluindo backfill real anterior à migration e isolamento); 11 verificações do provisionador em PostgreSQL descartável. Todos aprovados. A migration `004` foi validada com o checksum `e23342df65ca7004d34276060b5023bfa500c0c96325261fb6b224476ac3eb44`.

Verificação em produção em 07/10/2026: migration `004` aplicada e publicação pronta em https://closer-os-rho-three.vercel.app/. A comparação com o estado anterior confirmou a preservação das seis empresas e dos quatro leads existentes, incluindo conteúdo, responsáveis e timestamps, com o vínculo correto às etapas. As 87 verificações reais de Supabase/Auth/RLS passaram, assim como os 12 checkpoints de navegação no CRM publicado com admin, manager, closer e viewer.

O teste no navegador confirmou configuração e transições do pipeline, atualização do faturamento, pós-call, gravação HTTPS, feedback e nota zero da liderança, autoria/data do servidor, filtros, restrições de edição, abertura segura da gravação, temas persistentes e modais em desktop/mobile. Não houve erros do navegador. Todas as contas e empresas temporárias foram removidas, incluindo suas etapas, leads e avaliações; os dados dos clientes existentes permaneceram intactos.

## Arquivos da implementação

- Banco: migration `004`; `supabase/tests/{pre-pipeline-migration,post-pipeline-migration,pipeline-call-reviews}.sql`.
- Tipos e dados: `src/types.ts`; `src/lib/{pipeline,validation,cloud-types,useCloudData}.ts`.
- Integração e métricas: `src/{App,SaaSApp}.tsx`; `src/lib/analytics.ts`; `src/components/{Dashboard,Performance}.tsx`.
- Interface: `src/components/{Pipeline,PipelineConfiguration,StageTransitionModal,LeadForm,Calls}.tsx`; `src/components/{pipeline-features,calls-features}.css`.
- Operação: `scripts/{provision-supabase,test-live}.mjs`; `scripts/test-database.sh`.
- Testes: `playwright.features.config.ts`; `tests/features.spec.ts`; `tests/pipeline-metrics.test.ts`; `tests/fixtures/{features,pipeline}.ts`; atualizações de `tests/{admin,crm,saas,theme}.spec.ts` e `tests/validation.test.ts`.
- Documentação: este guia. Não houve alteração de dependências, migrations anteriores, APIs de convite ou configurações de autenticação.
