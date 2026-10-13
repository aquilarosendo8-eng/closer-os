# HIGH CLOSER — Importação de leads e oportunidades

O importador permite migrar a base atual de uma empresa por CSV ou Excel, com conferência antes da gravação. O backup JSON nativo continua usando sua validação e importação próprias. A migração não transfere conversas completas, tarefas antigas, múltiplas reuniões ou o histórico de movimentações de outros CRMs.

## Preparar a exportação

1. No Kommo, Pipedrive ou HubSpot, abra a lista de contatos ou negócios/oportunidades e use a opção de exportar. Os nomes dos menus variam conforme o plano e a versão do CRM.
2. Exporte os registros da empresa em CSV UTF-8 ou XLSX, incluindo nome, contato, empresa, etapa, responsável e os campos comerciais necessários. Para negócios com várias pessoas, escolha conscientemente qual contato representa a oportunidade; o HIGH CLOSER não reconstrói automaticamente essas relações.
3. Confira se cada linha representa uma oportunidade e se há uma primeira linha de cabeçalhos. Não misture linhas de subtotal, células mescladas ou cabeçalhos repetidos na base.
4. Preserve telefone como texto para evitar perda de zeros ou notação científica. Quando possível, informe o código do país. Confira se datas incluem horário para as calls.
5. Exporte também o identificador do negócio, se o CRM oferecer um identificador estável e exclusivo. Só o relacione ao campo de identificador de origem quando houver essa garantia.

O [modelo CSV](../public/modelo-importacao-leads.csv) contém cabeçalhos em português e um contato fictício. Substitua ou remova a linha de exemplo antes de importar sua base.

## Importar em cinco etapas

Em **Configurações → Importar leads**, confira primeiro o nome da empresa de destino.

1. **Enviar arquivo:** selecione ou arraste CSV, XLSX ou o backup JSON do HIGH CLOSER. Para Excel com várias abas, escolha a aba que contém os leads. CSV aceita vírgula ou ponto e vírgula, UTF-8 com ou sem BOM, aspas e quebras de linha dentro de campos.
2. **Relacionar campos:** revise as sugestões de correspondência. Elas ajudam com cabeçalhos comuns em português e inglês, mas não garantem que dois campos tenham o mesmo significado. Cada coluna desconhecida começa ignorada; você pode relacioná-la a um campo ou escolher explicitamente acrescentá-la às notas, mantendo seu rótulo.
3. **Pipeline e responsáveis:** escolha o pipeline, a etapa e o responsável padrão. Relacione cada etapa antiga a uma etapa existente e cada vendedor antigo a um membro ativo autorizado. Nenhuma etapa nem conta de usuário é criada automaticamente. Confira o fuso e o formato dos números.
4. **Validar e conferir:** examine os totais, as mensagens por linha e a prévia de até 20 registros. A validação consulta correspondências no banco sem baixar a base inteira de leads. Volte ao mapeamento para corrigir erros sem selecionar novamente o arquivo.
5. **Confirmar importação:** confira os leads previstos, duplicados ignorados, conflitos e registros inválidos, a empresa e o pipeline. Marque a confirmação e inicie a gravação. O progresso reflete lotes confirmados pelo banco; a conclusão apresenta os resultados reais.

O backup `.json` precisa ser o formato nativo do HIGH CLOSER. JSON genérico exportado por outro CRM não substitui CSV/XLSX. O caminho JSON preserva o comportamento anterior: IDs já existentes são ignorados, sem sobrescrever o lead original. **Importar backup JSON** também continua disponível como ação direta, com as permissões anteriores; a restauração em nuvem usa lotes de até 1.000 registros. A permissão nova para migrar CSV/XLSX não retira nem amplia as permissões do backup.

## Duplicados, conflitos e retomada

