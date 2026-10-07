# Closer OS

CRM para closers high ticket, com dashboard, pipeline, avaliação de calls e evolução da equipe.

Aplicação publicada: **https://closer-os-rho-three.vercel.app/**. O acesso aos dados de clientes exige login, empresa autorizada e assinatura válida. A demonstração pública em `?demo=1` usa armazenamento separado, sem ler os leads pessoais da versão anterior.

## Recursos

- **CRM:** leads, empresa, contato, ticket previsto, origem, data da call, comparecimento, objeções, etapa, valor fechado e observações. Ao fechar uma venda, os indicadores são recalculados; oportunidades abertas sem contato há mais de cinco dias aparecem em vermelho.
- **Dashboard:** receita, calls realizadas, show rate, close rate, ticket médio, meta e comissão projetada. Gráficos mensais de receita e fechamento, além de qualificados versus fechados.
- **Calls e performance:** nota de 0 a 10, erros recorrentes, dor, urgência, capacidade financeira, decisor, objeções e evolução semanal. A leitura assistida de resumos usa regras locais e sugestões editáveis; não chama um provedor de IA.
- **Contas privadas:** Supabase Auth, confirmação de e-mail, criação/alteração/recuperação de senha e saída. Uma conta sem convite aceito não acessa o CRM.
- **Empresas e equipe:** isolamento no PostgreSQL por RLS, quatro papéis, convites revogáveis, desativação de membros, atribuição de leads e limites de assentos.
- **Administração da plataforma:** criação de clientes, planos individual/equipe, períodos de teste e controle manual de assinaturas. O papel da plataforma não concede acesso aos leads de um cliente.
- **Dados:** CSV, backup JSON, importação sem sobrescrever IDs existentes e migração explícita dos leads pessoais do navegador. O administrador da empresa dispõe de portabilidade, política de retenção, transferência de responsabilidade e exclusão com confirmação.

Receita usa a data de fechamento; show rate exclui calls pendentes; close rate divide vendas fechadas por comparecimentos. A comissão é uma projeção gerencial, não um pagamento conciliado. A central de ajuda descreve os denominadores.

## Executar

Requer Node.js 22.12+ para o frontend e npm. Use Node.js 24 para o ambiente completo, incluindo provisionamento com suporte ao proxy e aos certificados do sistema.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Preencha somente a URL e a chave **pública** do Supabase no arquivo local. Sem configuração, a aplicação exibe a preparação do acesso e permite explorar a demonstração. Nunca coloque chaves secretas em variáveis `VITE_*`.

## Ativar a infraestrutura

1. Conecte um projeto Supabase à Vercel pela integração oficial. A configuração do Vite reconhece as variáveis públicas da integração; `.env.example` também mostra a configuração explícita.
2. Configure as credenciais de provisionamento e `CLOSER_OWNER_EMAIL`/`CLOSER_APP_URL` no ambiente protegido da Vercel conforme [Operação](docs/OPERACAO.md) e [Backend](supabase/README.md). O schema desta implantação foi instalado pelo provisionamento do build. Em instalações novas, o mesmo procedimento aplica a migration uma vez; nas seguintes, confere versão/checksum e RLS. A conexão mantém a verificação TLS, incluindo o [certificado público do Supabase](scripts/certs/README.md).
3. Configure o domínio nas URLs permitidas do Auth, confirmação de e-mail e entrega SMTP. O proprietário define sua própria senha; administradores não recebem senhas de usuários.
4. Publique na Vercel com Node.js 24. `vercel.json` usa `npm ci`, `npm run build:cloud` e a saída `dist`. `build:cloud` verifica/provisiona o banco antes de gerar o frontend; não envia convites automaticamente em cada deploy. Alterar variáveis públicas requer novo deploy.
5. Entre como proprietário da plataforma, crie a empresa cliente e compartilhe o convite do administrador. Um cliente novo começa com plano individual, um assento e 14 dias de teste; amplie o plano antes de convidar a equipe.

Conectar a integração fornece configurações; o build configurado é que instala/verifica as tabelas e regras do CRM. O código também não configura automaticamente as URLs do Supabase Auth nem contrata domínio, SMTP, backup gerenciado ou provedor financeiro.

## Papéis

| Perfil | Escopo |
| --- | --- |
| Administrador da plataforma | Clientes, assinaturas e gestão de acessos. Para consultar CRM precisa de vínculo explícito com a empresa. |
| `admin` | Leads, equipe, metas e operações de privacidade da própria empresa. |
| `manager` | Leads da empresa, distribuição de responsáveis, metas e consulta da equipe. Não promove membros nem administra cobrança. |
| `closer` | Consulta e edição dos leads atribuídos a si. |
| `viewer` | Consulta dos leads da empresa, sem edição e sem exportação pela interface. |

O banco valida as permissões mesmo em chamadas diretas à API. Desativação, vencimento e suspensão são conferidos a cada requisição; não dependem de esconder botões.

## Validação

```bash
npm test
npm run build
npm run test:e2e
npm run test:saas
npm run test:db
```

Os testes cobrem métricas/validação, demonstração, autenticação, administração e isolamento no banco. `test:saas` reúne 20 fluxos de navegador com respostas simuladas da API para verificar autenticação/administração, incluindo ativação por convite de Auth e recuperação. `test:db` executa a migration e **127 verificações reais** em um banco PostgreSQL isolado, incluindo disputas concorrentes por assentos e convites. Esses comandos não usam o projeto Supabase de produção.

No Supabase conectado, `scripts/test-live.mjs` foi executado com **59 verificações reais de Auth/REST/RLS**: login, convites, papéis, isolamento entre empresas, persistência, distribuição de leads, suspensão e desativação. As contas, empresas e demais fixtures temporárias foram removidas ao concluir. Essa verificação exige credenciais protegidas e autorização para criar fixtures; não faz parte automática da suíte local. Ela não testa entrega de e-mails nem restauração de backups.

Os testes de navegador usam `/usr/bin/chromium` quando disponível. Em outra máquina, defina `CHROMIUM_PATH` ou instale o browser com `npx playwright install chromium`. O teste de banco requer Docker com PostgreSQL 17. Consulte [Backend](supabase/README.md) para o isolamento e a limpeza dos recursos de teste.

## Operação comercial

Consulte o [checklist de comercialização](docs/COMERCIALIZACAO.md) e os procedimentos de [operação, acesso, migração e recuperação](docs/OPERACAO.md).

A cobrança nesta versão é **manual**: após confirmar o pagamento por um canal externo, o operador atualiza a assinatura. Não há checkout, renovação financeira automática, webhook de pagamento, emissão fiscal, gravação/transcrição de calls, calendário ou WhatsApp integrado.

Os [termos](docs/TERMOS.md) e a [política de privacidade](docs/PRIVACIDADE.md) são modelos pendentes de identificação do operador e condições comerciais. Os documentos na interface também são provisórios. SMTP, suporte, backups, recuperação e revisão dos textos precisam corresponder aos serviços e procedimentos efetivamente configurados.

## Estrutura

- `src/SaaSApp.tsx`: sessão, convites, seleção de empresa, bloqueio de acesso e conta.
- `src/App.tsx` e `src/components/`: CRM, autenticação, administração, relatórios e interface.
- `src/lib/`: cliente público Supabase, acesso, dados na nuvem, métricas e validação.
- `supabase/migrations/`: schema, RPCs, isolamento e auditoria.
- `scripts/`: provisionamento seguro e testes PostgreSQL isolados.
- `tests/`: testes unitários e de navegador.
- `docs/`: operação, comercialização e modelos de documentos.
