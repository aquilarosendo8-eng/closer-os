# Estado da implantação — 7 de outubro de 2026

Este registro separa a implementação publicada, os testes automatizados e a confirmação de entrega de e-mail pelo destinatário.

## Aplicação publicada

- CRM: **https://closer-os-rho-three.vercel.app/**.
- Cadastro público de clientes: **https://closer-os-rho-three.vercel.app/?signup=1**.
- Demonstração: **https://closer-os-rho-three.vercel.app/?demo=1**.
- Implementação publicada: commit `e91e5b52b1af2c171390160b610adae98f50d741`, enviado para `main`.
- Vercel: publicação `dpl_HJ1oiRGwn9gKmWnCYREUDaKzD9WD`, estado **READY**, incluindo as duas APIs de convite.
- Supabase: banco e Auth conectados pela integração oficial da Vercel.

O build `npm run build:cloud` aplicou as migrations 002 e 003 e verificou os checksums das três migrations. A migration 001 permanece imutável. As 11 tabelas públicas têm RLS; o registro privado de cadastros também possui RLS e não concede acesso a clientes anônimos ou autenticados. O provisionamento usa transações e trava de sessão, recusa versões ou checksums inconsistentes e mantém a verificação TLS. Consulte [Operação](OPERACAO.md) e [certificados](../scripts/certs/README.md).

O navegador recebe apenas a URL e a chave pública do Supabase. Credenciais administrativas e de conexão permanecem no servidor; não são usadas para autorizar requisições do cliente sem antes verificar sessão, empresa, papel e assentos.

## Comportamentos concluídos

O Admin cadastra nome, e-mail e função. `POST /api/invitations` envia o convite pelo Supabase Auth no servidor, com retorno para o domínio de produção. O painel mostra convites pendentes, ativados, expirados ou revogados e permite reenviar. Falhas de SMTP apresentam um erro claro e tentam revogar somente o convite recém-criado, sem confirmar um envio inexistente ou duplicar a empresa.

A opção secundária **Copiar link do convite** usa `POST /api/invitation-link`, com as mesmas verificações de acesso. Para uma identidade Auth criada por essa requisição, retorna o link oficial de ativação para definir senha. Para qualquer conta preexistente, retorna somente o convite do CRM, que exige autenticação do próprio destinatário. O Admin não recebe um link de sessão Auth de outra conta. O backend confirma que a identidade do link de ativação é a mesma que acabou de criar. Uma falha após criar essa identidade pode exigir ativação ou recuperação por e-mail; a alternativa manual não elimina SMTP em todos os casos.

A página de convite apresenta empresa, nome e e-mail, definição e confirmação de senha para uma ativação nova, termos e aceite do vínculo. Contas existentes conservam a senha. O aceite válido seleciona a empresa correta, inclusive após recarregar. A recuperação conserva o contexto do convite. Links de ativação ou convites expirados apresentam instruções para solicitar outro, sem conceder acesso a dados.

Clientes também podem abrir o cadastro público, confirmar seu e-mail e concluir a criação da própria empresa. O servidor concede a esse usuário o papel de administrador somente nessa empresa, com teste individual de 14 dias e um assento. Repetir a conclusão retorna a mesma empresa; excluir uma empresa não reinicia o teste. Metadados de cadastro não concedem papel de administrador da plataforma.

## Verificações concluídas

| Verificação | Resultado | Escopo |
| --- | --- | --- |
| Testes unitários | 109 passaram | Incluem 69 casos das APIs, validação, cadastro, regras de acesso e métricas. |
| Navegador — SaaS/Admin | 44 passaram | Ativação, login, recuperação, cadastro, convites, reenvio, cópia, erros e administração, com respostas HTTP controladas. |
| Navegador — CRM | 10 passaram | Cadastro de leads, métricas, calls, importação/exportação e uso móvel em demonstração. |
| PostgreSQL isolado | 233 passaram | Três migrations, RLS, RPCs, papéis, isolamento, assentos, cadastro idempotente e concorrência. |
| Provisionamento isolado | 11 passaram | Instalação ordenada, repetição, checksums, modo de verificação e recusa de histórico inconsistente. |
| Supabase real após publicação | 59 passaram | Auth/REST/RLS, login, convites, persistência, permissões, isolamento, suspensão e desativação. |
| Navegador público com Supabase real | Passou | Conta nova: link oficial, definição de senha, aceite, empresa correta e login após sair. Conta existente: convite manual exige senha própria, não altera a senha e preserva a empresa anterior. |
| Cadastro público com Auth real | Passou no escopo descrito | Confirmação de uma conta de teste pelas APIs oficiais, formulário de conclusão, criação da própria empresa, termos, trial e isolamento. A entrega do e-mail de confirmação não faz parte desse ensaio. |
| API pública — ambos os endpoints | Passou | GET 405, ausência de sessão 401 e papel de leitura 403, sem criação de convite nas tentativas recusadas. |
| Recuperação e CRM na interface pública | Passou | Sessão de recuperação validada pelo provedor, nova senha, retorno ao CRM, persistência e restrições de leitura. |

Os ensaios automatizados externos usaram somente dados fictícios e removeram suas contas, empresas e registros ao concluir. Os links de teste foram gerados e validados pelas APIs oficiais, sem enviar mensagens. Esses testes não são prova de recebimento na caixa de entrada. A recuperação e os convites foram exercitados em navegador com perfil temporário, TLS ativo e sem erros de execução da página.

## Confirmação do e-mail real

Após o proprietário configurar o Gmail como SMTP com uma senha de app do Google, a API publicada aceitou o novo pedido ao endereço principal autorizado com **HTTP 201, `emailSent: true`**. A tentativa anterior tinha falhado com `EMAIL_DELIVERY_FAILED`; não foi apresentada como sucesso.

