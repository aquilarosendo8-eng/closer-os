# HIGH CLOSER — Administração Master de empresas

O Master administra contas clientes em **Administração → Clientes → Administrar**, sem convite, membership ou sessão em nome do cliente. A operação comercial continua exigindo vínculo e permissões na própria empresa.

## Uso

- **Informações:** nome, identificador, contato comercial e quantidade de usuários. O contato comercial é independente do e-mail de login, do administrador e do contato de privacidade.
- **Equipe:** acessos e convites com as proteções atuais de proprietário, administrador ativo, papéis e limite de lugares. O envio de convite continua exclusivamente no servidor.
- **Plano:** plano, situação, limite de lugares e vigência. Suspensão fica concentrada na Zona de perigo.
- **Integrações:** configuração, mapeamento, etapas normais ativas, responsáveis habilitados, ativação, rotação e arquivamento. O Master recebe somente metadados administrativos e diagnósticos técnicos.
- **Auditoria:** ações administrativas com campos permitidos. Ações comerciais e detalhes livres não são expostos ao Master.
- **Zona de perigo:** suspensão e exclusão. Para excluir, digite o nome exato, informe um motivo administrativo e confirme separadamente a autorização e o caráter irreversível da ação.

Não existe classificação confiável de empresa de teste na estrutura atual. Por isso, todas as exclusões exigem as mesmas confirmações. A declaração de autorização é uma confirmação explícita do operador Master; não constitui verificação externa da autorização do cliente. Não inclua dados de leads no motivo.

## Segurança

A migration `202610120009_platform_company_administration.sql` acrescenta `workspaces.business_contact_email`, RPCs `platform_*` específicas e um recibo mínimo de exclusão em `private.workspace_deletion_receipts`. As migrations anteriores permanecem intactas.

Cada operação Master verifica `auth.uid()` e a presença em `platform_admins` no banco. Escritas adquirem o bloqueio da empresa e verificam novamente a autorização. Funções usam `SECURITY DEFINER`, caminho de busca explícito, parâmetros validados e privilégios de execução restritos. Usuários comuns e administradores de outras empresas não recebem essas autorizações.

As políticas comerciais de leads, avaliações, atividades e timeline não recebem exceção para Master. Exportações e consultas operacionais continuam exigindo a autorização da própria empresa. Não há impersonação nem criação automática de membership. A chave privilegiada permanece no servidor.

O Master utiliza RPCs próprias para integrações; as APIs existentes da empresa e a recepção Respondi → Make → HIGH CLOSER são preservadas. Leituras não retornam tokens armazenados ou hashes. O novo token aparece somente na criação ou rotação, em memória. Diagnósticos Master omitem identificadores de leads, respostas dos formulários e dados pessoais. O envio de teste que cria oportunidade não é oferecido ao Master.

A exclusão administrativa preserva um recibo fora da cascata do workspace: identificador e nome da empresa, operador, horário, motivo e confirmações. Ela não exclui contas Supabase Auth nem dados de outras empresas. O fluxo existente de exclusão pelo administrador da própria empresa continua disponível.

## Implantação

O build de produção existente aplica migrations pendentes em transação e confere os checksums das versões instaladas. Publique o código e a migration juntos. Não edite migrations já aplicadas, nem conceda acesso genérico às tabelas ao Master.

Não são necessárias novas variáveis de ambiente, alteração de SMTP ou configuração manual de RLS. A concessão de Master continua seguindo o mecanismo administrativo existente de `platform_admins`; o aplicativo não permite autopromoção.

## Agendamento no Pipeline

Mover uma oportunidade para uma etapa NORMAL cujo nome corresponda exatamente a **Agendado** ou **Call agendada**, com normalização de maiúsculas e espaços, solicita data e horário no modal **Agendar call**. Isso vale para drag-and-drop e edição pelo seletor de etapas.

A confirmação grava etapa, `callDate` e comparecimento **Pendente** juntos na persistência existente. Cancelar não grava alterações; uma falha mantém o modal aberto. O histórico de calls permanece preservado e nenhum registro duplicado de call é criado pelo agendamento.

Não existe configuração de fuso por workspace na estrutura atual; o formulário mantém o padrão local do navegador usado pela aplicação e persiste o instante em formato ISO. **Calls → Próximas** exibe chamadas pendentes futuras, em ordem cronológica, e deixa de contá-las quando o horário passa.

## Validação da entrega

- Build TypeScript/Vite: passou. O aviso preexistente de chunk acima de 500 kB permanece; dependências não foram alteradas.
- Vitest: **387 testes passaram**, incluindo 14 novos testes dos serviços Master e 30 de agendamento.
- PostgreSQL 17 descartável: **1.187 verificações e 14 cenários de concorrência passaram**, incluindo 163 verificações Master e 22 de agendamento. Há fixtures de Master sem membership, administradores de duas empresas, manager, closer, viewer e conta desativada.
- As verificações reais incluem permissões das RPCs, requisições forjadas, RLS comercial, exportação/importação bloqueadas, projeção segura de logs/auditoria, tokens descartados, convites, planos, confirmação/concorrência de exclusão e preservação de Auth compartilhado. As nove migrations foram executadas; 001–008 não foram editadas.

