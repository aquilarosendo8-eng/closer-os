# HIGH CLOSER — Sales Performance System

Marca principal: **HIGH CLOSER**. Descriptor institucional: **Sales Performance System**.

High Closer é um Sales Performance System para operações que vendem por call, unindo CRM, pipeline, pós-call, performance e desenvolvimento comercial. CRM continua sendo o nome de uma capacidade, não a identidade principal do produto.

## Aplicação da identidade

- Sidebar e acesso: marca textual compartilhada, com descriptor menor e discreto, preservando Manrope/DM Sans e as paletas existentes.
- Header interno: marca e descriptor também disponíveis no Admin e na conta, sem alterar o nome da empresa do cliente.
- Login, cadastro, recuperação, definição de senha, convites, ativação, documentos legais e estados de acesso: identidade HIGH CLOSER.
- Footer, descrições, mensagens de importação e nomes de arquivos exportados: nova marca; formatos, dados e compatibilidade de backups preservados.
- Título do navegador, descrição e favicon: HIGH CLOSER.
- README e documentação operacional/comercial: nova nomenclatura.
- E-mails: [modelos e assuntos](../emails/auth/README.md) preparados; os templates externos continuam dependentes de aplicação no painel, porque o Supabase foi preservado nesta tarefa.

## Referências técnicas preservadas

`closer-os` continua no nome do pacote/repositório/projeto, domínio de produção, URLs técnicas, caminhos operacionais, containers e chaves de armazenamento `closer-os-*-v1`, incluindo a preferência de tema. As migrations aplicadas e seus checksums são imutáveis. Referências históricas e identificadores de fixtures/ferramentas não são identidade pública. Nomes de empresas ou perfis fornecidos pelos clientes são dados e não foram renomeados.

Não há migration nova nem alterações em SQL/RLS, APIs, autenticação, permissões, métricas, pipeline, calls, convites, planos ou regras de negócio. A única alteração em `useCloudData.ts` é o nome do produto em uma mensagem de erro; os testes de exportação acompanham somente o novo nome visível dos arquivos.

## Arquivos

- Identidade: `src/components/BrandLockup.tsx`, `src/components/brand.css`, `src/main.tsx`, `index.html`, `public/high-closer.svg`.
- Textos e aplicação: `src/App.tsx`, `src/SaaSApp.tsx`, `src/components/{AuthScreen,Administration,LegalPage}.tsx`, `src/lib/useCloudData.ts`.
- E-mails: `emails/auth/{invite,confirmation,recovery,magic-link,email-change,reauthentication}.html`, `subjects.json` e README.
- Documentação: README, `supabase/README.md`, `docs/{COMERCIALIZACAO,DESIGN-SYSTEM,OPERACAO,PIPELINE-E-CALLS,PRIVACIDADE,TERMOS,REBRANDING}.md`.
- Testes existentes: `tests/{admin,crm}.spec.ts`, somente expectativas de nomes de arquivos exportados.

## Verificação em 08/10/2026

Build aprovado; 123 testes unitários e 90 E2E existentes aprovados: 10 CRM, 44 SaaS/Admin, 15 temas e 21 pipeline/pós-call. As suítes cobrem login, cadastro, recuperação, ativação/convites, Admin, conta, Dashboard, Pipeline, Calls e Performance. Temas claro/escuro e resoluções de desktop, notebook, tablet e mobile foram conferidos, incluindo capturas visuais. Não foi criada migration nem executado teste que altere o banco de produção.

A revisão visual adicional conferiu oito telas públicas (login, recuperação, cadastro e convite em desktop/mobile) e o modelo de e-mail de convite nas duas larguras, sem overflow ou erro de navegador. As duas funções de convite no output da Vercel mantêm fontes idênticos aos arquivos originais. O JavaScript público foi verificado contra três credenciais privadas do servidor, sem exposição.

A publicação visual utiliza `vercel build --prod` com configuração temporária fora do checkout e `buildCommand: npm run build`, seguida de deploy prebuilt. Não executa `build:cloud`, provisionamento ou migrations. O `vercel.json` do projeto, as variáveis e a configuração de autenticação permanecem inalterados.
