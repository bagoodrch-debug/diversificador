document.addEventListener("DOMContentLoaded", () => {
  const buttons = Array.from(document.querySelectorAll(".categoria-list button"));
  const groups = Array.from(document.querySelectorAll(".produto-grupo"));
  if (!buttons.length || !groups.length) return;

  function applyFilter(category) {
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.categoria === category)));
    groups.forEach((g) => {
      const show = category === "todos" || g.dataset.categoria === category;
      g.style.display = show ? "" : "none";
    });
  }

  buttons.forEach((b) => {
    b.addEventListener("click", () => applyFilter(b.dataset.categoria));
  });

  // Categoria inicial via #hash (ex: produtos.html#pele), senão "todos"
  const initial = location.hash.replace("#", "") || "todos";
  const validInitial = buttons.some((b) => b.dataset.categoria === initial) ? initial : "todos";
  applyFilter(validInitial);
});
