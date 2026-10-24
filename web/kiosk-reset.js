/**
 * The prompt demo's reset (behold#935). Between acts the driver puts every estate back to its base, outside the
 * story the person drives. In ask mode the reset step shows one modal over the page, "Resetting", so a viewer knows
 * what the wait is; it goes when the next step arrives. Nothing in the pane or the graph changes for it.
 */

/** Whether the reset modal shows for this step: a reset while the page is in ask mode. */
export function resetShown(demo, askOn) {
  return !!askOn && !!demo && demo.step === "reset";
}

const STYLE_ID = "k-reset-style";
const STYLE = `
#k-reset { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55); opacity: 0; pointer-events: none; transition: opacity 300ms ease; }
#k-reset.on { opacity: 1; pointer-events: auto; }
#k-reset .k-reset-card { background: var(--panel, #1f2335); color: var(--fg, #cdd6f4); border: 1px solid var(--accent, #89b4fa); border-radius: 10px; padding: 22px 30px; text-align: center; max-width: min(90vw, 420px); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4); }
#k-reset .k-reset-title { font: 700 1.4rem/1.2 system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; display: flex; align-items: center; justify-content: center; gap: 0.6em; }
#k-reset .k-reset-spin { width: 0.9em; height: 0.9em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: k-reset-spin 900ms linear infinite; }
#k-reset .k-reset-line { margin-top: 10px; font: 0.95rem/1.4 system-ui, sans-serif; color: var(--muted, #a6adc8); }
@keyframes k-reset-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { #k-reset { transition: none; } #k-reset .k-reset-spin { animation: none; } }
`;

/** The modal, made once in `doc`; `set(on)` shows or hides it. */
export function mountResetModal(doc = document) {
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE;
    doc.head.appendChild(style);
  }
  let el = doc.getElementById("k-reset");
  if (!el) {
    el = doc.createElement("div");
    el.id = "k-reset";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    el.innerHTML =
      '<div class="k-reset-card"><div class="k-reset-title"><span class="k-reset-spin" aria-hidden="true"></span>Resetting</div>' +
      '<div class="k-reset-line">Network, app and edge go back to how they started.</div></div>';
    doc.body.appendChild(el);
  }
  return {
    set(on) {
      el.classList.toggle("on", !!on);
      el.setAttribute("aria-hidden", on ? "false" : "true");
    },
  };
}
