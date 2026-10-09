# Perfis e nomes no HIGH CLOSER

## Como usar

- **Minha conta → Editar nome:** qualquer usuário autenticado altera o próprio nome de exibição. O e-mail permanece somente para consulta. Os campos pessoais existentes foram reutilizados; não foram adicionados telefone, documento ou outros dados pessoais.
- **Administrar → Equipe → Editar nome:** ao editar a si mesmo, o administrador ativo usa a mesma atualização do nome pessoal de Minha conta. Ao editar outro membro, altera somente o nome exibido naquela empresa, preservando o perfil global e os aliases das outras empresas.
- **Administrar → Empresa → Editar nome da empresa:** o administrador ativo altera o nome da empresa selecionada.

Os formulários identificam campos editáveis, confirmam o salvamento e permitem tentar novamente após uma falha. A interface mantém os tokens dos temas claro e escuro, com suporte a telas móveis e teclado.

## Consistência do nome pessoal — correção 007

O nome pessoal tem como fonte de leitura `profiles.display_name`, carregado em `snapshot.displayName`. O cabeçalho de Minha conta e o campo Nome de exibição usam esse mesmo valor. O nome no workspace continua resolvendo `memberships.display_name` com fallback para o perfil; um alias da empresa não substitui o nome pessoal na página da conta. Metadados antigos da sessão Auth não sobrescrevem um nome válido do perfil.

A autoedição em Administração → Equipe delega a `updateMyDisplayName`, como Minha conta. A RPC `update_my_display_name` atualiza somente o nome nos metadados Auth; o trigger existente espelha essa atualização em `profiles`, sem um segundo caminho de escrita ou sincronização circular. O alias do próprio usuário é limpo apenas na empresa selecionada, que passa a acompanhar o nome pessoal; aliases de outras empresas permanecem preservados. Após salvar, o acesso e a lista de membros são recarregados para atualizar a interface sem exigir novo login.

A inicialização também tinha um caminho concorrente: `setup_owner(p_name)` copiava o nome da sessão diretamente para o perfil em cada acesso do proprietário. A interface agora passa `p_name: null`; a migration 007 impede que clientes antigos sobrescrevam um perfil preenchido. O parâmetro legado continua podendo semear somente um perfil vazio, usando o mesmo sentido Auth → trigger → perfil, com os controles de bootstrap e permissões anteriores.

A leitura pós-salvamento tem prioridade: respostas anteriores são ignoradas e atualizações automáticas aguardam a mesma leitura antes de confirmar sucesso. Se a gravação persistir e a atualização da tela falhar, a mensagem distingue essas duas situações; Atualizar acesso relê o perfil sem repetir a edição.

A migration `202610090007_canonical_self_member_names.sql` protege também chamadas diretas: depois de verificar o administrador ativo, `update_member_display_name` delega à RPC pessoal quando o alvo é o próprio usuário e o nome não é `NULL`. Para outro membro, continua alterando somente o alias da empresa, sem escrever em seu perfil ou Auth. `NULL` mantém a operação explícita de limpar somente o alias. As permissões e políticas RLS existentes são preservadas.

Em 09/10/2026, o build passou, assim como 195 testes unitários, 44 fluxos SaaS/Admin e a suíte final de 28 fluxos de perfil no navegador. Os testes de navegador usam respostas HTTP simuladas e persistentes: cobrem o bug original, recarga, logout e novo login com metadados antigos, alias de terceiros, falhas de leitura e respostas concorrentes. O PostgreSQL descartável aprovou 730 verificações, incluindo 91 regressões novas de nomes e as cinco verificações de concorrência existentes. As migrations 001–006 permanecem intactas; o SHA256 da 007 é `90729ed1255c666d5c956363c7da0c1492e449932f819b88089bc7d0136dd3f6`.

Publicado em 09/10/2026 no deployment `dpl_DX4nkpVJsK5qgCT52xGCv17MNG1N`, estado READY, fonte `de3812ba16c5592ec9219be2e42fed0fd91ab8bf`, no alias https://closer-os-rho-three.vercel.app/. O builder aplicou a 007 em transação, conferiu as sete versões/checksums e manteve RLS nas 16 tabelas. HTML e assets retornaram HTTP 200; nenhum segredo administrativo foi encontrado nos assets públicos, e as APIs de convite mantiveram o bloqueio GET 405.

