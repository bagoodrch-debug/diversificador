// Google Analytics (GA4) — carregado em todas as páginas do Many Mens.
//
// Troque o valor de GA_ID abaixo pelo Measurement ID real da sua propriedade
// (formato "G-XXXXXXXXXX", você pega em analytics.google.com). Como esse ID
// mora só aqui, atualizar no futuro (ou trocar de propriedade) é editar essa
// linha uma vez só — não precisa mexer em cada página do site.
const GA_ID = "G-K5M9CFHHEE";

(function () {
  if (GA_ID.includes("XXXXXXXXXX")) {
    console.warn("Google Analytics: troque o GA_ID em assets/analytics.js pelo seu Measurement ID real.");
    return;
  }

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  function gtag() {
    window.dataLayer.push(arguments);
  }
  window.gtag = gtag;
  gtag("js", new Date());
  gtag("config", GA_ID);
})();