- E-mail e telefone são normalizados para comparar identidades somente dentro da empresa de destino. O importador também confere repetições dentro do próprio arquivo.
- O identificador de origem só deve ser utilizado com uma origem identificada e confiável. Não reutilize a mesma origem para exportações de sistemas ou contas diferentes.
- Uma correspondência confiável é ignorada por padrão: nenhum lead existente é atualizado ou mesclado.
- Quando e-mail e telefone apontam para registros diferentes, o importador sinaliza conflito. Revise os contatos no CRM e no arquivo; ele não escolhe automaticamente qual pessoa é a correta.
- Uma linha ignorada não acrescenta seu telefone ou e-mail ao lead encontrado. Por exemplo, se uma linha repetir o e-mail de um cliente existente, mas trouxer outro telefone, esse telefone não passa a pertencer ao cliente. Uma linha posterior com outro e-mail e esse telefone continua sendo analisada independentemente, inclusive quando estiver em outro lote.
- O banco repete a validação no momento de importar, incluindo importações simultâneas. A prévia é uma conferência do momento; o relatório final pode apresentar mais duplicados se outra operação tiver cadastrado o contato nesse intervalo.
- Cada lote é transacional: um erro de validação não deixa parte daquele lote gravada. Lotes anteriores confirmados permanecem salvos se um lote posterior falhar.
- Em caso de interrupção, leia o número de registros efetivamente importados. Use a opção de tentar novamente ou reabra a importação com **o mesmo arquivo e os mesmos mapeamentos**. As chaves de origem/importação e as identidades existentes permitem ignorar registros já gravados, inclusive linhas sem telefone ou e-mail. Alterar a identidade ou os mapeamentos pode representar dados diferentes; revise antes de repetir.
- Não é necessário apagar a base para retomar. Uma importação não apaga ou substitui oportunidades existentes.

## Informações e valores padrão

Podem ser preservados nome, empresa, e-mail, telefone, origem, ticket estimado, etapa, responsável, data/horário da call, comparecimento, objeções, notas, dor principal, urgência, capacidade financeira, poder de decisão, valor fechado, motivo de perda e datas de criação, último contato e fechamento, quando compatíveis com as regras atuais.

Valores financeiros devem corresponder ao formato escolhido. O formato brasileiro aceita, por exemplo, `12.345,67`; o internacional aceita `12,345.67`. No formato automático, valores ambíguos são recusados para não trocar silenciosamente milhares por decimais. Confira a prévia antes de importar.

Datas brasileiras seguem dia/mês/ano; datas ISO também são aceitas. Calls precisam incluir horário. Datas sem um deslocamento explícito usam o fuso selecionado e são armazenadas em UTC; a interface apresenta o horário local. Células de data do Excel são lidas como datas, não como valores financeiros, respeitando os sistemas de datas 1900 e 1904 da pasta de trabalho. Como o Excel não inclui fuso nas células, o horário da planilha é interpretado no fuso selecionado. Datas inexistentes ou um fuso inválido são erros e não devem ser corrigidos por suposição.

Na ausência de informação, o importador usa ticket e valor fechado zero, comparecimento **Pendente**, urgência **Média**, capacidade financeira **Não avaliada**, poder de decisão falso e campos descritivos vazios. Esses são padrões internos de compatibilidade e não comprovação de uma avaliação ou call realizada. Datas internas obrigatórias de criação/contato ausentes podem receber o instante da importação para cumprir a persistência; a origem técnica é identificada nos metadados de importação. Essa referência não representa um contato feito nem um acontecimento comercial histórico. Calls e fechamentos ausentes continuam sem data e não são fabricados.

Uma data de call passada não marca comparecimento. Ganho exige os dados de fechamento previstos no sistema. Perda exige um motivo compatível. O importador não inventa gravações, notas de avaliação, feedback de liderança ou eventos antigos. A criação normal do lead pode produzir os registros de criação/auditoria já previstos na aplicação, sempre sem reconstruir a história do CRM anterior.

## Limites e segurança

- Arquivo: até **10 MiB**.
- Linhas: até **10.000 registros**, além do cabeçalho; bases com 2.000 ou mais leads são divididas em lotes seguros.
- Colunas: até **100**; conteúdo de uma célula: até **10.000 caracteres**.
- Excel: até **20 abas**, com limite de **64 MiB de conteúdo descompactado** para evitar arquivos desproporcionais. `.xls` não é suportado.
- Cada chamada de prévia/gravação usa até **500 linhas** e um orçamento de **900 KiB** para os registros; o cliente reduz o lote quando os textos são maiores. O limite de tamanho do arquivo não garante que todos os valores sejam válidos para os campos do CRM.
- A prévia acumula referências opacas para conferir repetições entre lotes: até **10.000 referências** e **4 MiB**, vinculadas à mesma empresa. Essas referências não incluem dados de contato em texto nem IDs reais de leads existentes, ficam apenas na memória do importador e nunca substituem a verificação de identidade/autorização do banco durante a gravação.

