# Integrações — Formulários e entrada automática de leads

**Estado: validação local concluída; publicação e confirmação em produção pendentes.** A implementação passou nas suites de código, banco e navegador. O fluxo real no domínio publicado será registrado abaixo após sua execução.

A integração recebe preenchimentos de um formulário existente e cria leads comuns do HIGH CLOSER. O fluxo é: formulário → webhook POST → credencial → configuração da empresa → campos mapeados → duplicidade → lead, Timeline e log. Depois de recebido, o lead usa Pipeline, Lead 360, filtros e indicadores existentes, conforme suas regras e permissões.

## Criar e conectar

1. Entre como administrador ativo da empresa e abra **Administração → Integrações → Formulários e Webhooks**.
2. Clique em **Nova integração**. Informe nome e origem padrão, por exemplo, “Formulário principal” e “Formulário Site”.
3. Escolha uma etapa ativa do tipo **NORMAL** no pipeline padrão dessa empresa, por exemplo, Lead novo. Escolha um responsável ativo com permissão de edição. Administrador, gestor e closer podem ser responsáveis; visualizador não pode.
4. Configure os nomes exatos das propriedades que o formulário enviará. Nome é obrigatório; recomendamos e-mail ou telefone para identificar reenvios.
5. Salve e copie a **URL do Webhook** apresentada. Ela funciona como uma senha e só aparece na criação ou redefinição. Guarde-a na configuração privada do serviço que enviará os dados.
6. No formulário ou automação, configure **POST**, o formato aceito e o payload correspondente ao mapeamento.
7. Envie um contato de teste e confira o lead no Pipeline, seu responsável e origem no Lead 360, o evento na Timeline e o resultado em **Logs**. Envie o mesmo contato novamente: o resultado deve ser `duplicate`, preservando o lead existente.

**Testar integração**, disponível junto da credencial recém-gerada, envia os dados ao mesmo endpoint usado pelo formulário. **Enviar teste real** cria um lead quando o contato ainda não existe. Confira o payload antes de enviar. Ao fechar o painel, o token deixa de ficar disponível na interface; caso tenha perdido a credencial, redefina-a e atualize o serviço externo.

## Mapeamento e valores

O mapeamento relaciona uma propriedade externa a um dos sete campos do CRM:

| Propriedade externa do exemplo | Campo HIGH CLOSER | Regra do recebimento |
| --- | --- | --- |
| `full_name` | `name` — Nome | Obrigatório; texto de até 200 caracteres. |
| `email_address` | `email` — E-mail | Opcional; até 254 caracteres e formato de e-mail válido. |
| `whatsapp` | `phone` — Telefone / WhatsApp | Opcional; até 64 caracteres recebidos e 32 dígitos normalizados. |
| `company_name` | `company` — Empresa | Opcional; texto de até 200 caracteres. |
| `estimated_ticket` | `ticket` — Ticket estimado | Opcional; número entre zero e 1.000.000.000.000. |
| `campaign` | `source` — Origem | Opcional; até 120 caracteres. Ausente ou vazio usa a origem padrão. |
| `message` | `notes` — Observações | Opcional; texto de até 10.000 caracteres. |

Exemplo correspondente:

```json
{
  "full_name": "João Silva",
  "email_address": "joao@example.com",
  "whatsapp": "+55 (77) 99999-9999",
  "company_name": "XPTO",
  "estimated_ticket": 15000,
  "campaign": "Landing Page",
  "message": "Quero conhecer a proposta."
}
```

Use os nomes com a mesma grafia e capitalização do payload. A resolução é literal e apenas no primeiro nível: `person.name` procura uma propriedade chamada exatamente `person.name`; não percorre `{ "person": { "name": "…" } }`. Cada nome externo aceita 1–120 caracteres. `__proto__`, `prototype` e `constructor` são rejeitados. Não há execução de expressões, campos personalizados ou interpretação de HTML.