O smoke real no Supabase e no navegador publicado aprovou 41 verificações, incluindo 27 de backend: autoedição pelo Admin e por Minha conta, nome consistente em cabeçalho/campo/equipe/CRM, persistência após recarga e novos logins reais, bloqueio de edição de terceiros por gestor/closer/viewer, nomes locais de outros membros, aliases de outras empresas e proteção de `setup_owner` contra nome antigo de sessão. Claro/escuro e desktop/mobile também foram conferidos. Não foram enviados e-mails nem registrados erros de execução no navegador. As quatro contas, duas empresas e a permissão temporária de teste foram removidas, com confirmação da limpeza.

O cadastro do proprietário foi conferido separadamente e já apresenta “Áquila Rosendo” no perfil, nos metadados Auth e no alias da empresa selecionada. Não houve promoção automática de aliases dos demais usuários ou empresas. A correção não exige novas variáveis, alteração de SMTP, redirecionamentos ou SQL manual nesta implantação; bootstrap, permissões, RLS e funcionalidades comerciais permanecem com suas regras anteriores.

Arquivos desta correção: `src/SaaSApp.tsx`, `src/components/AccountProfile.tsx`, `src/components/Administration.tsx`, `src/lib/access.ts` (comentário sobre a fonte de leitura), `supabase/migrations/202610090007_canonical_self_member_names.sql`, `supabase/tests/account-names.sql`, `tests/profile.spec.ts`, `tests/fixtures/profile.ts` e este documento. As evidências datadas nas seções seguintes pertencem à implementação inicial da migration 005.

## Permissões e isolamento

| Operação | Quem pode executar |
| --- | --- |
| Editar o próprio nome pessoal | Qualquer conta autenticada, identificada pelo servidor |
| Editar nome de um membro na empresa | Administrador ativo dessa empresa |
| Editar nome da empresa | Administrador ativo dessa empresa |
| Alterar papéis/permissões | As permissões anteriores da aplicação, sem ampliação |
| Alterar e-mail pelo perfil | Não disponível |

Gestor, closer e visualizador não recebem permissão para alterar nomes de outros membros ou da empresa. O papel de administrador da plataforma, por si só, não autoriza as novas edições. As consultas administrativas anteriormente permitidas continuam com o mesmo escopo; não foram adicionadas leituras de dados pessoais ou comerciais.

## Banco e estruturas reutilizadas

A migration `202610080005_account_names.sql` adiciona uma coluna opcional `memberships.display_name`, sem criar tabelas. Os registros antigos permanecem com `NULL` nessa coluna e continuam exibindo o nome existente de `profiles.display_name`.

Três RPCs autenticadas fazem a validação no servidor:

- `update_my_display_name(p_display_name, p_workspace_id)`: usa somente `auth.uid()` como identidade. Mantém o trigger existente de sincronização entre `auth.users` e `profiles`, alterando apenas o nome nos metadados pessoais. Se houver empresa selecionada, exige vínculo ativo e limpa somente o alias do próprio usuário nessa empresa. Aliases de outras empresas são preservados.
- `update_member_display_name(p_workspace_id, p_user_id, p_display_name)`: exige vínculo de administrador ativo na empresa informada. Com a correção 007, a autoedição de um nome não nulo delega à atualização pessoal; a edição de outro membro continua restrita ao alias daquele vínculo, preservando seu perfil global e Auth.
- `rename_workspace(p_workspace_id, p_name)`: exige administrador ativo e altera somente `workspaces.name`. `workspace_settings.name` continua sendo a configuração de apresentação preexistente; metas, comissão e demais configurações são preservadas.

`list_members` resolve o nome específico da empresa com fallback para o perfil, mantendo exatamente a autorização de leitura anterior. Nenhuma política RLS ou permissão de escrita direta em `memberships` foi ampliada. As novas ações são auditadas com identificadores, sem armazenar o texto dos nomes no evento.

