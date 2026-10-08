# Perfis e nomes no HIGH CLOSER

## Como usar

- **Minha conta → Editar nome:** qualquer usuário autenticado altera o próprio nome de exibição. O e-mail permanece somente para consulta. Os campos pessoais existentes foram reutilizados; não foram adicionados telefone, documento ou outros dados pessoais.
- **Administrar → Equipe → Editar nome:** o administrador ativo da empresa altera o nome exibido por um membro naquela empresa. A identificação global da conta e o nome usado em outras empresas não são modificados.
- **Administrar → Empresa → Editar nome da empresa:** o administrador ativo altera o nome da empresa selecionada.

Os formulários identificam campos editáveis, confirmam o salvamento e permitem tentar novamente após uma falha. A interface mantém os tokens dos temas claro e escuro, com suporte a telas móveis e teclado.

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
- `update_member_display_name(p_workspace_id, p_user_id, p_display_name)`: exige vínculo de administrador ativo na empresa informada e altera apenas o nome daquele vínculo. Não altera o perfil global nem os metadados Auth do membro.
- `rename_workspace(p_workspace_id, p_name)`: exige administrador ativo e altera somente `workspaces.name`. `workspace_settings.name` continua sendo a configuração de apresentação preexistente; metas, comissão e demais configurações são preservadas.

`list_members` resolve o nome específico da empresa com fallback para o perfil, mantendo exatamente a autorização de leitura anterior. Nenhuma política RLS ou permissão de escrita direta em `memberships` foi ampliada. As novas ações são auditadas com identificadores, sem armazenar o texto dos nomes no evento.

Nomes pessoais e de membros aceitam 2–120 caracteres; o nome da empresa aceita 1–120. Espaços nas extremidades são removidos e caracteres de controle são rejeitados. O contexto da empresa é validado antes de qualquer atualização do nome pessoal, evitando uma alteração parcial em pedidos não autorizados.

As migrations 001–004 permanecem imutáveis. O checksum da migration 005 é `d58b537d7c2785fb77a8301a655813b31923ad35a061995292e17a46770bf006`.

## Validação local

```bash
npm test
npm run build
npm run test:saas
npx playwright test --config=playwright.theme.config.ts
npx playwright test --config=playwright.profile.config.ts
npm run test:db
```

Em 08/10/2026 passaram 129 testes unitários, 44 fluxos SaaS/Admin, 15 testes dos temas e 20 novos fluxos de perfil/Admin. O PostgreSQL descartável aprovou 442 verificações, incluindo 121 novas para nomes e as suítes concorrentes existentes. Os novos testes de interface usam respostas simuladas; os testes SQL verificam as permissões reais das funções e tabelas.

## Publicação

O provisionador existente aplica somente a migration pendente, com transação, checksum e trava contra builds concorrentes. O frontend usa exclusivamente a chave pública e a sessão autenticada. Nenhuma chave administrativa é incorporada ao navegador.

Esta alteração não exige novas variáveis, SMTP, URLs de redirecionamento ou configurações de login. Login, convites, recuperação de senha, pipeline, calls, métricas e assinaturas mantêm sua lógica anterior.

Em 08/10/2026, a versão `c235d91a455ac2aeb50801755edef96d71adda77` foi publicada no deployment `dpl_HkNpZgAPz6saUZ26QzEU15Pz4obp`, em estado READY, no endereço https://closer-os-rho-three.vercel.app/. O builder confirmou a aplicação transacional da migration 005, os checksums das cinco versões e RLS ativo nas 14 tabelas. O HTML e os assets retornaram HTTP 200; as APIs de convite existentes mantiveram o bloqueio GET 405. O JavaScript publicado contém as novas RPCs e não contém as credenciais privadas verificadas.

O SDK real do Supabase aprovou 189 verificações de Auth/REST/RLS, incluindo nome próprio, aliases independentes em duas empresas, alteração de nome da empresa, bloqueios por papel e preservação de e-mail/metadados/permissões/configurações. As sete contas e duas empresas temporárias foram removidas, com conferência da limpeza no Auth e nas tabelas relacionadas. Nenhum e-mail foi enviado nesse ensaio.

No navegador publicado, passaram oito grupos de verificações reais, sem mocks: os quatro papéis editaram somente o próprio nome, com e-mail somente para consulta, atualização de avatar e persistência após recarregar; o administrador editou o nome de outro membro exclusivamente na sua empresa e o nome da empresa. A segunda empresa e as configurações comerciais permaneceram intactas. Claro/escuro e desktop/mobile foram conferidos, sem erros de execução ou requisições de envio de e-mail. As duas empresas e quatro contas desse ensaio, suas linhas relacionadas e o perfil temporário do navegador foram removidos.

A comparação do estado anterior e posterior à migração confirmou a preservação dos registros das dez tabelas verificadas: empresas, perfis, vínculos, configurações, leads, pipelines, etapas, revisões de calls, assinaturas e administradores da plataforma. Não é necessário executar SQL ou configurar o Supabase manualmente nessa implantação.

## Arquivos da implementação

- Interface: `src/SaaSApp.tsx`, `src/components/AccountProfile.tsx`, `src/components/account-profile.css`, `src/components/Administration.tsx`, `src/components/administration-names.css`.
- Acesso: `src/lib/access.ts`, `src/lib/access-types.ts`.
- Banco: `supabase/migrations/202610080005_account_names.sql`.
- Testes: `tests/access-services.test.ts`, `tests/profile.spec.ts`, `tests/fixtures/profile.ts`, `playwright.profile.config.ts`, `supabase/tests/account-names.sql`, `scripts/test-database.sh`, `scripts/test-live.mjs`.
- Documentação: este arquivo e a referência no `README.md`.
