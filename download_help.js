// The after-click download guide (Gharvhel 2026-11-11: players "click download
// on top and quickly again click download for windows, not even paying
// attention to the warning"). A press of a Windows download link lets the
// download go ahead and opens #dl-guide, which shows what Windows will ask
// (More info, then Run anyway) at the moment the player is looking. Without
// JavaScript or <dialog> support the page's own warning box still says it.
(function () {
  "use strict";
  const guide = document.getElementById("dl-guide");
  if (!guide || typeof guide.showModal !== "function") return;

  // Whether `el` is a link to the Windows installer.
  function isInstallerLink(el) {
    return el.tagName === "A" && /\/releases\/.*\/download\/.*\.exe$/i.test(el.getAttribute("href") || "");
  }

  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link || !isInstallerLink(link) || guide.open) return;
    // The download itself goes on as normal; the guide opens a moment later so
    // the browser has started it first.
    setTimeout(() => guide.showModal(), 150);
  });

  // "Read the options" closes the guide and scrolls to the full warning box.
  guide.addEventListener("click", (event) => {
    if (event.target.closest && event.target.closest("[data-close]")) guide.close();
    // A press on the backdrop (outside the inner form) closes it too.
    if (event.target === guide) guide.close();
  });
})();
