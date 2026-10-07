import { FileText, ShieldCheck } from 'lucide-react'

export type LegalDocument = 'terms' | 'privacy'

interface LegalPageProps { document: LegalDocument; contactEmail?: string }

export default function LegalPage({ document, contactEmail }: LegalPageProps) {
  const terms = document === 'terms'
  return <article className="legal-document">
    <span className="legal-icon">{terms ? <FileText size={24} /> : <ShieldCheck size={24} />}</span>
    <p className="auth-eyebrow">CLOSER OS</p>
    <h2 id="auth-legal-title">{terms ? 'Termos de uso' : 'Política de privacidade'}</h2>
    <p className="legal-intro">Documento operacional provisório. A identificação da empresa responsável, as condições comerciais e os prazos aplicáveis precisam ser definidos pelo operador antes da oferta comercial.</p>
    {terms ? <>
      <section><h3>1. O serviço e o acesso</h3><p>O Closer OS organiza leads, reuniões e indicadores comerciais. O acesso ocorre por convite, vinculado a uma empresa e a permissões definidas pelo administrador. O convite é pessoal e não deve ser repassado a terceiros.</p></section>
      <section><h3>2. Sua conta</h3><p>Use informações corretas, mantenha sua senha protegida e não compartilhe credenciais. Solicite a desativação de acessos que deixarem de ser necessários. O administrador da empresa gerencia usuários e a visibilidade dos registros dentro de seu workspace.</p></section>
      <section><h3>3. Uso dos dados</h3><p>Cadastre somente informações que você esteja autorizado a tratar. A empresa cliente é responsável pela origem dos dados dos leads, pela finalidade do uso e pelo cumprimento da legislação aplicável. Não utilize o serviço para atividades ilícitas ou para acessar dados de outra empresa.</p></section>
      <section><h3>4. Planos e pagamento</h3><p>Preço, limites de usuários, período contratado, renovação, cancelamento, eventual teste e condições de reembolso devem constar na proposta ou no contrato apresentado antes da compra. Estas condições não são substituídas por este documento.</p></section>
      <section><h3>5. Indicadores e disponibilidade</h3><p>Os indicadores dependem das informações cadastradas e não garantem resultados comerciais. Leituras assistidas e sugestões devem ser revisadas pelo usuário. Manutenções e incidentes podem afetar a disponibilidade; compromissos de suporte e disponibilidade devem ser definidos no contrato aplicável.</p></section>
      <section><h3>6. Encerramento do acesso</h3><p>O administrador pode revogar convites e desativar usuários da própria empresa. A exportação, a retenção e a exclusão de dados após o encerramento devem seguir a política contratada e os deveres legais aplicáveis.</p></section>
    </> : <>
      <section><h3>1. Quais informações são tratadas</h3><p>O serviço trata dados de conta, como nome e e-mail, vínculo com a empresa, permissões e registros operacionais. Os dados comerciais incluem contatos dos leads, empresas, reuniões, notas, objeções, valores e observações inseridas pelos usuários. Evite incluir informações sensíveis sem necessidade e autorização.</p></section>
      <section><h3>2. Para que usamos essas informações</h3><p>Os dados permitem autenticar usuários, controlar permissões, organizar a operação comercial, calcular indicadores, gerenciar convites, enviar recuperação de senha e investigar falhas ou alterações relevantes. Dados comerciais de uma empresa não devem ser disponibilizados a outra empresa.</p></section>
      <section><h3>3. Quem controla os dados</h3><p>A empresa cliente define a finalidade e a legitimidade do tratamento dos dados comerciais que cadastra. O operador do Closer OS fornece a infraestrutura e deve documentar suas responsabilidades e os fornecedores envolvidos. A identificação e o contato desse operador devem ser fornecidos antes da contratação.</p></section>
      <section><h3>4. Infraestrutura e proteção</h3><p>Na versão conectada, a aplicação utiliza hospedagem, autenticação, banco de dados e serviços de envio de mensagens. Os fornecedores e a localização do tratamento devem ser informados pelo operador. As permissões são verificadas nos serviços de dados. Senhas são tratadas pelo serviço de autenticação; administradores não precisam conhecer sua senha.</p></section>
      <section><h3>5. Armazenamento local e demonstração</h3><p>A versão anterior pode manter leads no navegador. Um backup local só é baixado quando você solicita; uma importação para a nuvem deve ser feita após autenticação e para a empresa correta. A demonstração é separada do ambiente de clientes e usa dados fictícios. A sessão de login utiliza o armazenamento do navegador para manter seu acesso.</p></section>
      <section><h3>6. Retenção e seus direitos</h3><p>Você pode solicitar informações sobre o tratamento, correção, exportação e exclusão, conforme a legislação e os deveres de retenção aplicáveis. Os prazos de retenção e de atendimento devem ser definidos pelo operador. Para dados de leads de uma empresa, procure também o administrador dessa empresa.</p></section>
    </>}
    <section><h3>7. Contato</h3>{contactEmail ? <p>Para suporte e solicitações sobre seus dados, escreva para <a href={`mailto:${contactEmail}`}>{contactEmail}</a> ou procure o administrador da sua empresa.</p> : <p>Procure o administrador da sua empresa para suporte e solicitações sobre seus dados. O operador deve informar seu canal de atendimento antes da contratação.</p>}</section>
  </article>
}
