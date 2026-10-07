# Backend do Closer OS

Este diretório contém a camada de contas, isolamento de empresas, convites e administração. A aplicação usa uma chave **pública** do Supabase no navegador. Senhas e sessões são gerenciadas pelo Supabase Auth; nenhum administrador recebe a senha de um cliente. Chaves `service_role`, de conexão PostgreSQL e administrativas nunca devem entrar em variáveis `VITE_*`, no Git ou em mensagens.

## Instalação em um projeto Supabase

1. Crie ou selecione um projeto Supabase sob a conta do proprietário do negócio. Conecte-o à Vercel pela integração oficial, ou configure as variáveis públicas indicadas no `.env.example`. Esta migration pressupõe o ambiente Supabase com os papéis `anon`, `authenticated`, `service_role`, a tabela `auth.users` e a função `auth.uid()`; o arquivo `tests/auth-stub.sql` é exclusivo do teste local.
2. Aplique as migrations pendentes **uma vez e em ordem**: `202610070001_closer_os.sql`, `202610070002_self_service_signup.sql` e `202610070003_invitation_details.sql`, por `supabase db push` em um projeto vinculado ou pelo SQL Editor. Cada migration é transacional; nunca edite uma versão já aplicada. Ela requer `pgcrypto` no schema `extensions`, como no provisionamento padrão do Supabase.
3. No SQL Editor, defina uma allowlist com o e-mail confirmado do proprietário inicial. O exemplo usa um endereço fictício que deve ser substituído antes de executar:

   ```sql
   update public.bootstrap_settings
   set allowed_emails = array['proprietario@seudominio.com.br'], enabled = true
   where id;
   ```

4. No Supabase Auth, mantenha a confirmação de e-mail habilitada, configure `Site URL` para o domínio real e os URLs de redirecionamento da aplicação para convites, confirmação e recuperação de senha. Configure SMTP próprio para entrega comercial confiável; o serviço padrão possui limites e restrições de destinatários. O cadastro de uma conta, sozinho, **não** concede acesso a um CRM.
5. A pessoa da allowlist cria a própria conta, confirma o e-mail e usa a configuração inicial. `setup_owner` verifica o e-mail diretamente em `auth.users`; dados enviados pelo navegador, metadados do usuário e variáveis públicas não podem conceder o privilégio inicial. A criação do primeiro administrador usa trava de tabela e desliga a allowlist ao concluir.
6. Configure variáveis públicas na Vercel, publique a aplicação e valide os fluxos com contas de teste de empresas diferentes. Ative MFA para as contas administrativas dos serviços e backups do banco no plano apropriado. Guarde uma cópia do código e teste a restauração antes de depender comercialmente dela.

Aplicar o SQL cria a estrutura, mas não configura domínio, SMTP, contrato comercial, emissão fiscal, backups gerenciados ou um gateway de pagamento. A cobrança implementada é **manual**: o operador confirma o recebimento fora do CRM e então altera a assinatura. Não existe confirmação automática de pagamentos nesta versão.

## Tabelas e isolamento

- `profiles`: perfil ligado a `auth.users`; um usuário altera somente seu próprio `display_name`. E-mail vem do Auth.
- `platform_admins` e `bootstrap_settings`: privilégio de operação e allowlist inicial. Clientes não podem alterar essas tabelas.
- `workspaces`, `workspace_settings`, `memberships`: empresas, metas/comissão e vínculo de cada pessoa. O proprietário da empresa deve ser um administrador ativo. A plataforma gerencia clientes e acessos; **não recebe acesso a leads por ser administradora**.
- `subscriptions`: plano `individual` ou `team`, limite de acessos e datas. Um novo cliente começa com `individual`, um assento e 14 dias de teste.
- `invitations`: somente hashes SHA-256 dos tokens de 256 bits. O token original aparece uma única vez na resposta de criação, para compor o link entregue ao destinatário. Não é armazenado nem incluído em auditoria.
- `leads`: chave composta `(workspace_id,id)`, responsável vinculado à empresa e payload JSON validado. IDs antigos podem ser preservados na migração. A base legal fica `NULL` até o administrador da empresa registrar a decisão apropriada; o sistema não presume legítimo interesse.
- `audit_logs`: eventos administrativos, IDs e contagens. Não guarda nomes de leads, contatos, resumos de calls, senhas ou tokens de convite.
- `policy_acceptances`: versões de termos e política aceitas pelo usuário, registradas separadamente e sem duplicar o mesmo aceite.