Campos opcionais sem mapeamento ou sem valor usam os defaults do lead: textos vazios e ticket zero. Em JSON, prefira ticket numérico, como `15000.50`; uma string decimal com ponto, como `"15000.50"`, também é aceita. Não envie símbolos de moeda, separadores de milhar ou vírgula decimal. Os campos de texto precisam ser strings; objetos e arrays não são convertidos em texto.

Propriedades extras convencionais são ignoradas e não são despejadas nas observações. Os limites de tamanho, profundidade e propriedades seguras continuam valendo para todo o payload, inclusive campos não mapeados. `workspaceId`, `stageId`, `ownerId` e semelhantes não escolhem empresa, etapa ou responsável: o servidor usa a configuração da integração.

## Conectar um formulário próprio

Se a plataforma do formulário oferece webhook, cole a URL gerada em sua configuração privada, escolha POST e envie JSON ou `application/x-www-form-urlencoded`. Faça um preenchimento real para conferir o corpo enviado e o resultado no CRM. Se a plataforma permite headers, pode usar a URL sem query e enviar o token em um dos headers documentados abaixo.

Para um site próprio, o backend que recebe o formulário faz o POST ao HIGH CLOSER. Mantenha a credencial no servidor ou no serviço de automação; evite publicá-la em HTML, JavaScript do site ou repositório. O endpoint se destina a webhooks de servidor e não oferece CORS aberto para requisições de páginas de qualquer domínio. Um formulário que só entrega respostas aninhadas precisa ser transformado antes do envio.

## Conectar pelo Make, Zapier ou n8n

Configure o evento de novo preenchimento do formulário como gatilho. Em seguida, use uma ação HTTP POST para a URL do HIGH CLOSER, com `Content-Type: application/json`, montando um objeto com as propriedades configuradas na integração. Confira a resposta da ação e o log no CRM antes de habilitar o fluxo para todos os preenchimentos.

Webhooks nativos de Tally e Typeform podem conter objetos, arrays de respostas e identificadores de perguntas. Nesta versão, transforme essas respostas em propriedades simples, por exemplo `full_name`, `email_address` e `whatsapp`, no Make, Zapier, n8n ou backend próprio. Colar a URL no serviço sem adaptar esse corpo não garante o mapeamento. As conexões e credenciais dessas ferramentas são configuradas pelo operador nelas; não existe OAuth, app ou node próprio do HIGH CLOSER nesta versão.

## Requests e autenticação

O endpoint é **POST `/api/inbound-leads`**, no domínio da aplicação. Aceita:

- `application/json`: um objeto JSON, não um array na raiz.
- `application/x-www-form-urlencoded`: propriedades simples, com nomes únicos.

O corpo tem limite de **65.536 bytes (64 KiB)**, profundidade máxima de seis níveis e proteção adicional contra estruturas excessivas. Use UTF-8, sem compressão de conteúdo. Multipart, uploads e anexos não são aceitos.

A credencial tem **64 caracteres hexadecimais minúsculos**, gerados de 32 bytes aleatórios, com 256 bits de entropia. Pode ser enviada de três maneiras:

| Opção | Exemplo com placeholder |
| --- | --- |
| URL completa, compatível com serviços sem headers | `https://SEU-DOMINIO.example/api/inbound-leads?token=COLE_A_CREDENCIAL_GERADA_AQUI` |
| Header Bearer | `Authorization: Bearer COLE_A_CREDENCIAL_GERADA_AQUI` |
| Header próprio | `X-High-Closer-Token: COLE_A_CREDENCIAL_GERADA_AQUI` |

Escolha uma opção. Se enviar mais de uma, todas precisam ter o mesmo token; valores conflitantes ou repetição do parâmetro `token` são recusados. A chave pública do Supabase e a sessão de login de um usuário não substituem essa credencial.

Os comandos abaixo são modelos: substitua o domínio e a credencial pelos dados gerados na interface e use as propriedades do seu mapeamento. Um envio com dados válidos pode criar um lead real.

