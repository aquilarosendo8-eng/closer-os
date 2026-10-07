# Modelo de política de privacidade — Closer OS

**MODELO INCOMPLETO. Não publique como política definitiva.** O operador precisa preencher os campos entre colchetes, adaptar o texto à operação real e obter a revisão necessária antes de tratar dados de clientes. Este arquivo não substitui a análise jurídica nem confirma conformidade com a LGPD.

Versão: [VERSÃO] — última atualização: [DATA].

## Quem oferece o serviço

O Closer OS é oferecido por **[RAZÃO SOCIAL/NOME DO RESPONSÁVEL]**, [CNPJ/CPF, CONFORME APLICÁVEL], com endereço em [ENDEREÇO]. O contato para assuntos de privacidade e direitos de titulares é [EMAIL/CANAL]. O encarregado, quando aplicável, pode ser contatado por [NOME E CONTATO OU INFORMAÇÃO SOBRE A DISPENSA APLICÁVEL].

Para os dados de conta, relacionamento comercial, cobrança e segurança que tratamos para nossas próprias finalidades, atuamos como controlador conforme a operação descrita aqui.

Para dados de leads e outras pessoas inseridos por uma empresa cliente em seu CRM, a empresa cliente normalmente decide finalidades e meios essenciais do tratamento e atua como controladora. Nós atuamos como operadores conforme suas instruções e contrato. Confirme essa divisão na operação real e complete [IDENTIFICAÇÃO/CONTATO DO CLIENTE CONTROLADOR, QUANDO APLICÁVEL].

## Quais dados podem ser tratados

- **Conta e equipe:** identificadores de usuário, email, nome de exibição, autenticação, associação a workspaces, papel, convites e situação de acesso.
- **CRM:** nome, empresa, email e telefone do lead, ticket, origem, datas, comparecimento, status, valor fechado, objeções, dor, urgência, avaliação de capacidade financeira, decisor, nota da call, erros do closer, resumo da call e observações.
- **Configuração e administração:** nome do workspace, metas, percentual de comissão, plano, limite de assentos, estado de assinatura, término de período, contato de privacidade, metadados de base legal/retenção e registros de ações administrativas disponíveis no sistema.
- **Operação técnica:** dados de sessão e registros que os fornecedores ou o operador utilizem para segurança e funcionamento. Especifique [DADOS TÉCNICOS EFETIVAMENTE COLETADOS, FORNECEDORES E PRAZOS].

O sistema registra texto de resumo de call. Esta versão não captura áudio, não grava reuniões e não transcreve automaticamente gravações. Campos de texto livre podem conter informações adicionais fornecidas pelo usuário; o cliente deve limitar seu registro ao necessário para uma finalidade válida.

## Finalidades e bases legais

Complete as bases legais com a realidade de cada tratamento. Usar o CRM ou aceitar termos não representa, por si só, consentimento genérico para qualquer uso dos dados de leads.

| Tratamento | Finalidade | Base legal e responsabilidade a preencher |
| --- | --- | --- |
| Conta e autenticação | Identificar usuários e controlar acesso. | [BASE LEGAL, CONTROLADOR E RETENÇÃO]. |
| Gestão de leads e calls | Organizar a operação comercial do cliente. | [BASE LEGAL DEFINIDA PELO CLIENTE CONTROLADOR]. |
| Indicadores e desempenho | Produzir relatórios a partir dos registros do workspace. | [BASE LEGAL, REGRAS INTERNAS E INFORMAÇÃO À EQUIPE]. |
| Assinatura e relacionamento comercial | Administrar contratação, atendimento e cobrança externa. | [BASE LEGAL E PRAZOS CONTRATUAIS/FISCAIS]. |
| Segurança e auditoria | Proteger contas, dados e operações administrativas. | [BASE LEGAL, ESCOPO E RETENÇÃO]. |

A leitura assistida de resumos usa regras locais no navegador e permite edição das sugestões. Não envia esses textos a um provedor de IA nesta versão. Seu resultado auxilia o usuário; descreva [REVISÃO HUMANA E LIMITES INTERNOS] caso o cliente utilize os indicadores em decisões sobre pessoas.

## Onde os dados ficam

**Dados locais da versão anterior:** leads e configurações podem permanecer no armazenamento local do navegador, associado ao domínio usado. Na ausência de configuração de nuvem, a tela de preparação oferece download explícito de backup. A tela de login configurada não lê nem exibe esses registros; depois de autenticar, o usuário com permissão de edição pode solicitar a importação para sua empresa selecionada. Os originais são preservados e não são sincronizados automaticamente. Exportações baixadas pelo usuário permanecem sob sua responsabilidade. Serviços de hospedagem podem tratar registros técnicos de acesso conforme sua própria operação. A demonstração usa dados fictícios e armazenamento separado, sem ler os leads pessoais da versão anterior.

**Modo de nuvem:** dados de CRM, associação a workspaces e assinaturas são enviados ao projeto Supabase configurado; a autenticação usa Supabase Auth. A sessão é gerida pelo cliente de autenticação no navegador. O frontend é servido pela hospedagem configurada pelo operador, prevista como Vercel nesta implantação. Preencha [PROJETO/REGIÃO DE HOSPEDAGEM], [LOCALIZAÇÃO DOS DADOS], [FORNECEDORES CONTRATADOS] e [MECANISMOS DE TRANSFERÊNCIA INTERNACIONAL, SE APLICÁVEIS].

Credenciais administrativas são mantidas fora do frontend. A segregação entre workspaces depende de políticas de acesso no banco e da gestão correta das associações. Dados podem ser acessados por pessoas autorizadas do mesmo workspace conforme seu papel; descreva isso aos membros da equipe.

