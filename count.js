// Anonymous counts for voxenite.com (Gharvhel 2026-11-11: "are we able to track
// how many people at least clicked checkout?"). GoatCounter counts page
// visits by itself (the script tag in each page's head); this adds an event
// for each press of the Buy button, closed ("buy-press-soon") or open
// ("buy-press"), and each press of a download link ("download"). GoatCounter
// sets no cookies and keeps nothing that identifies a visitor; privacy.html
// says so. It ignores localhost, so testing the pages locally counts nothing.
(function () {
  "use strict";

  // The name of the press a click on `el` counts, or "" for none.
  function pressName(el) {
    if (el.dataset && el.dataset.count) return el.dataset.count;
    if (el.id === "buy-button") return el.tagName === "BUTTON" ? "buy-press" : "buy-press-soon";
    if (el.tagName === "A" && /\/releases\/.*\/download\//.test(el.getAttribute("href") || "")) return "download";
    return "";
  }

  // Capture phase: counted before checkout.js opens Paddle's overlay, and
  // still counted when checkout.js swaps the Buy button for the live one.
  document.addEventListener("click", (event) => {
    const el = event.target && event.target.closest
      ? event.target.closest("#buy-button, a[href], [data-count]")
      : null;
    if (!el) return;
    const name = pressName(el);
    if (!name || !window.goatcounter || typeof window.goatcounter.count !== "function") return;
    window.goatcounter.count({ path: name, title: document.title, event: true });
  }, true);
})();
