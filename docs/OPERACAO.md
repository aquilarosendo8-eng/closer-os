# Operação do Closer OS

Este roteiro acompanha o código do repositório. A existência do código de nuvem não confirma que um projeto Supabase, suas políticas ou um deploy foram configurados. Registre a conclusão de cada etapa no seu ambiente antes de liberar clientes.

## Modos de uso

- **Acesso indisponível/demonstração:** sem a configuração de nuvem, a tela de acesso informa que o workspace está em preparação. A demonstração usa dados fictícios e não dá acesso a dados de clientes.
- **Dados locais da versão anterior:** leads e configurações existentes continuam no armazenamento do navegador. Quando a configuração de nuvem está ausente, a tela de preparação oferece download explícito de backup. Com a nuvem configurada, a tela de login não lê nem exibe os dados legados; a migração ocorre pela importação após autenticação, para a empresa selecionada. Os originais não são enviados automaticamente nem removidos.
- **Nuvem:** a aplicação usa Supabase Auth e PostgreSQL. Cada cliente trabalha em um workspace, com associação e papel próprios. A autorização dos dados deve ser aplicada pelas funções e políticas RLS do banco, além das restrições da interface.

O frontend é uma SPA construída com Vite. A Vercel publica os arquivos de `dist` e hospeda a API de envio de convites; o banco e a autenticação ficam no Supabase. A API usa a credencial administrativa somente no servidor e verifica a autorização de quem está enviando.

## Preparar o ambiente

1. Use Node.js 24 para o provisionamento/build de nuvem e execute `npm ci` no checkout existente. O frontend isolado aceita Node.js 22.12 ou superior.
2. Crie um projeto Supabase dedicado ao ambiente. Separe homologação e produção.
3. Provisione a migration versionada antes de liberar o frontend conectado, pelo procedimento abaixo. Confira o projeto de destino; uma conexão de integração não instala o schema automaticamente.
4. Confira no banco as tabelas, funções e políticas criadas. Teste a autorização com contas de clientes diferentes; acessar a interface como administrador não valida o isolamento.
5. Configure a autenticação por email e senha no Supabase Auth. Mantenha a confirmação de e-mail obrigatória e configure o mínimo de senha do provedor para 12 caracteres, compatível com a interface. O cadastro de e-mail é necessário ao fluxo de convite; uma conta sem vínculo autorizado não acessa o CRM. Configure as URLs conforme a seção abaixo.
6. Configure a entrega de e-mails de convite, confirmação e recuperação no Supabase. A aplicação solicita o envio automaticamente ao gerar o convite; copiar o link continua disponível como alternativa. Os limites, remetente e entrega dependem do serviço de e-mail configurado.

As credenciais de acesso ao projeto, ao banco e à hospedagem pertencem ao operador. Não são necessárias chaves administrativas de banco no navegador.

### Provisionamento e primeiro administrador

Use Node.js 24. O script aceita um arquivo de ambiente protegido **fora do checkout**, contendo a URL/chave pública, uma chave administrativa exclusiva do servidor e a conexão PostgreSQL do projeto. Os aliases da integração constam em `.env.example`. Sem conexão direta, `SUPABASE_ACCESS_TOKEN` permite executar SQL pela API de administração do Supabase. Não envie esses valores por chat nem os copie para variáveis públicas.

```bash
npm run db:provision -- \
  --env-file /caminho/seguro/closer-os.env \
  --owner-email proprietario@seudominio.com.br \
  --app-url https://closer-os-rho-three.vercel.app/ \
  --invite-owner
```

O endereço acima é ilustrativo: use o e-mail real do dono, obtido e configurado pelo operador. A instalação aplica a migration em transação, registra versão/checksum e verifica RLS nas 11 tabelas públicas. Ela autoriza somente o e-mail informado para o bootstrap e, com `--invite-owner`, pede ao Supabase Auth o envio do convite de ativação. O destinatário define a própria senha. A entrega desse convite depende das configurações Auth/SMTP; o convite não é uma senha definida pelo operador.

Na Vercel, `npm run build:cloud` executa o provisionamento antes de `npm run build`, usando as variáveis protegidas do builder. `CLOSER_OWNER_EMAIL` e `CLOSER_APP_URL` identificam o proprietário e o domínio; são configurações do servidor, sem prefixo `VITE_`. A integração fornece as credenciais de conexão/autenticação necessárias. **O build normal não passa `--invite-owner` e não reenvia e-mail a cada publicação.** O envio inicial de ativação é uma etapa explícita, após conferir as URLs do Auth e a entrega de e-mail.