Todas as tabelas públicas têm RLS. Usuários anônimos não consultam dados de CRM. Administradores e gestores da empresa leem e editam os leads da empresa; closers leem e editam somente os leads atribuídos a si; leitores consultam os leads da empresa e não alteram dados. A exclusão individual de leads é exclusiva de administradores e gestores da empresa; closers não excluem nem os próprios leads. O cliente pode inserir apenas `workspace_id,id,owner_id,data` e atualizar somente `data,owner_id`. Alterações de ID/empresa também são bloqueadas por trigger. Auditoria, autoria, datas de banco e metadados legais não podem ser forjados por uma atualização direta do navegador.

Um gestor pode distribuir leads, listar sua equipe e alterar metas, mas não convidar pessoas, promover membros ou alterar cobrança. Administradores de uma empresa não administram outra. O operador da plataforma só acessa CRM quando é também um membro autorizado dessa empresa por um vínculo explícito; não existe bypass de leitura, importação, exportação ou exclusão de leads pelo papel da plataforma. A plataforma também não altera a política de privacidade da empresa nem transfere sua propriedade sem o vínculo autorizado correspondente.

## Contrato das RPCs

Os parâmetros abaixo usam os nomes exatos esperados por `supabase.rpc`. Exceto a prévia de convite, as funções exigem uma sessão autenticada. Os erros usam `42501` para autorização, `22023` para entrada inválida, `23514` para limites/invariantes, `23505` para duplicação e `P0002` para ausência de registro.

| RPC | Parâmetros | Resultado e autorização |
| --- | --- | --- |
| `bootstrap_owner` | nenhum | `boolean`; instalação inicial por e-mail confirmado na allowlist, ou chamada idempotente pelo operador já existente. |
| `setup_owner` | `p_name?` | `boolean`; mesma autorização e atualização opcional do nome. |
| `create_workspace` | `p_name`, `p_owner_name?` | UUID; somente plataforma. Cria empresa, configurações e teste individual de um assento. Não cria vínculo do operador. |
| `create_own_workspace` | `p_name`, `p_display_name`, `p_accept_terms` | UUID; usuário autenticado com e-mail confirmado e aceite explícito. Cria sua empresa individual privada uma vez, com teste de 14 dias e sem administração da plataforma. |
| `invite_member` | `p_workspace_id`, `p_email`, `p_role?`, `p_name?` | JSON `{id,name,email,role,token,expires_at}`; administrador da empresa ou plataforma. Reserva um assento. O primeiro convite deve ser `admin`. Reenviar revoga o token anterior, sem reservar dois assentos. |
| `list_invitation_preview` | `p_token` | JSON `{name,email,workspace_name,role,expires_at}` ou `null`; anônimos e autenticados, apenas por token válido. Não enumera convites. |
| `accept_invitation` | `p_token` | UUID da empresa; aceita uma única vez, somente pelo usuário com o e-mail correspondente confirmado. Verifica expiração, revogação, assinatura e limite de assentos. O primeiro administrador aceito vira proprietário. |
| `list_invitations` | `p_workspace_id` | Lista JSON com nome, aceite e estados pending/activated/expired/revoked/deactivated, sem token/hash; administrador da empresa ou plataforma. |
| `revoke_invitation` | `p_workspace_id`, `p_invitation_id` | `void`; administrador da empresa ou plataforma; libera a reserva de um convite pendente. |
| `list_members` | `p_workspace_id` | Lista JSON `{user_id,email,display_name,role,is_active}`; administrador, gestor ou plataforma. |
| `update_member` | `p_workspace_id`, `p_user_id`, `p_role`, `p_is_active` | `void`; administrador da empresa ou plataforma. Protege o proprietário/último administrador e verifica capacidade antes de reativar. |
| `transfer_workspace_owner` | `p_workspace_id`, `p_new_owner_id` | `void`; somente proprietário atual, com vínculo de administrador ativo; destino precisa ser um administrador ativo. |
| `list_platform_workspaces` | nenhum | Lista de empresa, proprietário e assinatura, `created_at` e quantidade de membros ativos; somente plataforma. Não inclui leads ou métricas de CRM. |
| `admin_update_subscription` | `p_workspace_id`, `p_plan`, `p_status`, `p_seat_limit`, `p_current_period_end?`, `p_trial_ends_at?` | `void`; somente plataforma. Planos `individual/team`; estados `trial/active/past_due/cancelled/suspended/expired`. Não reduz limite abaixo de membros ativos mais convites válidos. |
| `import_leads` | `p_workspace_id`, `p_leads`, `p_owner_id?` | JSON `{imported,skipped}`; usuário com edição do responsável indicado. Até 1.000 itens por lote. Valida todos antes de inserir; não sobrescreve IDs existentes. |
| `list_audit` | `p_workspace_id` | Até 200 eventos em JSON; administrador da empresa ou plataforma. |
| `export_workspace` | `p_workspace_id` | Backup JSON com leads, configurações e metadados de privacidade; **somente administrador ativo da empresa**, inclusive após vencimento/cancelamento de cobrança. A plataforma, leitores e closers não exportam o CRM completo. |
| `update_workspace_privacy` | `p_workspace_id`, `p_retention_days`, `p_privacy_contact_email` | `void`; **somente administrador da empresa**; configura prazo de 1–3.650 dias e contato. O novo prazo é aplicado aos novos registros; os prazos já registrados são preservados. |
| `record_lead_privacy` | `p_workspace_id`, `p_lead_id`, `p_lawful_basis`, `p_consent_at?`, `p_retention_until?` | `void`; **somente administrador da empresa**. Base opcional `consent/contract/legitimate_interest/legal_obligation`; `consent` exige data não futura. Prazo omitido usa criação + política atual. Disponível por RPC; não há editor de base legal por lead na interface desta versão. |
| `record_policy_acceptance` | `p_terms_version`, `p_privacy_version` | `void`; registra versões aceitas pela própria conta. |
| `purge_expired_leads` | `p_workspace_id` | Quantidade excluída; **somente administrador da empresa**, inclusive após vencimento. Exclui registros cujo `retention_until` já passou. |
| `delete_workspace` | `p_workspace_id`, `p_confirmation` | `void`; **somente administrador da empresa**. Exige o nome exato. Exclui definitivamente leads, configurações, vínculos, assinatura e convites da empresa; preserva somente eventos administrativos sem vínculo ao workspace excluído. |