## Compartilhamento

Os dados são tratados pelos fornecedores efetivamente necessários para hospedagem, banco, autenticação e, quando configurado, envio de emails de conta. Preencha a lista de operadores/suboperadores, serviços, finalidades e localização: [LISTA COMPLETA].

O papel de administrador da plataforma permite gerenciar clientes e acessos, mas não concede, por si só, leitura ou exportação de leads. O acesso ao CRM depende de vínculo autorizado à empresa. Documente [FINALIDADES E LIMITES EFETIVOS DE SUPORTE/OPERAÇÃO, AUTORIZAÇÃO E RESPONSÁVEIS]. Pedidos legais serão tratados conforme [PROCEDIMENTO]. Declare de forma fiel se existem outros compartilhamentos, ferramentas de monitoramento ou usos comerciais: [INFORMAÇÕES PENDENTES].

Ao criar um convite de empresa, o CRM solicita o envio automático de e-mail ao serviço Supabase Auth pela API protegida do servidor. O envio trata nome, e-mail do destinatário e o link necessário ao acesso. A cópia manual pode criar a identidade inicial Auth sem senha; contas já existentes sempre precisam autenticar por conta própria. O cadastro aberto também registra os dados da própria empresa e o aceite dos documentos. O responsável também pode copiar e compartilhar o link por outro canal, envolvendo o provedor desse canal. Não inclua dados de leads no convite. Documente os serviços de e-mail efetivamente configurados em [FORNECEDORES E FINALIDADES].

## Retenção, backup e eliminação

Defina [PRAZO DE RETENÇÃO POR CATEGORIA], [PRAZO APÓS CANCELAMENTO], [OBRIGAÇÕES LEGAIS APLICÁVEIS] e [PERIODICIDADE/PRAZO DOS BACKUPS]. O banco possui prazo inicial de 365 dias por workspace e data de retenção por lead; a base legal inicial fica `NULL`, sem presumir consentimento ou legítimo interesse. Somente o administrador da empresa pode registrar os metadados legais e executar a remoção dos registros vencidos pelas funções disponíveis. Não há agendamento de expurgo ou de backups pelo código desta versão. O prazo técnico não substitui a definição e documentação da política pelo cliente controlador. Recursos de backup do Supabase dependem do plano e da configuração contratados.

No modo local, os registros permanecem no navegador até a exclusão pelo usuário, remoção do armazenamento ou ação equivalente. Limpar o navegador pode apagar os dados sem possibilidade de recuperação. Arquivos exportados exigem eliminação separada por quem os mantém.

No modo de nuvem, a exclusão de um lead pela interface, quando autorizada, remove o registro usado pelo CRM. O administrador do workspace pode solicitar pela operação implementada a exclusão de sua empresa, com confirmação do nome. Exportação e exclusão do workspace são preservadas mesmo quando a assinatura bloqueia o CRM. A exclusão da empresa remove leads, associações, convites, configurações e assinatura; mantém contas/perfis, aceites dos documentos e eventos de auditoria com a empresa desvinculada. O registro privado de uso do período de teste também permanece vinculado ao perfil, com a empresa desvinculada, para impedir reiniciar o benefício. Defina sua retenção e o atendimento a pedidos de eliminação em [PROCEDIMENTO E PRAZOS]. Contas de autenticação, cópias exportadas e backups exigem tratamento separado. Pedidos mais amplos serão tratados pelo operador conforme [PROCEDIMENTO, PRAZOS E RESTRIÇÕES LEGÍTIMAS].

## Direitos e canais de atendimento

Os titulares podem solicitar os direitos previstos na LGPD, quando aplicáveis, incluindo confirmação de tratamento, acesso, correção e exclusão nas condições legais. Encaminhe solicitações para [CONTATO DE PRIVACIDADE]. Informe apenas os dados necessários para identificar a solicitação; não envie senhas ou tokens.

Pedidos relativos a leads podem exigir encaminhamento ao cliente controlador. O operador verifica identidade e legitimidade, identifica o workspace e responde conforme [PRAZO/PROCEDIMENTO]. A exportação JSON/CSV disponível aos usuários autorizados é uma ferramenta operacional; não equivale a um fluxo automático que verifica e atende todos os direitos legais.

A interface permite corrigir leads e excluir registros conforme o papel do usuário, e o administrador dispõe das operações autorizadas de exportação e exclusão do workspace. Exclusão integral de conta Auth e tratamento de dados em backups exigem atendimento do operador nesta versão. Preencha o procedimento operacional antes de assumir esse compromisso em contrato.

## Segurança e incidentes

No modo de nuvem, a aplicação prevê autenticação, controle de papéis e isolamento de workspaces por políticas do banco. O operador deve manter a configuração, revisar acessos, testar restauração e proteger as credenciais e arquivos exportados. No modo local, a proteção depende também do acesso ao dispositivo e ao navegador.

Descreva as medidas efetivas adicionais, o processo de resposta a incidentes e as comunicações exigidas: [MEDIDAS, RESPONSÁVEIS E CANAIS]. Não prometa certificações, criptografia própria, disponibilidade contínua ou ausência de incidentes sem evidência.

## Alterações desta política

Publicaremos a versão vigente em [URL DA POLÍTICA] e comunicaremos mudanças relevantes por [CANAL E PROCEDIMENTO]. Preencha a data e registre o histórico de versões. Antes da publicação, remova todas as lacunas deste modelo e confirme que o texto corresponde à configuração e à operação reais.