A leitura e a normalização do arquivo ocorrem localmente no navegador, com processamento separado para evitar bloquear a interface. A conferência de duplicados existentes usa RPCs autenticadas no banco; ela não depende de baixar todos os leads da empresa para comparação. O arquivo original não é enviado ao armazenamento público. Somente os registros normalizados e as referências necessárias à conferência/importação são enviados ao Supabase autenticado. Ao fechar, sair da conta ou trocar de empresa, o arquivo e a prévia saem da memória dessa janela; dados já confirmados no banco permanecem salvos.

**Admin e Manager da própria empresa** podem migrar CSV/XLSX. Closer e Viewer não recebem essa permissão. O Master da plataforma não ganha acesso a consultar, importar ou exportar leads por ser Master: também precisa de um vínculo ativo e autorizado na empresa. As regras anteriores de backup JSON são mantidas separadamente.

As RPCs verificam autorização, empresa, etapa, responsável, dados e duplicidade. Não existe service role no navegador. Auditorias administrativas registram contagens e informações técnicas necessárias, sem nomes, e-mails, telefones ou notas dos leads. O suporte pode orientar o usuário sem acessar sua base comercial.

Trate a planilha exportada como dado pessoal/confidencial: compartilhe-a apenas com pessoas autorizadas, mantenha cópia de segurança protegida, evite prints com dados reais e remova a exportação de computadores compartilhados depois da migração. Não cole a base nem tokens em chats ou chamados de suporte.

## Verificação e publicação

Os testes de navegador usam fixtures de HTTP para verificar componentes, contratos do SDK, prévia, progresso, erros, retomada, temas e responsividade. Essas simulações não substituem os testes reais PostgreSQL de RLS, transações, concorrência e isolamento. O resultado consolidado de build, testes de banco e deploy deve ser registrado após a validação da versão publicada.

Na retomada, passaram **33 casos distintos de navegador do importador**: 31 em uma execução completa e mais dois cenários adicionados de troca de empresa/logout enquanto o primeiro lote aguardava confirmação. A validação inclui 2.001 registros visíveis depois da atualização e recarga, restauração JSON direta de 2.001 leads em lotes originais de 1.000, prévia em lotes de 500, retomada de falha, duplicados sem mesclagem indevida entre lotes, respostas inválidas, confirmação duplicada, mudança de escopo e 24 capturas com dados fictícios em temas claro/escuro e larguras de 390/1.366 px.

Esses testes demonstram também o limite da interrupção: sair da conta ou mudar de empresa aborta a conexão do cliente e impede os próximos lotes, mas não desfaz um lote que o servidor já aceitou. A interface deixa de mostrar os dados da empresa anterior. Para voltar à importação interrompida, confira os registros e repita o mesmo arquivo/mapeamento de forma idempotente.

Validação local da implementação consolidada: **487 testes unitários**, **246 casos distintos de navegador** (33 do importador e 213 regressões), **1.440 assertivas PostgreSQL**, incluindo 232 da importação e **22 cenários de concorrência**, e **49 verificações isoladas do provisionamento**, todos aprovados. Três timeouts de navegador sob execução simultânea passaram ao repetir somente os casos afetados com um worker, sem alteração da aplicação. O build de produção passou; permanece o aviso de tamanho do bundle principal já existente. O importador e o leitor em worker são carregados separadamente. A auditoria das dependências de produção não encontrou vulnerabilidades.

A revisão da retomada confirmou interface CSV/XLSX, leitura, mapeamentos, etapas/responsáveis e RPCs já implementados; o trabalho existente foi preservado. Foram estabilizados validação XLSX, precisão das datas, progresso inicial, deduplicação entre lotes sem mesclagem, transações, concorrência com edição/exclusão, retomada e carregamento paginado dos leads. As migrations 001–009 continuam intactas; a 010 é uma migração adicional.

### Prova real em produção — 13/10/2026