JSON com os campos padrão `name`, `email`, `phone`, `company` e `ticket` mapeados para propriedades de mesmo nome:

```bash
curl --request POST 'https://SEU-DOMINIO.example/api/inbound-leads' \
  --header 'Content-Type: application/json' \
  --header 'Authorization: Bearer COLE_A_CREDENCIAL_GERADA_AQUI' \
  --data '{"name":"João Silva","email":"joao@example.com","phone":"+5577999999999","company":"XPTO","ticket":15000}'
```

Form-urlencoded, usando a URL completa e o mesmo mapeamento padrão:

```bash
curl --request POST 'https://SEU-DOMINIO.example/api/inbound-leads?token=COLE_A_CREDENCIAL_GERADA_AQUI' \
  --header 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'name=João Silva' \
  --data-urlencode 'email=joao@example.com' \
  --data-urlencode 'phone=+5577999999999' \
  --data-urlencode 'company=XPTO' \
  --data-urlencode 'ticket=15000'
```

## Respostas e diagnóstico

Novo lead, HTTP **201**:

```json
{"status":"created","leadId":"UUID_DO_NOVO_LEAD","requestId":"UUID_DA_REQUISICAO"}
```

Contato já existente na empresa, HTTP **200**:

```json
{"status":"duplicate","leadId":"ID_DO_LEAD_EXISTENTE","requestId":"UUID_DA_REQUISICAO"}
```

Erro de nome obrigatório, HTTP **422**:

```json
{"status":"rejected","requestId":"UUID_DA_REQUISICAO","error":{"code":"NAME_REQUIRED","message":"Informe o nome no campo configurado para esta integração."}}
```

`requestId` é gerado no servidor e permite localizar um recebimento identificado nos logs. Erros retornam código e mensagem em português; falhas de serviço usam `status: "error"`. As respostas não devolvem token, payload, detalhes internos de SQL ou stack trace.