A interface usa `cancelled`; o backend também. `expired`, quando recebido pela interface, deve ser apresentado como acesso suspenso. Não há uma tarefa diária necessária para bloquear assinaturas vencidas: a RLS consulta o relógio do banco em cada operação. `active` aceita período sem data para contrato manual sem prazo definido; com data, bloqueia ao vencer. `trial` exige `trial_ends_at` futuro e respeita também `current_period_end`, caso definido. Os demais estados bloqueiam o CRM. Metadados necessários para consultar a assinatura e os direitos de portabilidade do administrador permanecem disponíveis.

Os convites válidos ainda não aceitos também consomem assentos. Operações de convite, aceite, mudança de membros e cobrança usam uma trava no workspace, para impedir exceder o limite em requisições simultâneas. A desativação remove o acesso mesmo com um JWT já emitido: a RLS consulta o vínculo ativo no banco a cada requisição. O encerramento global de sessões de uma conta, caso necessário, é uma operação separada do Supabase Auth; não implica conhecer ou escolher a senha da pessoa.

## Privacidade e operação

O prazo de retenção é materializado em `leads.retention_until` quando o registro é criado. A operação `purge_expired_leads` é disponibilizada ao administrador; **não existe agendamento automático de exclusão**. Um agendamento futuro deve ser criado conscientemente e testado com os responsáveis do negócio. A base legal não substitui a avaliação do controlador nem os procedimentos de LGPD. Antes de vender, o proprietário deve preencher/revisar os textos comerciais, identificar o controlador, estabelecer um canal de suporte/privacidade e definir cancelamento, exportação e exclusão.

O backup por exportação é um complemento, não substitui backup PostgreSQL e teste de restauração. A exclusão de uma empresa não apaga a conta Supabase Auth da pessoa, que pode participar de outras empresas; os aceites da conta e eventos mínimos também permanecem. A exclusão de conta deve avaliar primeiro se ela é proprietária de alguma empresa ou responsável por registros, transferir a propriedade/atribuição quando necessário e só então remover a identidade. Não há uma RPC de exclusão de identidade nesta versão.

## Verificação local

Execute na raiz do repositório:

```bash
bash scripts/test-database.sh
```

O script usa PostgreSQL 17 em Docker, sem porta publicada e sem credenciais de produção. Reutiliza `closer-os-db-tests` quando disponível, ou cria um container temporário. Em ambos os casos cria **um banco novo com nome exclusivo**, aplica o stub de Auth, as migrations e testes, e exclui somente esse banco ao terminar. Não consulta variáveis de conexão da aplicação nem acessa o Supabase real. Um container que já existia é preservado.

Os testes executam consultas reais como `anon` e `authenticated`, não apenas procuram textos de policies. Incluem isolamento de empresas, CRUD por papel, proibição de elevação de privilégio e e-mail falso, payloads inválidos, importação atômica, limites e reenvio de convites, verificação de e-mail, expiração, exportação após bloqueio, metadados legais, purga, cascatas, propriedade, ACLs de funções/colunas/sequências e `search_path` das funções privilegiadas. Quatro cenários usam transações paralelas para disputar o último assento, aceitar o mesmo convite, revogar outro administrador e criar a mesma empresa própria. Resultado atual: **233 verificações**, incluindo nomes, estados de convite, cadastro próprio, idempotência, isolamento e concorrência.