O commit funcional `e033c8dc46d370e962271378c39cebd62dc69a86` foi enviado à branch `main`. A Vercel publicou o deploy `dpl_oCsqqB6fgAQoAC64AWkcTcXwUUFz`, em estado **READY**, e confirmou a mesma versão no endereço [HIGH CLOSER](https://closer-os-rho-three.vercel.app/). O build instalou a migration 010 em transação, conferiu os checksums das dez migrations e validou as 18 tabelas públicas com RLS. Nenhuma migration instalada foi reescrita.

Passaram **138 verificações reais de Auth, REST/RPC, RLS e navegador**, usando seis contas confirmadas e duas empresas temporárias, separadas dos clientes:

- CSV UTF-8/BOM com ponto e vírgula, aspas e campos multilinha; mapeamento de dados, etapas próprias, responsáveis reais, confirmação, progresso e visualização nas cinco etapas.
- CSV com **2.001 leads**, efetivamente gravados em cinco lotes de 500/500/500/500/1, encontrados no CRM após atualização e recarga. A última linha também apareceu na busca, sem truncamento em 1.000 resultados. Outros 2.000 registros foram testados diretamente nas RPCs, incluindo repetição sem duplicação.
- XLSX com duas abas, escolha da aba, datas no sistema 1904, precisão de milissegundos, valores financeiros e células vazias, seguido de leitura dos valores efetivamente persistidos no Supabase.
- Restauração JSON nativa, incluindo o acesso próprio de um Closer; o registro usado como sentinela manteve todos os valores, IDs, responsável, etapa e timestamps.
- Duplicados por contato/origem/linha, conflitos, prévia entre lotes sem mesclar contatos ignorados, concorrência, rollback de lote inválido e retomada idempotente após perda deliberada da resposta de um commit, inclusive depois de editar os contatos do lead já gravado.
- Admin/Manager da empresa autorizados; Closer/Viewer/Master sem vínculo e acesso anônimo bloqueados no novo fluxo; dados comerciais isolados entre empresas, assinatura pausada e auditoria sem dados comerciais extras.
- Temas claro/escuro, desktop/mobile, 29 capturas com dados fictícios, cinco workers locais e 19 chamadas reais do importador no navegador. Zero erros de JavaScript, envio de e-mails ou upload do arquivo original para storage.

A limpeza foi verificada no Auth e no banco: seis contas, duas empresas e todos os seus dados temporários removidos. Uma comparação por hash dos **454 registros anteriores nas 18 tabelas** não encontrou alteração, exclusão nem nova linha remanescente. Os relatórios operacionais e a comparação ficam fora do repositório, protegidos no workspace; não incluem credenciais no frontend.

A verificação pública conferiu HTTP 200, sete assets incluindo chunks do importador e worker, modelo CSV disponível, ausência de credenciais privilegiadas nesses arquivos e os guards HTTP 405 das APIs existentes. **CSV, XLSX, mapeamento e deduplicação estão validados e publicados.** Não há configuração manual nova no Supabase ou Vercel para esta entrega; a migration 010 foi instalada pelo provisionamento já configurado.

## Implementação e manutenção

- `src/components/ImportLeadsWizard.tsx` e `src/components/import-leads.css`: janela guiada, mapeamentos, prévia, confirmação explícita, progresso, relatório e proteção ao mudar de empresa/conta.
- `src/lib/lead-import-reader.ts`, `lead-import-worker.ts` e `lead-import-normalization.ts`: leitura local com Papa Parse para CSV e read-excel-file para XLSX, limites de arquivo/expansão, validação e normalização dos valores. Fflate verifica os limites reais de descompactação antes de analisar a planilha.
- `src/lib/lead-import-types.ts` e `lead-import-service.ts`: contratos, chamadas autenticadas em lotes, contexto opaco da prévia, validação estrita das respostas e contagens confirmadas/interrompidas.
- `src/App.tsx`, `src/SaaSApp.tsx`, `src/lib/cloud-types.ts`, `src/lib/useCloudData.ts` e `src/lib/cloud-leads.ts`: entrada em Configurações, contexto de empresa, preservação do JSON e atualização paginada da base no CRM depois da operação. A paginação serve para exibir a base, não para comparar duplicados no navegador.
- `supabase/migrations/202610120010_external_lead_import.sql`: migration nova, verificações de permissão e identidade, RPCs de prévia/importação e proteção de concorrência. Migrations anteriores e a RPC de backup nativo não são renomeadas nem alteradas.
- `tests/lead-import-reader.test.ts`, `tests/smart-import.spec.ts`, fixtures, helpers e `supabase/tests/external-lead-import.sql`: leitura, contratos, fluxos de interface e testes reais de banco; `scripts/test-database.sh` integra o novo conjunto à validação existente.
- `public/modelo-importacao-leads.csv`: modelo distribuído aos usuários. `package.json`/`package-lock.json` registram as dependências de leitura; não há upload do arquivo original em bucket público.

O deploy em nuvem usa o provisionamento versionado existente para aplicar a migration nova. O importador reutiliza a configuração Supabase atual; não precisa de novo SMTP, bucket público nem service role no frontend. Uma instalação que aplique migrations manualmente deve instalar a migration 010 depois das anteriores e conferir as permissões das RPCs antes de liberar a interface.