| HTTP | Códigos / ação recomendada |
| --- | --- |
| 400 | `INVALID_BODY`, `BODY_TOO_DEEP` ou `UNSAFE_PROPERTY`: revise estrutura, propriedades e codificação do corpo. |
| 401 | `INVALID_CREDENTIALS`: confira a credencial e o estado da integração. Credenciais desconhecidas, desativadas, arquivadas e antigas usam resposta genérica. |
| 403 | `WORKSPACE_UNAVAILABLE`: confira a disponibilidade e assinatura da empresa. |
| 405 | `METHOD_NOT_ALLOWED`: envie POST. Abrir a URL no navegador não testa o recebimento. |
| 409 | `STAGE_UNAVAILABLE` ou `OWNER_UNAVAILABLE`: um administrador deve corrigir o destino configurado. |
| 413 | `BODY_TOO_LARGE`: reduza o corpo para até 64 KiB. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` ou `UNSUPPORTED_ENCODING`: use um formato aceito, UTF-8 e sem compressão. |
| 422 | `NAME_REQUIRED`, `FIELD_INVALID` ou `TICKET_INVALID`: corrija os valores ou o mapeamento. |
| 429 | `RATE_LIMITED`: aguarde o prazo informado em `Retry-After` antes de reenviar. |
| 503 | `SERVICE_UNAVAILABLE`: confira os logs antes de tentar novamente; se persistir, acione o operador. |

Não considere um timeout como confirmação de que nada foi gravado. Confira o Pipeline e os logs antes de repetir. Use telefone ou e-mail estáveis para a proteção contra duplicidade.

## Duplicidade e criação do lead

A comparação acontece no banco, na mesma empresa, incluindo leads cadastrados antes desta feature. E-mails são aparados e convertidos para minúsculas. Telefones são comparados pelos dígitos, removendo espaços, parênteses, hífens e outros caracteres de apresentação; o `+` inicial pode ser mantido na gravação. Não há inferência de país, inclusão automática de DDI ou conversão do prefixo `00`: `+44…` e `44…` com os mesmos dígitos coincidem, mas `0044…` permanece diferente. Envie o código do país de forma consistente.

Uma coincidência de telefone **ou** e-mail resulta em `duplicate`; quando as referências apontam para leads distintos, a coincidência de telefone tem prioridade. O lead existente não é atualizado, mesclado ou redistribuído. O mesmo contato pode existir em outra empresa. Sem telefone e e-mail, não há comparação por nome: repetir o envio pode criar outro lead. Contatos compartilhados por pessoas diferentes também podem ser considerados duplicados.

A transação serializa o recebimento por empresa, protegendo envios simultâneos do mesmo contato. Não cria uma restrição global de unicidade nem reescreve leads antigos. O UUID, os horários, a empresa, a etapa e o responsável do novo lead são definidos no servidor. O lead completo recebe defaults de atendimento/call/fechamento compatíveis com a validação atual; `validLead` permanece com suas regras existentes.

A Timeline registra `lead.inbound_received`, com identificação/nome da integração, origem e horário, além do evento normal de criação quando aplicável. Não inclui credencial ou payload bruto. As permissões usuais continuam valendo: por exemplo, um closer acessa o lead recebido apenas quando está atribuído a ele.

## Logs, contadores e limites

**Logs** mostra resultados `created`, `duplicate`, `rejected` e `error`, com horário, ID da requisição, referência ao lead e código seguro de erro. A consulta é paginada. Não armazena token, headers de autorização ou corpo bruto do formulário. Requisições sem integração identificada, métodos incorretos ou falhas anteriores à transação podem não aparecer no log de uma empresa.

Os totais de leads, duplicados e erros na lista são contadores acumulados da integração. Eles permanecem após a limpeza de logs e não equivalem ao número de linhas atualmente visíveis. Rejeições identificadas também contribuem para o contador de erros. Para evitar excesso de linhas durante um bloqueio, `RATE_LIMITED` mantém no máximo um log por integração/minuto, enquanto os contadores continuam registrando as tentativas identificadas.

As cotas são persistentes no PostgreSQL, compartilhadas entre instâncias do servidor, em janelas de minuto e dia em UTC: **120 recebimentos por minuto** e **10.000 por dia** por integração, mais **5.000 por minuto** para a transação global de recebimento. Duplicados e envios recusados identificados também consomem cota. Tokens com formato válido que chegam à RPC consomem a cota global mesmo quando não identificam uma integração. Esse teto não substitui proteções de tráfego na infraestrutura antes da requisição chegar ao banco.

Logs com mais de **90 dias** são elegíveis para exclusão. O recebimento executa limpeza em lotes limitados, sem bloquear um request para varrer todo o histórico. **Isso não garante remoção na data exata nem limpeza quando não há tráfego.** Se a operação exigir um prazo de eliminação garantido, o operador deve agendar, com credencial somente de servidor, `purge_inbound_integration_logs` e conferir sua execução. Nenhum agendamento automático é contratado ou configurado por esta feature.

## Desativar, redefinir ou arquivar

- **Desativar:** impede novos recebimentos depois de confirmado no servidor. Mantém leads, configuração, logs e contadores; pode ser ativada novamente se etapa e responsável continuarem válidos.
- **Redefinir credencial:** gera novo token e invalida o anterior. Copie a nova URL/token no painel e substitua a configuração do formulário ou automação. A integração continua com o mesmo destino e histórico; leads já recebidos são preservados.
- **Arquivar:** desativa e preserva o registro e histórico sujeito à retenção. A integração arquivada não pode ser reativada, editada ou ter sua credencial redefinida. Crie outra integração caso precise de um novo fluxo. Não há hard delete pela interface.

Editar nome, origem, etapa, responsável ou mapping afeta os próximos recebimentos; não modifica os leads existentes. Depois de qualquer mudança no formulário, confira se as propriedades e o formato continuam correspondendo ao mapeamento.

## Arquitetura e operação

`api/inbound-leads.mjs` valida transporte e credencial, calcula SHA-256 e chama uma única RPC `receive_inbound_lead` com cliente Supabase somente de servidor. Essa RPC, restrita a `service_role`, autentica a integração e executa cotas, configuração, mapping, deduplicação, lead, evento e log na mesma transação. Um erro de criação reverte o lead e seus eventos e registra um erro operacional seguro quando a transação permite.

A migration `202610120008_inbound_integrations.sql` adiciona `public.inbound_integrations`, `public.inbound_integration_logs` e contadores privados de cota. As duas tabelas públicas têm RLS e escritas por RPCs autorizadas. A configuração usa referências de empresa para etapa e responsável. O hash não é incluído nas leituras permitidas ao administrador; o token original não é persistido no banco, localStorage, sessionStorage ou metadados Auth. A interface o mantém temporariamente para copiar/testar na criação ou redefinição.

Somente um **administrador ativo da própria empresa** administra integrações e consulta seus logs. Gestor, closer, visualizador e administrador da plataforma sem esse vínculo não recebem esse acesso. O papel da plataforma não libera leads ou payloads do cliente. A leitura dos leads e da Timeline mantém as políticas existentes.

Não há novas variáveis de ambiente obrigatórias. A API reutiliza a URL Supabase e `SUPABASE_SECRET_KEY` ou `SUPABASE_SERVICE_ROLE_KEY` protegida no servidor, como as APIs existentes. O frontend usa apenas sua configuração pública e a URL da aplicação para montar o endereço do webhook. Nunca coloque a chave administrativa em variáveis `VITE_*`, exemplos enviados a clientes ou credenciais do formulário. O build/provisionador deve aplicar a nova migration pendente antes da publicação; migrations anteriores permanecem imutáveis.

A URL com token exige o mesmo cuidado de uma senha: configure-a em um serviço autorizado e evite tickets, capturas, analytics, repositórios ou logs de URLs que a exponham. A aplicação não registra essa URL nos logs de recebimento. Serviços externos e infraestrutura podem ter seus próprios logs; revise a configuração deles. Quando a ferramenta suporta header secreto, essa opção reduz a exposição do token na URL.

Esta versão recebe formulários existentes. Não fornece form builder, landing pages, integrações OAuth individuais, distribuição round robin avançada, atualização automática de duplicados, custom fields, multipart ou anexos. A integração não cria calls, vendas fechadas, mensagens WhatsApp ou pagamentos; o lead segue a operação comercial normal do CRM.

## Validação para a liberação

Validação local executada em 12/10/2026:

- `npm test`: **334 testes passaram**, incluindo 117 do endpoint, 21 do serviço de integrações e a apresentação do novo evento na Timeline.
- `npm run build`: TypeScript e build de produção passaram. O aviso de tamanho do bundle não impede o build.
- Playwright: **163 testes passaram** — integrações 17, SaaS/Admin 44, oportunidades 28, Pipeline/Calls 21, CRM 10, temas 15 e perfil 28. As fixtures de navegador simulam Supabase; o teste de integrações executa o handler real com a persistência simulada.
- `npm run test:db`: **993 assertions passaram** em PostgreSQL descartável, incluindo RLS, grants, mapping, normalização, defaults, quotas, logs e 13 cenários de concorrência. As migrations 001–007 permaneceram intactas.
- Provisionador: **35 verificações passaram** em PostgreSQL descartável, com a camada Auth simulada e bloqueada para qualquer destino externo, incluindo aplicação/repetição, checksums, builders simultâneos e privilégios das novas tabelas/RPCs.

Ainda pendentes: aplicação da migration 008 e deploy em produção; fluxo autorizado Admin → criação → POST externo → lead no Pipeline/Lead 360/Timeline/log; repetição como duplicado; rotação/desativação; isolamento de duas empresas e ausência de credenciais administrativas nos assets publicados. A confirmação real será acrescentada após execução, sem confundi-la com as fixtures locais.
