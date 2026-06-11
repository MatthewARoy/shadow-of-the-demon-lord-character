// Roll result toast.

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let timer = null;

export function showToast(entry) {
  const box = document.getElementById("roll-toast");
  if (!box) return;
  box.innerHTML = `
    <span class="total">${entry.total}</span>
    <b>${esc(entry.label)}</b>
    <div class="detail">${esc(entry.detail)}${entry.crit ? " — a natural 20!" : ""}${entry.fumble ? " — a natural 1…" : ""}</div>`;
  box.hidden = false;
  clearTimeout(timer);
  timer = setTimeout(() => { box.hidden = true; }, 3200);
}