Os testes de navegador abaixo utilizam respostas de Auth/REST simuladas para verificar a interface e as gravações solicitadas. A prova de autorização vem também do PostgreSQL real, não dessas simulações.

| Configuração Playwright | Casos |
| --- | ---: |
| `playwright.config.ts` | 10 |
| `playwright.saas.config.ts` | 44 |
| `playwright.features.config.ts` | 21 |
| `playwright.theme.config.ts` | 15 |
| `playwright.opportunity.config.ts` | 32 |
| `playwright.profile.config.ts` | 28 |
| `playwright.inbound.config.ts` | 17 |
| `playwright.premium.config.ts` | 12 |
| `playwright.master.config.ts` | 21 |
| `playwright.scheduling.config.ts` | 13 |

Total: **213 casos de interface**, com temas claro/escuro e telas mobile/desktop. Falhas transitórias de renderização durante alterações e execução concorrente foram reexecutadas sem afrouxar as verificações. Há 28 capturas Master com dados fictícios, incluindo Informações, Equipe, Plano, Integrações, Auditoria, Zona de perigo e o modal de exclusão em 1440 e 390 px.

## Produção verificada

- Commit funcional: `437dd208214eb0ea48f18da37a38046e0659f491`.
- Deployment Vercel `dpl_3nEc28uapVAgSY4twsUJRqoXE1LD`: **READY**, associado ao endereço canônico `https://closer-os-rho-three.vercel.app/`.
- O build nativo instalou somente a migration 009 em transação, conferiu as nove versões/checksums e as autorizações das 18 tabelas públicas. SHA256 da 009: `b346be11bc35dac1e3d75c7066d7190afe8fea3c4fa6480cd40c78a91e8210b8`.
- HTTPS retornou 200; os quatro assets públicos carregaram. Nenhuma credencial privilegiada foi encontrada nesses assets. Os três endpoints existentes conservaram o bloqueio de GET com 405.
- **85 verificações reais de Auth/REST/RLS e interface passaram**, sem respostas simuladas, erros de interface ou requisições de e-mail. Foram usados quatro usuários confirmados descartáveis e duas empresas temporárias; o Master de teste não recebeu membership.
- Validados: contato institucional e proteções de equipe/proprietário; aceite, reemissão e revogação de convite pelo banco; operações das integrações, webhook público e deduplicação; bloqueios de leitura/escrita/exportação/importação; logs/auditoria filtrados; suspensão e retomada; arraste/seletor, cancelamento, data passada, preenchimento inicial, duas confirmações gerando um único PATCH, horário local, Calls → Próximas e persistência após reload; exclusão concorrente e preservação de Auth compartilhado.
- O fluxo existente de exclusão pelo administrador da própria empresa também passou. A entrega SMTP não foi retestada: nenhum e-mail foi enviado nesta verificação, e o serviço existente não foi modificado.
- A limpeza confirmou a remoção dos quatro usuários Auth, da promoção Master temporária, das duas empresas e de seus registros dependentes. O recibo administrativo mínimo de uma exclusão foi mantido intencionalmente fora da cascata.
- O inventário protegido confirmou que os **547 registros originais nas 18 tabelas permanecem intactos**, sem resíduos de fixtures nessas tabelas. A comparação considera todos os campos originais, desconsiderando somente o novo campo institucional.

Não há configuração manual adicional no Supabase ou na Vercel para esta entrega. As limitações de classificação de empresas de teste e declaração de autorização estão descritas acima.

## Arquivos desta entrega

- `README.md`
- `docs/ADMINISTRACAO-MASTER.md`
- `docs/AGENDAMENTO-CALLS.md`
- `playwright.master.config.ts`
- `playwright.scheduling.config.ts`
- `scripts/provision-supabase.mjs`
- `scripts/test-database.sh`
- `src/components/Administration.tsx`
- `src/components/Calls.tsx`
- `src/components/InboundIntegrations.tsx`
- `src/components/LeadForm.tsx`
- `src/components/Pipeline.tsx`
- `src/components/StageTransitionModal.tsx`
- `src/components/administration-master.css`
- `src/lib/access-types.ts`
- `src/lib/access.ts`
- `src/lib/call-scheduling.ts`
- `src/lib/inbound-integrations.ts`
- `src/lib/inbound-types.ts`
- `src/lib/pipeline.ts`
- `supabase/migrations/202610120009_platform_company_administration.sql`
- `supabase/tests/call-scheduling.sql`
- `supabase/tests/platform-company-administration.sql`
- `tests/admin.spec.ts`
- `tests/call-scheduling.spec.ts`
- `tests/call-scheduling.test.ts`
- `tests/fixtures/master-admin.ts`
- `tests/fixtures/profile.ts`
- `tests/inbound.spec.ts`
- `tests/master-admin.spec.ts`
- `tests/master-services.test.ts`
- `tests/profile.spec.ts`