**O destinatário confirmou o recebimento, o aceite e a entrada na empresa de teste.** O servidor confirmou e-mail validado, login posterior ao envio e vínculo ativo com função de leitura na empresa correta. Com uma sessão Supabase dessa conta, a consulta aos dados fictícios da empresa autorizada retornou seu registro; a outra empresa retornou zero registros, e a tentativa de edição foi bloqueada. Como a conta já existia, esse ensaio de caixa de entrada usou a senha atual; a ativação com definição de senha de uma conta nova foi comprovada separadamente nos testes reais de navegador.

As duas empresas fictícias, seus registros, vínculos e convites e o remetente de teste foram removidos. A conta, senha, empresa e permissões reais do proprietário foram preservadas. O SMTP foi validado com uma mensagem real ao endereço autorizado; a entrega a caixas de outros clientes continua sujeita às regras e aos limites do Gmail.

## Configuração e operação

A integração Supabase/Vercel, as migrations e as funções de produção já estão instaladas. Não é necessário inserir chaves privadas no frontend nem criar outro projeto Vercel.

O SMTP Gmail usa `smtp.gmail.com`, porta `465`, remetente e usuário iguais ao Gmail configurado e a senha de app gerada pelo Google, inserida somente no Supabase. Não substitua pela senha normal da conta ou por uma senha inventada. Confira [Operação](OPERACAO.md) para Site URL, redirecionamentos e limites do provedor.

A aplicação exige pelo menos 12 caracteres ao criar ou redefinir senha. A política correspondente do Supabase Auth deve ser conferida no painel. A confirmação, ativação e recuperação em caixas externas continuam sujeitas à entrega e aos limites do serviço SMTP.

Para comercialização, consulte o [checklist](COMERCIALIZACAO.md). Assinaturas e cobrança permanecem manuais. Documentos legais, preços, suporte e estratégia de backup são decisões operacionais; este registro não os considera implementados ou aprovados.


## Atualização — 8 de outubro de 2026: oportunidades, atividades e timeline

A implementação `4140a56471175c4cd00d6e74be15c9e928794292` foi publicada em `https://closer-os-rho-three.vercel.app/` pelo deploy `dpl_9ExCXmVaQuyiUUxwZ2DzcZ1Rx6me`, estado **READY**. A publicação nativa executou `npm run build:cloud`: a migration `202610080006_lead_activities_timeline` foi aplicada em transação; as seis versões e seus checksums foram conferidos; as **16 tabelas públicas têm RLS**. As migrations 001–005 permaneceram imutáveis.

O SHA256 da migration006 instalada é `83ee112ee95fd470ab758b62941908983915bb86d560b783f2a7588c6ac08c82`. O provisionamento também confirmou ausência de escrita direta por `authenticated` em `activities` e `lead_events`, além das funções autorizadas necessárias.

O site retornou HTTP200 e os quatro assets referenciados carregaram corretamente, com a implementação de atividades/histórico presente. Nenhuma credencial administrativa ou de conexão foi encontrada nesses arquivos públicos. Os dois endpoints de convites conservaram a proteção de GET405.

| Verificação | Resultado | Escopo |
| --- | --- | --- |
| Testes unitários | 195 passaram | Datas, próxima ação, contratos, autoria protegida e regressões das funcionalidades existentes. |
| Build de produção | Passou | TypeScript e Vite; publicação nativa com provisionamento. |
| Navegador com respostas controladas | 138 cenários passaram | 28 novos de oportunidade/atividades e 110 de CRM, Pipeline/Calls, SaaS/Admin, perfil e temas. |
| PostgreSQL isolado | 639 verificações passaram | Upgrade, RLS, papéis, isolamento, autor/data do servidor, histórico e cinco grupos de concorrência. |
| Provisionamento isolado | 25 verificações passaram | PostgreSQL real descartável e Auth sintético; instalação, repetição, checksums, concorrência e recusa de permissões inadequadas. |
| Supabase de produção | 239 verificações passaram | Novos RPCs e RLS, tarefas, histórico por data, autoria imutável, isolamento, suspensão, revogação e portabilidade, além dos fluxos existentes. |
| Navegador público com Supabase real | 11 grupos passaram | Visão 360°, CRUD autorizado de atividades, calls por data, revisão histórica, eventos comerciais, faturamento, temas, telas de 1366px/390px, RLS e saída das sessões. |

As verificações de API e navegador em produção criaram somente identidades e empresas fictícias desta execução, sem enviar e-mails. A remoção dos fixtures foi conferida ao concluir. O ensaio de navegador usou quatro papéis reais, cinco contas e duas empresas; não simulou requisições. Recusou outra empresa, lead não atribuído, escrita pelo viewer e falsificação de autoria. O ticket de R$20.000 foi conferido no banco e na timeline; a venda de R$18.000 entrou no faturamento e saiu ao mudar para perda. As calls de duas datas conservaram suas notas e a revisão oficial anterior. As quatro sessões saíram sem erros de execução da página.

Os hashes dos dez conjuntos de dados originais confirmaram preservação após a migration e após os ensaios de API e navegador. A migration006 já está instalada; nenhuma configuração manual adicional no Supabase ou na Vercel é necessária para oportunidades, atividades e timeline. Login, convites, regras de métricas, permissões existentes e assinaturas foram preservados.

Consulte [Oportunidades e atividades](OPORTUNIDADES-E-ATIVIDADES.md) para arquitetura, campos, permissões, funcionamento e relação de arquivos. Calls antigas são mostradas somente quando os fatos existiam no cadastro; novos snapshots preservam o histórico por data sem alterar os cálculos atuais do Dashboard/Performance.