O schema do projeto conectado foi instalado por esse procedimento no builder da Vercel. Instalações seguintes conferem todos os checksums em `private.schema_migrations` e as regras RLS. O script instala migrations pendentes em ordem, cada uma em transação com seu registro. Recusa checksums divergentes, lacunas e versões ausentes do checkout; builders PostgreSQL são serializados por advisory lock. Falhas de provisionamento impedem a publicação da nova versão. Não edite uma migration já aplicada; mudanças de schema exigem nova migration e evolução controlada do provisionamento. Reverter o frontend não reverte alterações do banco.

O script verifica a cadeia e o nome do servidor PostgreSQL. Usa as raízes do sistema e o certificado público Supabase Root 2021; a origem e a impressão digital estão em [scripts/certs/README.md](../scripts/certs/README.md). `CLOSER_DB_CA_FILE` permite uma substituição validada quando o fornecedor rotacionar o certificado. Se um ambiente de nuvem bloquear o protocolo PostgreSQL, execute o provisionamento no builder autorizado ou use a API de administração com credencial protegida. Não desative a verificação TLS para contornar falhas de conexão.

Ao acessar com e-mail confirmado, `setup_owner` verifica a allowlist diretamente no banco e configura o primeiro administrador da plataforma. O bootstrap é fechado ao concluir. O proprietário da plataforma pode criar empresas, mas não recebe vínculo ou acesso automático aos leads delas. Para usar seu próprio CRM, pode concluir o cadastro da própria empresa por `create_own_workspace` ou aceitar um convite de administrador para uma empresa criada pela operação.

Uma verificação posterior, sem alteração de contas ou dados:

```bash
npm run db:provision -- --env-file /caminho/seguro/closer-os.env --check-only
```

O script não reaplica um schema com checksum divergente nem assume a propriedade de tabelas preexistentes sem registro. Para um projeto instalado manualmente pelo SQL Editor/CLI, siga [Backend](../supabase/README.md) e revise o controle de versão antes de usar o script. Não recrie tabelas nem use um procedimento destrutivo para contornar essa proteção.

### URLs e entrega de e-mails

No dashboard do projeto Supabase, em **Authentication → URL Configuration**, use `https://closer-os-rho-three.vercel.app/` como Site URL enquanto esse for o domínio vigente. Autorize os redirecionamentos do mesmo domínio, incluindo:

- A raiz da aplicação.
- `/?flow=activate`, usado pela ativação inicial.
- `/?flow=recovery`, usado pela recuperação de senha.
- `/?invite=…`, usado pela confirmação de e-mail para um convite de empresa.
- `/?signup=1`, usado pela confirmação do cadastro aberto.
- Recuperações em convite preservam `invite` e `login=1` junto de `flow=recovery`.

Uma regra `https://closer-os-rho-three.vercel.app/**`, quando necessária ao formato de redirecionamento aceito pelo Supabase, deve ficar limitada a esse domínio. Não autorize todos os domínios Vercel. Adicione `http://localhost:5173/**` somente no ambiente de desenvolvimento e o domínio específico de homologação no projeto correspondente. Ao adotar domínio próprio, atualize Site URL, redirecionamentos e `CLOSER_APP_URL`, publique e teste os links de e-mail novamente.

