# E-mails institucionais do HIGH CLOSER

Modelos visuais de Supabase Auth, com assunto em `subjects.json`. Não implementam envio, autenticação ou criação de links. A API existente continua enviando pelo Supabase Auth, sem mudanças.

| Template no Supabase | Arquivo | Assunto |
| --- | --- | --- |
| Invite user | `invite.html` | Você foi convidado para o HIGH CLOSER |
| Confirm signup | `confirmation.html` | Confirme seu cadastro no HIGH CLOSER |
| Reset password | `recovery.html` | Recupere seu acesso ao HIGH CLOSER |
| Magic link | `magic-link.html` | Seu acesso seguro ao HIGH CLOSER |
| Change email address | `email-change.html` | Confirme a alteração de e-mail no HIGH CLOSER |
| Reauthentication | `reauthentication.html` | Confirme sua identidade no HIGH CLOSER |

## Aplicação dos modelos

Os templates ativos ficam nas configurações externas de **Supabase → Authentication → Email Templates**. Esta tarefa preservou o Supabase e não os publicou automaticamente. Para atualizar a marca dos e-mails enviados, revise e copie o assunto e o HTML do arquivo correspondente para o template existente.

Os modelos utilizam `{{ .ConfirmationURL }}` para o link oficial e `{{ .Token }}` para a reautenticação. Preserve a expressão do link/código do template ativo caso ele tenha uma personalização diferente; não substitua links por endereços fixos, nem modifique callbacks, Site URL, redirect allowlist, SMTP, expiração ou confirmações. Faça a atualização somente do assunto, texto e apresentação.

O convite de uma conta existente utiliza o template **Magic link**; portanto, atualizar apenas **Invite user** não cobre todos os convites. A recuperação usa **Reset password** e o cadastro utiliza **Confirm signup**. Mensagens já enviadas não mudam.

Não é necessário trocar o endereço do remetente, credenciais ou domínio. Se desejar atualizar somente o nome visível do remetente para HIGH CLOSER, preserve o endereço e todas as credenciais atuais. Confira uma mensagem nova de convite e recuperação após aplicar os templates, sem compartilhar links ou códigos.
