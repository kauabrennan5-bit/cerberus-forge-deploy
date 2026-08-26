import React from "react";
import { CerberusLogo } from "./CerberusLogo";
import { getConfiguredSocialLinks, INSTITUTIONAL_PATHS, SOCIAL_LABELS, type SocialNetwork } from "../config/institutional";

type InstitutionalPageKind = "privacy" | "terms";

type InstitutionalPageProps = {
  kind: InstitutionalPageKind;
  onBackToSite: () => void;
  onNavigate: (path: string) => void;
};

const LAST_UPDATED = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(new Date());

export const InstitutionalPage: React.FC<InstitutionalPageProps> = ({ kind, onBackToSite, onNavigate }) => {
  const isPrivacy = kind === "privacy";
  return (
    <div className="min-h-[70vh] w-full px-3 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-[#3A342E] pb-6">
          <button type="button" onClick={onBackToSite} className="group flex items-center gap-3 text-left">
            <span className="flex h-11 w-11 items-center justify-center border border-[#8A1F1F] bg-[#0B0908] p-2 tech-frame">
              <CerberusLogo className="h-full w-full" />
            </span>
            <span>
              <span className="block font-gothic text-lg tracking-[0.18em] text-[#E8E1D3] transition-colors group-hover:text-[#8A1F1F]">CERBERUS FINDS</span>
              <span className="block text-[9px] uppercase tracking-[0.24em] text-[#E8E1D3]/55">Curadoria archival & design</span>
            </span>
          </button>
          <button type="button" onClick={onBackToSite} className="border border-[#3A342E] bg-[#181512] px-4 py-2 text-[10px] font-display uppercase tracking-[0.18em] text-[#E8E1D3]/80 transition-colors hover:border-[#8A1F1F] hover:text-[#E8E1D3]">
            Voltar ao acervo
          </button>
        </div>

        <header className="mb-10 max-w-3xl">
          <p className="mb-3 text-[10px] font-display font-semibold uppercase tracking-[0.28em] text-[#C97964]">Documentos institucionais</p>
          <h1 className="font-gothic text-3xl leading-tight text-[#E8E1D3] sm:text-5xl">{isPrivacy ? "Política de Privacidade" : "Termos e Condições"}</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[#E8E1D3]/65 sm:text-base">
            {isPrivacy
              ? "Como a Cerberus Finds trata informações necessárias para o funcionamento do site, da curadoria e das comunicações por e-mail."
              : "As regras simples e transparentes para navegar pelo acervo, explorar seleções editoriais e acessar ofertas de terceiros."}
          </p>
        </header>

        <article className="space-y-9 border border-[#3A342E] bg-[#181512]/80 p-5 sm:p-10">
          {isPrivacy ? <PrivacyContent /> : <TermsContent />}
        </article>

        <InstitutionalFooter onNavigate={onNavigate} onBackToSite={onBackToSite} />
      </div>
    </div>
  );
};

const PrivacyContent: React.FC = () => (
  <>
    <DocSection title="1. Quem é a Cerberus Finds">
      <p>A Cerberus Finds é uma operação individual apresentada publicamente sob a marca Cerberus Finds. A plataforma organiza e apresenta seleções de produtos, objetos e ofertas encontradas pela curadoria.</p>
      <p>Esta página identifica a operação pelo nome público da marca e descreve somente o funcionamento observado no site e nos serviços associados.</p>
    </DocSection>

    <DocSection title="2. Quais informações podem ser tratadas">
      <p>O site pode tratar o endereço de e-mail fornecido quando uma pessoa se inscreve para receber novas seleções, recomendações e ofertas. Também podem ser tratados dados técnicos e de navegação necessários para entregar páginas, manter a segurança, medir o funcionamento e registrar preferências, quando os recursos correspondentes estiverem configurados.</p>
      <p>O projeto possui mecanismos de parâmetros UTM e integrações de analytics/pixels que podem ser ativados por configuração. A presença e o alcance desses recursos dependem da configuração efetiva do ambiente e do navegador utilizado.</p>
    </DocSection>

    <DocSection title="3. Finalidades">
      <p>As informações podem ser utilizadas para registrar e administrar inscrições de newsletter, entregar comunicações autorizadas, permitir o descadastro individual, operar o catálogo, preservar a segurança do serviço, compreender o uso das páginas quando analytics estiver configurado e direcionar a pessoa para páginas de oferta.</p>
      <p>Alguns links apresentados pela Cerberus Finds podem ser links de afiliado. Quando uma compra é realizada no site de terceiro por meio de um desses links, a Cerberus Finds pode receber uma comissão, sem custo adicional necessariamente repassado à pessoa visitante.</p>
    </DocSection>

    <DocSection title="4. Newsletter, consentimento e descadastro">
      <p>A inscrição exige uma ação afirmativa de consentimento para receber comunicações de marketing. O rodapé das mensagens contém um link individual de descadastro, processado pelo mecanismo canônico do projeto em <code>/api/newsletter/unsubscribe</code>. O pedido de descadastro interrompe a elegibilidade para novas campanhas conforme o estado persistido pelo sistema.</p>
      <p>As campanhas processadas pelo backend podem utilizar o provedor de envio Brevo, que aparece na implementação operacional do projeto. O disparo depende dos gates de aprovação e das configurações do ambiente; esta página não autoriza nenhum envio.</p>
    </DocSection>

    <DocSection title="5. Ofertas, terceiros e compartilhamento necessário">
      <p>A Cerberus Finds não conclui a compra, não processa o pagamento e não realiza a entrega dos produtos apresentados. O clique no CTA pode levar a uma página ponte ou ao site de um marketplace/parceiro. As condições finais, disponibilidade, pagamento, entrega e atendimento são definidos pelo terceiro responsável pela oferta.</p>
      <p>Quando necessário para operar o site, a informação pode ser processada por prestadores técnicos configurados no backend. O projeto utiliza Supabase como parte da infraestrutura de persistência. Não são afirmadas localizações específicas de servidores ou práticas além das observadas na implementação.</p>
    </DocSection>

    <DocSection title="6. Segurança e retenção">
      <p>O sistema aplica controles técnicos e operacionais para reduzir acesso indevido e manter a integridade do catálogo, das inscrições e das campanhas. Nenhum sistema elimina todos os riscos.</p>
      <p>As informações são mantidas enquanto necessárias ao estado da inscrição e à operação do serviço. Esta página não estabelece um prazo numérico que não esteja suportado pelo sistema.</p>
    </DocSection>

    <DocSection title="7. Direitos e canal de contato">
      <p>Pedidos de informação, correção, atualização ou exclusão devem ser encaminhados pelo canal oficial da operação. O projeto auditado não contém um e-mail institucional público configurado, portanto nenhum canal é inventado nesta página.</p>
    </DocSection>

    <DocSection title="8. Alterações">
      <p>Esta política pode ser atualizada quando o funcionamento do site, das inscrições, das campanhas ou das páginas de oferta mudar. A versão publicada deve indicar a data da última atualização.</p>
      <p className="text-[#C97964]">Esta Política de Privacidade foi atualizada em {LAST_UPDATED}.</p>
    </DocSection>
  </>
);

const TermsContent: React.FC = () => (
  <>
    <DocSection title="1. Sobre a Cerberus Finds">
      <p>A Cerberus Finds é uma operação individual apresentada publicamente sob a marca Cerberus Finds. A plataforma faz curadoria editorial de produtos e ofertas e direciona visitantes para páginas de parceiros quando aplicável.</p>
    </DocSection>

    <DocSection title="2. Aceitação dos termos">
      <p>Ao navegar pelo site, a pessoa visitante declara que leu estas condições e que utilizará a plataforma de forma lícita, respeitosa e compatível com a finalidade editorial do serviço. Se não concordar, deve interromper o uso.</p>
    </DocSection>

    <DocSection title="3. Funcionamento da plataforma">
      <p>O acervo reúne páginas de produto e conteúdos de curadoria. A disponibilidade do catálogo pode mudar, e o site pode passar por manutenção, atualização ou indisponibilidade temporária.</p>
    </DocSection>

    <DocSection title="4. Produtos, ofertas e preços">
      <p>Produtos, imagens, preços e condições são apresentados conforme dados observados, confirmados ou publicados no catálogo. Informações podem ficar desatualizadas entre a publicação e a visita. O preço e a disponibilidade aplicáveis à compra são os informados pelo terceiro no momento do checkout.</p>
    </DocSection>

    <DocSection title="5. Links de terceiros e afiliados">
      <p>Os CTAs podem direcionar para marketplaces, parceiros ou páginas ponte. A Cerberus Finds não controla o conteúdo, a disponibilidade, o pagamento, a entrega ou o atendimento de sites de terceiros.</p>
      <p>Alguns links podem ser de afiliado. Se a pessoa comprar por um desses links, a Cerberus Finds pode receber uma comissão, sem alterar necessariamente o preço pago por ela.</p>
    </DocSection>

    <DocSection title="6. Conteúdo editorial e curadoria">
      <p>Textos, títulos, notas curatoriais e organização do acervo expressam uma seleção editorial. Eles não substituem a descrição oficial do vendedor, aconselhamento profissional ou garantia de adequação de um produto a uma finalidade específica.</p>
    </DocSection>

    <DocSection title="7. Propriedade intelectual">
      <p>A marca, a interface e os elementos originais da Cerberus Finds devem ser utilizados apenas nos limites permitidos pela legislação aplicável. Imagens e marcas de terceiros permanecem associadas aos respectivos titulares.</p>
    </DocSection>

    <DocSection title="8. Uso permitido e responsabilidade">
      <p>Não é permitido utilizar o site para fraude, abuso, interferência técnica, coleta indevida de dados, tentativa de acesso administrativo ou qualquer finalidade ilícita. A Cerberus Finds não responde por eventos sob controle exclusivo de terceiros, como alteração de preço, ruptura de estoque, pagamento, entrega ou atendimento.</p>
    </DocSection>

    <DocSection title="9. Alterações, contato e jurisdição">
      <p>Estas condições podem ser atualizadas para refletir mudanças no site e no catálogo. A versão vigente será a publicada nesta página.</p>
      <p>O projeto auditado não contém um e-mail institucional público configurado, e a legislação ou jurisdição aplicáveis não são especificadas nesta versão. Nenhuma informação é inventada para preencher essas lacunas.</p>
    </DocSection>

    <DocSection title="10. Transparência">
      <p>Estes termos foram escritos para explicar o funcionamento observado no projeto sem prometer conformidade jurídica absoluta, prazos de retenção não suportados pelo sistema ou dados empresariais não fornecidos.</p>
      <p className="text-[#C97964]">Estes Termos e Condições foram atualizados em {LAST_UPDATED}.</p>
    </DocSection>
  </>
);

const InstitutionalFooter: React.FC<{ onNavigate: (path: string) => void; onBackToSite: () => void }> = ({ onNavigate, onBackToSite }) => {
  const configuredSocialLinks = getConfiguredSocialLinks();
  const allSocialNetworks = Object.keys(SOCIAL_LABELS) as SocialNetwork[];
  return (
    <footer className="mt-10 border-t border-[#3A342E] pt-7 text-xs text-[#E8E1D3]/60">
      <div className="flex flex-wrap items-center justify-center gap-4">
        <button type="button" onClick={onBackToSite} className="font-gothic text-sm tracking-[0.18em] text-[#E8E1D3] hover:text-[#8A1F1F]">CERBERUS FINDS</button>
        {allSocialNetworks.map(network => {
          const link = configuredSocialLinks.find(item => item.network === network);
          return link ? (
            <a key={network} href={link.url} target="_blank" rel="noreferrer" aria-label={link.label} className="flex h-8 min-w-8 items-center justify-center border border-[#3A342E] px-2 text-[9px] font-display uppercase tracking-wider text-[#E8E1D3]/80 hover:border-[#8A1F1F] hover:text-[#E8E1D3]">{socialMonogram(network)}</a>
          ) : (
            <span key={network} aria-label={`${SOCIAL_LABELS[network]} ainda não configurado`} className="flex h-8 min-w-8 items-center justify-center border border-dashed border-[#3A342E]/70 px-2 text-[9px] font-display uppercase tracking-wider text-[#E8E1D3]/25">{socialMonogram(network)}</span>
          );
        })}
      </div>
      <div className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-2 text-[10px] uppercase tracking-widest">
        <a href={INSTITUTIONAL_PATHS.privacy} className="hover:text-[#E8E1D3]">Política de privacidade</a>
        <a href={INSTITUTIONAL_PATHS.terms} className="hover:text-[#E8E1D3]">Termos e condições</a>
      </div>
      <p className="mt-5 text-center text-[10px] leading-5 text-[#E8E1D3]/45">Os perfis sociais sem URL oficial permanecem apenas como espaços reservados e não são links.</p>
    </footer>
  );
};

const DocSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <section className="border-b border-[#3A342E] pb-7 last:border-b-0 last:pb-0">
    <h2 className="font-gothic text-xl leading-tight text-[#E8E1D3] sm:text-2xl">{title}</h2>
    <div className="mt-4 space-y-3 text-sm leading-7 text-[#E8E1D3]/70">{children}</div>
  </section>
);

function socialMonogram(network: SocialNetwork): string {
  if (network === "instagram") return "IG";
  if (network === "tiktok") return "TK";
  if (network === "facebook") return "FB";
  if (network === "youtube") return "YT";
  if (network === "pinterest") return "PI";
  return "X";
}