Configure o remetente e SMTP conforme [SMTP do Supabase](https://supabase.com/docs/guides/auth/auth-smtp), incluindo a autenticação de domínio exigida pelo fornecedor. O serviço padrão possui limites e restrições de destinatários; não presuma que atende todos os clientes. Teste confirmação, ativação e recuperação na caixa de entrada do destinatário.

Convites iniciais enviados pelo Supabase Auth podem retornar tokens de sessão no fragmento da URL. A aplicação valida esse callback de convite/recuperação e permite definir a senha, inclusive ao abrir o link em outro navegador. Um parâmetro `flow` sozinho não cria sessão nem autoriza alteração de senha. A confirmação do cadastro iniciado por um convite de empresa usa PKCE: nesse caso, abra o link no mesmo navegador usado para iniciar a criação da conta.

### Cadastro próprio e convite manual

O cadastro público em `?signup=1` usa Supabase Auth com PKCE. Depois da confirmação, a pessoa informa/confirma os dados e o aceite para `create_own_workspace`. A RPC verifica e-mail confirmado, cria empresa com owner/admin atual e teste individual de 14 dias, e registra os documentos aceitos. Um registro privado e trava por perfil tornam a criação idempotente e impedem reiniciar o teste após excluir a empresa. Metadados de cadastro não atribuem papéis nem administração da plataforma.

Copiar link usa `/api/invitation-link`. Depois da autorização do convidante e reserva de assento pela RPC, a API tenta criar uma identidade Auth sem senha e sem confirmação, de forma atômica. Somente uma identidade nova criada nessa chamada pode receber o link Auth de ativação; seu UUID é conferido na resposta do provedor. Qualquer conta existente, confirmada ou não, recebe apenas o convite CRM com `login=1` e usa a própria senha. Tokens de login de contas existentes nunca são entregues ao convidante.

Gerar link ou reenviar cria um novo convite e invalida o anterior; o Admin informa essa substituição. O token CRM dura 7 dias, mas o link Auth pode expirar antes conforme o provedor. A página explica a expiração e orienta pedir outro ao administrador; o Admin oferece reenvio ou geração de novo link. Recuperar senha a partir do convite mantém seu contexto e retorna à empresa depois do aceite.

Se criar a nova identidade funciona e gerar o link falha, a API cancela apenas o convite CRM. A conta não é apagada automaticamente, pois pode ter avançado em outro fluxo. O destinatário precisará da ativação/recuperação por e-mail; o fallback manual não elimina a necessidade de SMTP nesses casos.

## Configuração do frontend

Defina estas variáveis na Vercel ou em um arquivo local ignorado pelo Git:

```dotenv
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=SUA-CHAVE-PUBLICA
VITE_SUPPORT_EMAIL=suporte@SEU-DOMINIO
```

`VITE_SUPABASE_ANON_KEY` é o alias compatível com a chave pública legada `anon`; prefira `VITE_SUPABASE_PUBLISHABLE_KEY` para uma chave publishable. Não defina as duas com chaves diferentes. O build também reconhece `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` e as chaves públicas `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_ANON_KEY` ou `NEXT_PUBLIC_SUPABASE_ANON_KEY` da integração Vercel. O build rejeita chaves administrativas no campo público.

`VITE_SUPPORT_EMAIL` é opcional e informa o canal de suporte na interface; preencha um endereço real antes de atender clientes. Variáveis `VITE_*` são incorporadas ao JavaScript público durante o build. Nunca coloque `service_role`, chave secreta, senha do banco ou credenciais SMTP nesses campos.

Depois de alterar uma variável do Vite na Vercel, gere um novo deploy. Verifique se o site mostra o modo de nuvem e se autentica no projeto esperado.

```bash
npm test
npm run build
npm run test:e2e
npm run test:saas
npm run test:db
```

Os testes locais de frontend não substituem a validação do Supabase. Os testes de navegador usam Chromium; consulte `README.md` para a configuração do browser.

### Verificação real do projeto conectado

`scripts/test-live.mjs` foi executado no projeto Supabase conectado com 59 verificações de autenticação, REST e RLS. Usou contas/empresas temporárias identificadas, sem envio de e-mails, e removeu essas fixtures ao concluir. Conferiu login real, convites, papéis, isolamento, persistência após novo login, distribuição de leads, suspensão e desativação com sessões existentes.

Para repetir somente em um projeto que você administra e autoriza a receber as fixtures de teste:

```bash
node --use-system-ca --use-env-proxy scripts/test-live.mjs \
  --env-file /caminho/seguro/closer-os.env
```

Esse script exige chave pública e chave administrativa do servidor em arquivo protegido fora do checkout. Não é um teste somente de leitura: cria registros temporários e faz limpeza delimitada a eles. Não publica chaves, senhas, sessões, tokens de convite ou dados comerciais nos resultados. Confira a conclusão da limpeza e mantenha a autorização/registro da execução. Uma prova de Auth/RLS não confirma Site URL, redirecionamentos, entrega SMTP, pagamentos ou recuperação de banco; valide esses fluxos separadamente no domínio publicado.

## Publicar na Vercel

1. Importe `aquilarosendo8-eng/closer-os`, mantendo a raiz do repositório.
2. Configure Node.js 24, instalação `npm ci`, build `npm run build:cloud` e saída `dist`, conforme `vercel.json`. O build de produção exige as configurações protegidas do banco e do proprietário; `npm run build` isoladamente continua disponível para testar apenas o frontend local.
3. Configure as variáveis públicas e de provisionamento no ambiente correto e publique. As credenciais administrativas são usadas pelo provisionamento e pelas APIs de convite no servidor, após a autorização da requisição; não são incorporadas no JavaScript público.
4. Adicione o domínio publicado às URLs permitidas do Supabase Auth. Teste links de recuperação e convite no domínio final, inclusive ao abri-los diretamente.
5. Guarde o identificador do deploy e a versão de migrações usada. Uma reversão de frontend não desfaz migrações nem alterações dos dados.

## Administrar clientes e equipes

O administrador da **plataforma** provisiona workspaces e mantém as assinaturas. O administrador de um **workspace** administra sua própria equipe. São responsabilidades diferentes; o papel `admin` de um cliente não concede acesso administrativo à plataforma.

A atribuição inicial de administrador da plataforma é uma operação do responsável pelo banco. Use o procedimento de bootstrap em `supabase/README.md` e o script de provisionamento documentado pelo repositório. A permissão de `setup_owner`/`bootstrap_owner` é restrita ao email autorizado em `bootstrap_settings.allowed_emails`; o usuário precisa existir no Supabase Auth, ter email confirmado e autenticar-se. A primeira configuração fecha o bootstrap. Não exponha uma chave privilegiada no frontend nem disponibilize autoatribuição pública de administrador.

Papéis disponíveis:

| Papel | Uso previsto |
| --- | --- |
| `admin` | Gestão dos membros e de todos os leads da própria empresa. |
| `manager` | Consulta/edição de leads da empresa, distribuição de responsáveis, metas e consulta da equipe. Não convida/promove membros nem altera cobrança. |
| `closer` | Consulta e operação de seus próprios leads; a propriedade é validada no backend. |
| `viewer` | Consulta dos leads da própria empresa, sem alteração de dados do CRM. |

Consulte as migrações para os limites efetivos de cada papel e para quem pode atribuir leads a outros membros. O administrador da plataforma consulta metadados comerciais e gerencia assinaturas; não recebe acesso aos leads de um cliente apenas por esse papel. Para acesso ao CRM, é necessária uma associação autorizada ao workspace.

Ao convidar alguém, confira e-mail, papel e empresa. O sistema registra o convite e solicita o envio por e-mail ao Supabase Auth pela API do servidor. Para uma pessoa nova, o e-mail de ativação permite definir a própria senha; para uma conta já existente, o provedor envia um link de acesso ao convite. Copiar o link continua sendo uma opção adicional. Não compartilhe a mensagem nem o link com terceiros.

O token de convite da empresa é apresentado apenas na criação; o banco armazena seu hash. A validade padrão é de sete dias. Regenerar um convite para o mesmo e-mail revoga o anterior e mantém uma única reserva de assento. O aceite exige sessão autenticada com o e-mail confirmado correspondente, convite válido e assento disponível; receber o e-mail não equivale a uma associação ativa.

Confira o resultado do envio na interface. Uma falha de SMTP não é apresentada como sucesso. A opção independente Copiar link do convite usa outra chamada protegida do backend e não envia e-mail; pode ser usada mesmo após falha de envio. A aceitação pelo provedor não garante recebimento na caixa de entrada. Se o envio for recusado por limite ou destinatário, confira SMTP, remetente e URLs do Auth antes de reenviar. Gmail SMTP aceita host smtp.gmail.com, porta 465, usuário igual ao remetente e senha de app do Google; não use a senha normal da conta. A senha fica no Supabase, não nas variáveis públicas da Vercel. Não exponha a chave administrativa nem defina uma senha em nome do destinatário para contornar o problema.

Em caso de falha, a API tenta revogar somente o convite recém-criado, pelo ID correspondente, liberando sua reserva de assento sem revogar outro convite mais recente. Se essa limpeza também falhar, a interface informa que é necessário revogar o convite pendente antes de tentar novamente. Atualize a lista e confira o estado antes de repetir.

Se o erro ocorrer ao criar uma empresa e enviar seu primeiro convite, a empresa já criada é preservada. A interface abre essa empresa e prepara o reenvio ao administrador: repita o convite ali, em vez de criar outra empresa. As mensagens são apresentadas em português, incluindo recusa de permissão, limite de assentos, limite de envio e indisponibilidade do serviço.

Revogue convites incorretos, desative membros que saíram da equipe e revise periodicamente os acessos. O limite de assentos considera membros ativos e convites ainda válidos, não aceitos e não revogados. O banco impede reduzir o limite abaixo dessa ocupação.

Consulte a trilha de auditoria disponível. A API administrativa retorna os últimos 200 eventos do workspace. Os eventos registram identificadores e ações, inclusive alterações de leads; não incluem conteúdo de notas, contatos, resumos, senhas ou tokens. A auditoria não é uma cópia das versões anteriores de cada lead nem um histórico de toda consulta.

## Assinaturas e cobrança

Existem planos `individual` e `team`, com limite de assentos, status e término de período. Um novo cliente começa com plano individual, um assento e 14 dias de teste. A administração da plataforma mantém esses dados manualmente. Os estados são `trial`, `active`, `past_due`, `suspended` e `cancelled` tanto na interface quanto no banco; o banco aceita também `expired`, apresentado como bloqueio de acesso. Uma data vencida pode bloquear o CRM sem que o rótulo do status tenha sido alterado.

Esta versão não processa pagamento, não cobra cartão e não recebe confirmação automática de um provedor financeiro. Após confirmar um pagamento fora do CRM, o operador atualiza a assinatura na administração. Antes de suspendê-la ou alterar assentos, confira contrato, equipe e prazo.

Acesso ao CRM exige `active` ou `trial` dentro do prazo aplicável. Estados de atraso, suspensão, cancelamento ou período expirado bloqueiam leitura e edição de leads. Um plano ativo sem término de período não expira por data. O teste exige `trial_ends_at` futura e, quando definido, `current_period_end` também futuro. Essas regras são verificadas pelo banco. O administrador do workspace mantém as operações autorizadas de exportação e exclusão da empresa mesmo quando o acesso ao CRM está bloqueado, pelas funções `export_workspace` e `delete_workspace`; confira a confirmação exigida antes de excluir. Valide também o limite de assentos no backend ao convidar, aceitar e reativar membros.

## Backup e recuperação

### Backup de uso diário

Use **Configurações → Exportar backup** para gerar o JSON dos leads e configurações que o usuário pode acessar. Para o closer, o escopo corresponde aos próprios leads; o papel de visualização não dispõe da exportação pela interface. **Importar leads** aceita um backup JSON da versão 1 e acrescenta IDs ainda não presentes no workspace, preservando os existentes; não restaura metas ou permissões automaticamente. O banco aceita até 1.000 leads por chamada de importação; confira se o cliente divide arquivos maiores em lotes.

**Importar meus dados deste navegador** envia os leads pessoais da versão anterior para o workspace autenticado, exclui os dados demonstrativos e preserva os originais locais. Confira a empresa selecionada antes da importação. O CSV do dashboard é um relatório do período, não uma cópia integral do sistema.

Quando o CRM estiver bloqueado pela assinatura, a tela de conta oferece **Exportar dados da empresa** ao administrador do workspace. Essa exportação usa `export_workspace` e inclui leads, configurações e metadados de privacidade da empresa.

Guarde os arquivos em armazenamento controlado pelo operador. Eles podem conter dados pessoais, valores comerciais e resumos de calls. Evite repositórios Git, pastas públicas e links sem controle de acesso.

### Recuperação do banco de nuvem

O backup JSON de leads/configurações não restaura usuários Auth, senhas, associações, convites, assinaturas, políticas RLS ou auditoria. A exportação completa da empresa acrescenta os metadados de privacidade e dados administrativos previstos no contrato da RPC; continua sem restaurar identidades, sessões e infraestrutura. Para recuperação completa, use os recursos de backup/restore do projeto Supabase ou um procedimento de banco validado pelo operador.

1. Confira no dashboard do Supabase quais backups e opções de restauração estão realmente disponíveis no plano contratado. Consulte [Backups do Supabase](https://supabase.com/docs/guides/platform/backups).
2. Antes de qualquer mudança de banco relevante, produza uma cópia recuperável e registre data, ambiente e versão do schema. Para exportações por CLI ou `pg_dump`, siga [Backup e restauração por CLI](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore) e confira o que é incluído ou excluído; um dump padrão pode não cobrir Auth e Storage.
3. Teste a restauração em um projeto isolado. Verifique usuários, leads, configurações, memberships, assinaturas e políticas de autorização. Faça login com contas de dois workspaces e tente acessar dados do outro.
4. Planeje a janela de recuperação de produção, preserve a origem e valide o resultado antes de liberar o uso. Se o projeto de destino mudou, atualize as variáveis do frontend e publique novamente.
5. Registre o tempo de recuperação e o último dado recuperado; use esse teste para definir compromissos de disponibilidade e perda de dados.

O repositório não agenda backups nem confirma que backups automáticos ou recuperação pontual foram contratados. A periodicidade, retenção, criptografia dos arquivos e responsabilidade pela restauração precisam ser definidas pelo operador.

### Recuperação no modo local

Exporte o JSON antes de limpar o navegador, mudar de dispositivo ou mudar de domínio. Importe o arquivo no destino e confira quantidade de leads e dados importantes. Sem uma exportação, apagar o armazenamento do navegador pode tornar os dados irrecuperáveis. O armazenamento local não é um backend multiusuário.

## Retenção dos leads

A migração guarda prazo de retenção por workspace, data de retenção por lead e metadados de base legal. O prazo inicial do workspace é de 365 dias; a inserção atribui a data de retenção usando esse prazo. A base legal começa como `NULL`, sem presumir legítimo interesse. Esses dados técnicos não estabelecem a finalidade ou a política adequada do cliente.

Somente um administrador ativo da empresa pode usar `update_workspace_privacy`, `record_lead_privacy` e `purge_expired_leads`. A interface permite editar o contato e o prazo da empresa; os metadados legais de um lead e a purga estão disponíveis por RPC, sem um editor individual/agendamento na interface. Alterar o prazo da empresa não recalcula as datas já atribuídas aos leads. A plataforma não dispõe de override dessas permissões. Valide a política do cliente antes de configurar ou executar essas operações e mantenha o procedimento de atendimento documentado.

## Privacidade e suporte

A política em [PRIVACIDADE.md](PRIVACIDADE.md) é um modelo incompleto. Preencha os dados da empresa, contato, finalidades, retenção, fornecedores e procedimentos antes de disponibilizar o serviço a clientes reais.

Receba pedidos de acesso, correção e exclusão pelo canal definido pelo operador. Autentique o solicitante e confirme seu workspace antes de entregar arquivos ou excluir dados. Um usuário pode excluir um lead quando seu papel permite. Somente um administrador ativo do workspace dispõe das funções de exportação e exclusão da empresa; `delete_workspace` exige o nome exato. O papel de plataforma não permite essas operações por si só. Excluir um workspace remove seus leads, associações, configurações, convites e assinatura, mas mantém contas/perfis e eventos de auditoria com o workspace desvinculado. Os arquivos exportados e as cópias em backups exigem tratamento separado.

A transferência de responsabilidade é feita pelo proprietário atual para outro administrador ativo da empresa. Não desative o proprietário nem o último administrador; transfira a responsabilidade primeiro quando necessário. Excluir a empresa não exclui a identidade Auth, que pode participar de outras empresas. A exclusão integral de identidade exige atendimento separado, com revisão de propriedade/atribuição e uso administrativo apropriado do Supabase Auth.

Na investigação de incidentes, registre horário, workspace, operação, versão e mensagem de erro. Evite incluir senhas, tokens ou dados de leads em logs de suporte. Teste o problema no ambiente adequado e comunique os usuários afetados conforme o procedimento definido pela empresa.

## Verificação antes de liberar um cliente

- Login, confirmação/recuperação de senha e saída funcionam no domínio final.
- Usuários de workspaces diferentes não conseguem ler nem alterar dados uns dos outros por chamadas diretas à API.
- `viewer` não consegue escrever; os demais papéis respeitam as permissões previstas.
- Convites, revogação, desativação de membros e limite de assentos foram validados no banco.
- Mudanças de assinatura e vencimento têm o efeito esperado tanto na interface quanto nas funções/políticas do banco.
- Exportação/importação foram testadas com dados fictícios; restauração de banco foi exercitada antes de definir compromissos de recuperação.
- Cobrança manual, suporte, privacidade e condições comerciais têm responsáveis e informações reais.
