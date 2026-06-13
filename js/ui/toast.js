// Roll result toasts — stacked so consecutive rolls (attack, then damage)
// each stay readable for their full lifetime.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const LIFETIME = 4000;

export function showToast(entry) {
  const box = document.getElementById("roll-toast");
  if (!box) return;
  const t = document.createElement("div");
  t.className = "toast";
  t.innerHTML = `
    <span class="total">${entry.total}</span>
    <b>${esc(entry.label)}</b>
    <div class="detail">${esc(entry.detail)}${entry.crit ? " — a natural 20!" : ""}${entry.fumble ? " — a natural 1…" : ""}</div>`;
  box.appendChild(t);
  box.hidden = false;
  setTimeout(() => {
    t.remove();
    if (!box.children.length) box.hidden = true;
  }, LIFETIME);
}