Nomes pessoais e de membros aceitam 2–120 caracteres; o nome da empresa aceita 1–120. Espaços nas extremidades são removidos e caracteres de controle são rejeitados. O contexto da empresa é validado antes de qualquer atualização do nome pessoal, evitando uma alteração parcial em pedidos não autorizados.

As migrations 001–004 permanecem imutáveis. O checksum da migration 005 é `d58b537d7c2785fb77a8301a655813b31923ad35a061995292e17a46770bf006`.

## Validação local da implementação inicial (005)

```bash
npm test
npm run build
npm run test:saas
npx playwright test --config=playwright.theme.config.ts
npx playwright test --config=playwright.profile.config.ts
npm run test:db
```

Em 08/10/2026 passaram 129 testes unitários, 44 fluxos SaaS/Admin, 15 testes dos temas e 20 novos fluxos de perfil/Admin. O PostgreSQL descartável aprovou 442 verificações, incluindo 121 novas para nomes e as suítes concorrentes existentes. Os novos testes de interface usam respostas simuladas; os testes SQL verificam as permissões reais das funções e tabelas.

## Publicação da implementação inicial (005)

O provisionador existente aplica somente a migration pendente, com transação, checksum e trava contra builds concorrentes. O frontend usa exclusivamente a chave pública e a sessão autenticada. Nenhuma chave administrativa é incorporada ao navegador.

Esta alteração não exige novas variáveis, SMTP, URLs de redirecionamento ou configurações de login. Login, convites, recuperação de senha, pipeline, calls, métricas e assinaturas mantêm sua lógica anterior.

Em 08/10/2026, a versão `c235d91a455ac2aeb50801755edef96d71adda77` foi publicada no deployment `dpl_HkNpZgAPz6saUZ26QzEU15Pz4obp`, em estado READY, no endereço https://closer-os-rho-three.vercel.app/. O builder confirmou a aplicação transacional da migration 005, os checksums das cinco versões e RLS ativo nas 14 tabelas. O HTML e os assets retornaram HTTP 200; as APIs de convite existentes mantiveram o bloqueio GET 405. O JavaScript publicado contém as novas RPCs e não contém as credenciais privadas verificadas.

O SDK real do Supabase aprovou 189 verificações de Auth/REST/RLS, incluindo nome próprio, aliases independentes em duas empresas, alteração de nome da empresa, bloqueios por papel e preservação de e-mail/metadados/permissões/configurações. As sete contas e duas empresas temporárias foram removidas, com conferência da limpeza no Auth e nas tabelas relacionadas. Nenhum e-mail foi enviado nesse ensaio.

No navegador publicado, passaram oito grupos de verificações reais, sem mocks: os quatro papéis editaram somente o próprio nome, com e-mail somente para consulta, atualização de avatar e persistência após recarregar; o administrador editou o nome de outro membro exclusivamente na sua empresa e o nome da empresa. A segunda empresa e as configurações comerciais permaneceram intactas. Claro/escuro e desktop/mobile foram conferidos, sem erros de execução ou requisições de envio de e-mail. As duas empresas e quatro contas desse ensaio, suas linhas relacionadas e o perfil temporário do navegador foram removidos.

A comparação do estado anterior e posterior à migração confirmou a preservação dos registros das dez tabelas verificadas: empresas, perfis, vínculos, configurações, leads, pipelines, etapas, revisões de calls, assinaturas e administradores da plataforma. Não é necessário executar SQL ou configurar o Supabase manualmente nessa implantação.

## Arquivos da implementação

- Interface: `src/SaaSApp.tsx`, `src/components/AccountProfile.tsx`, `src/components/account-profile.css`, `src/components/Administration.tsx`, `src/components/administration-names.css`.
- Acesso: `src/lib/access.ts`, `src/lib/access-types.ts`.
- Banco: `supabase/migrations/202610080005_account_names.sql`; correção de autoedição em `supabase/migrations/202610090007_canonical_self_member_names.sql`.
- Testes: `tests/access-services.test.ts`, `tests/profile.spec.ts`, `tests/fixtures/profile.ts`, `playwright.profile.config.ts`, `supabase/tests/account-names.sql`, `scripts/test-database.sh`, `scripts/test-live.mjs`.
- Documentação: este arquivo e a referência no `README.md`.
