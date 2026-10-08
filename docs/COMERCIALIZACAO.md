# Comercialização do HIGH CLOSER

Este documento organiza a operação comercial da versão do repositório. Não representa contratação de serviços, ativação de pagamentos, garantia jurídica ou confirmação de que o ambiente de produção passou pelas verificações.

## O que o produto entrega

CRM em português com cadastro de leads, empresa e contato, ticket, origem, call, comparecimento, objeções, etapa, valor fechado e observações. Dashboard, pipeline, avaliação de calls e evolução do closer usam os registros informados pela equipe.

Receita, ticket médio e comissão projetada são indicadores gerenciais. A comissão depende do percentual configurado; a projeção não representa pagamento realizado, conciliação bancária ou documento fiscal.

A análise de resumos de calls é feita por regras locais com sugestões editáveis. Não há gravação ou transcrição de áudio, chamada automática a um modelo de IA, calendário ou WhatsApp integrado nesta entrega.

No modo de nuvem, autenticação e workspaces permitem atender diferentes clientes. Dados locais da versão anterior permanecem no navegador e podem ser importados explicitamente após autenticação para a empresa selecionada. Quando o backend não está configurado, a tela de preparação oferece download do backup local e uma demonstração separada com dados fictícios. A tela de login da nuvem configurada não lê nem exibe esses registros legados.

## Planos e cobrança manual

O modelo contempla planos `individual` e `team`. A assinatura registra limite de assentos, status e fim de período. Clientes novos começam com plano individual, um assento e 14 dias de teste. Defina seus próprios valores e condições; o código não estabelece preço comercial.

| Campo a definir | Decisão do operador |
| --- | --- |
| Plano individual | Preço, assentos permitidos, periodicidade e funcionalidades contratadas. |
| Plano de equipe | Preço, limite de membros, regra para assentos adicionais e funcionalidades contratadas. |
| Teste | Duração, data de término e condição de conversão para assinatura ativa. |
| Atraso | Prazo de negociação, acesso aplicável e aviso ao cliente. |
| Suspensão/cancelamento | Condições, data de corte, exportação e retenção de dados. |
| Cobrança | Meio de pagamento externo, emissão fiscal e responsável pela confirmação. |

O operador da plataforma pode criar o workspace, ou o cliente pode criar sua própria empresa pelo cadastro aberto. O operador atualiza manualmente a assinatura. Os estados são `trial`, `active`, `past_due`, `suspended` e `cancelled` tanto na interface quanto no banco. O banco também admite `expired`. `active`/`trial` dentro do prazo aplicável liberam o CRM; atraso, suspensão, cancelamento e vencimento bloqueiam leitura e edição de leads. Um plano ativo sem término de período não expira por data. O administrador do cliente preserva a exportação e a exclusão de sua empresa pelas operações autorizadas, mesmo após bloqueio do CRM. Mantenha as condições contratuais consistentes com essas regras.

Não existe checkout, cobrança recorrente por cartão, webhook financeiro ou integração de pagamento ativa nesta versão. A alteração de status não comprova recebimento. Um pagamento realizado fora do CRM só altera a assinatura quando o operador o confirma e registra a atualização.

## Cadastro pelo link público

Divulgue **https://closer-os-rho-three.vercel.app/?signup=1** para cadastro e `?demo=1` para demonstração. O cliente informa nome, empresa, e-mail, senha e aceite; confirma o e-mail e conclui a criação da empresa. Será administrador apenas dessa empresa, com teste individual de 14 dias e um assento. O cadastro não concede administração da plataforma. Recarregar ou repetir a criação não duplica a empresa; excluí-la não reinicia o teste.

A entrega das confirmações exige SMTP funcionando. Para contratar ou ampliar o plano, o cliente segue o processo comercial do operador.

## Primeiro cliente

