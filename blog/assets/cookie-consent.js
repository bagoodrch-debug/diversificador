// Banner de cookies + consentimento antes de carregar o Google Analytics.
// Compartilhado por todas as páginas do Many Mens (mesma lógica do
// analytics.js): edita aqui uma vez, vale pro site inteiro.

(function () {
  const KEY = "many-mens-cookie-consent";
  const consentimento = localStorage.getItem(KEY);

  function carregarAnalytics() {
    const s = document.createElement("script");
    s.defer = true;
    s.src = "/assets/analytics.js";
    document.head.appendChild(s);
  }

  if (consentimento === "aceito") {
    carregarAnalytics();
    return;
  }
  if (consentimento === "recusado") {
    return; // já decidiu não aceitar, não mostra o banner de novo
  }

  function injetarEstilo() {
    const style = document.createElement("style");
    style.textContent = `
      #cookie-banner {
        position: fixed;
        left: 0; right: 0; bottom: 0;
        z-index: 9999;
        background: #0c0c0e;
        color: #f2f2f2;
        border-top: 1px solid rgba(255,255,255,0.15);
        padding: 0.9rem 1.1rem;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: center;
        gap: 0.8rem 1.2rem;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        font-size: 0.85rem;
        box-shadow: 0 -6px 20px rgba(0,0,0,0.35);
      }
      #cookie-banner p { margin: 0; max-width: 60ch; line-height: 1.4; }
      #cookie-banner a { color: #f5b942; text-decoration: underline; }
      #cookie-banner .cookie-banner__actions { display: flex; gap: 0.6rem; flex-shrink: 0; }
      #cookie-banner button {
        border-radius: 999px;
        padding: 0.5rem 1.1rem;
        font-size: 0.82rem;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(255,255,255,0.25);
        background: transparent;
        color: #f2f2f2;
      }
      #cookie-banner button#cookie-accept {
        background: #f5b942;
        color: #0c0c0e;
        border-color: #f5b942;
      }
      @media (max-width: 560px) {
        #cookie-banner { flex-direction: column; align-items: stretch; text-align: center; }
        #cookie-banner .cookie-banner__actions { justify-content: center; }
      }
    `;
    document.head.appendChild(style);
  }

  function mostrarBanner() {
    injetarEstilo();
    const banner = document.createElement("div");
    banner.id = "cookie-banner";
    banner.innerHTML = `
      <p>Usamos cookies e o Google Analytics para entender como o site é usado e melhorar as ferramentas. <a href="/privacidade.html">Saiba mais</a>.</p>
      <div class="cookie-banner__actions">
        <button type="button" id="cookie-decline">Recusar</button>
        <button type="button" id="cookie-accept">Aceitar</button>
      </div>
    `;
    document.body.appendChild(banner);

    document.getElementById("cookie-accept").addEventListener("click", () => {
      localStorage.setItem(KEY, "aceito");
      banner.remove();
      carregarAnalytics();
    });
    document.getElementById("cookie-decline").addEventListener("click", () => {
      localStorage.setItem(KEY, "recusado");
      banner.remove();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mostrarBanner);
  } else {
    mostrarBanner();
  }
})();