1. Defina razão social, CNPJ quando aplicável, responsável, contato comercial, suporte e canal de privacidade.
2. Preencha e revise a política de privacidade, condições de uso, contrato, preços e procedimento de cancelamento. [PRIVACIDADE.md](PRIVACIDADE.md) e [TERMOS.md](TERMOS.md) contêm campos pendentes; os documentos da interface também são provisórios. Não publique os modelos como documentos finais.
3. Prepare homologação e produção seguindo [OPERACAO.md](OPERACAO.md). Verifique autenticação, separação de workspaces, papéis, assentos e assinatura com contas de teste.
4. Confirme com o cliente o nome da empresa, o administrador e o plano. Crie o workspace pela administração da plataforma.
5. Gere o convite do administrador: o sistema solicita o envio por e-mail ao Supabase Auth. Uma pessoa nova recebe o fluxo de ativação e define senha com pelo menos 12 caracteres; uma conta existente recebe um link de acesso ao convite. O aceite exige o e-mail confirmado correspondente. Copiar link é a opção secundária para WhatsApp, inclusive após falha SMTP: só gera ativação quando a própria chamada cria uma identidade Auth nova; contas preexistentes precisam da autenticação do destinatário. Uma falha parcial pode deixar a identidade criada sem senha e exigir ativação/recuperação por e-mail. O novo convite invalida o anterior. Se o envio falhar após a criação da empresa, reenvie o convite na empresa existente; não cadastre o cliente novamente. Confira o resultado e oriente o destinatário a conferir a empresa recebida.
6. Registre o plano contratado, limite de assentos, status e término de período. Guarde contrato, comprovante financeiro e informações fiscais no sistema externo escolhido para essa finalidade.
7. Mostre ao cliente o cadastro de lead, encerramento de venda, avaliação de call e exportação. Explique os denominadores das taxas do dashboard e a natureza da comissão projetada.
8. Teste o uso com as funções da equipe e apresente os canais de suporte, backup, privacidade e cancelamento.

## Rotina da operação comercial

- Revise assinaturas e datas periodicamente; não dependa de alertas financeiros externos que ainda não estejam integrados.
- Após confirmar pagamento, atualize a assinatura e confira o acesso do cliente. Atualize os assentos apenas de acordo com o plano e a regra do backend.
- Registre atendimento e decisões contratuais fora do CRM quando necessário. A auditoria administrativa da aplicação não substitui documentos fiscais, comprovantes ou histórico de suporte.
- Antes de suspensão ou cancelamento, aplique a comunicação e as condições definidas no contrato. A retenção e a exclusão de dados precisam ter procedimento próprio.
- Quando um cliente sair, trate exportação, convites pendentes, membros, assinatura e dados conforme a política aprovada. Não prometa exclusão automática de conta nem eliminação instantânea de backups.

## Limites que devem aparecer na oferta

- O histórico de calls registra os campos do lead; verifique o modelo antes de vender um histórico independente de múltiplas reuniões por lead.
- Closers operam seus próprios leads; admin/manager têm a abrangência de sua empresa e viewer consulta sem edição. Não prometa outros níveis de acesso ou segmentação além dos implementados.
- As métricas refletem a qualidade dos dados registrados; a análise local oferece sugestões, sem garantia de resultado de venda.
- O serviço depende da disponibilidade e dos limites dos fornecedores contratados para hospedagem, banco e email.
- Backups automáticos, recuperação pontual, SLA, emissão fiscal e pagamentos só podem ser prometidos depois de contratados, implementados e validados.

## Condições para lançamento

Recursos implementados no repositório:

- [x] Login, cadastro aberto, criação da própria empresa, recuperação de senha e acesso por convite.
- [x] Empresas isoladas, papéis, distribuição de leads e bloqueio de acesso no banco.
- [x] Convites por e-mail pelo servidor, cópia adicional do link, revogação, desativação, limite de assentos e proteção do proprietário/último administrador.
- [x] Administração de clientes e planos com cobrança manual, teste e vencimento.
- [x] Exportação, importação e migração explícita de leads locais.
- [x] Auditoria administrativa, contato/retenção por empresa, transferência de responsabilidade e exclusão confirmada.
- [x] Testes unitários, fluxos de navegador e testes de autorização/concorrência no PostgreSQL.

Essa lista descreve o código; a ativação e os serviços de produção têm uma verificação própria.

Complete esta lista com evidências e responsáveis antes de anunciar o serviço como pronto para clientes reais:

- [ ] Backend de produção configurado e migrações aplicadas.
- [ ] Isolamento entre clientes e restrições de cada papel testados por API.
- [ ] Assentos, convites, vencimento e estados de assinatura validados.
- [ ] Login e recuperação de senha testados no domínio publicado; entrega de email configurada.
- [ ] Exportação/importação e recuperação de banco testadas.
- [ ] Preço, forma de pagamento e conferência manual de recebimento definidos.
- [ ] Contrato, política de privacidade e cancelamento preenchidos e revisados.
- [ ] Retenção de dados, fornecedores e direitos de titulares documentados.
- [ ] Suporte, monitoração e tratamento de incidentes com responsáveis definidos.
- [ ] Oferta comercial descreve os recursos efetivos e os limites desta versão.
