// Voxenite's checkout (M3-138; docs/architecture/store_checkout.md in the game's
// repository). buy.html and bought.html load this file.
//
// The one switch is `token`, Paddle's client-side token. Left empty, nothing from
// Paddle loads and the Buy button reads "Checkout opens soon". A token starting
// test_ opens Paddle's sandbox checkout; one starting live_ takes real money.
//
// How the buyer gets the game: before the checkout opens, this page makes a
// licence key in the buyer's browser and keeps it there. Only the key's SHA-256
// goes to Paddle, in the checkout's custom data; once Paddle says the payment is
// complete, its webhook tells the Voxenite service, which adds that hash as a
// licence key. bought.html then shows the key, which the buyer enters in the game.
// Nobody but the buyer's browser ever holds the key itself.
//
// Bought from the game: the game opens buy.html#claim=<one-time claim> for the
// account signed in to it. The page takes the claim out of the address bar
// before anything else loads, and sends Paddle only its SHA-256 beside the key's.
// Before the payer pays, the page shows whose account that is, masked
// (g***@example.com, from the service), with "Not your account? Buy a key
// instead", since a claim link can be passed on: anyone can make one for their
// own account. The webhook then gives that account the game, and bought.html
// names it and shows no key. If the claim cannot be used (expired, used, the account owns the
// game already), the sale falls back to the key, which bought.html then shows.
const VOXENITE_CHECKOUT = {
  token: "",
  // The Voxenite product's one price in each Paddle account (not secrets).
  prices: {
    sandbox: "pri_01m72x93dpddpjdpbvggs55vfk",
    live: "pri_01m72v3bseh8vtbndcg35cwffe",
  },
  // The Voxenite service's address, for bought.html to say when the key works.
  // Empty: bought.html shows the key without checking it.
  service: "",
  // The tester gate (M3-180, Gharvhel 2026-11-11): with the live token in,
  // voxenite.com still sells nothing until this is true. The board's Open buying
  // button sets it on a branch of its own, once ten outside testers have played.
  // Until then the Buy button says checkout opens after the first play-test,
  // and only buy.html#preview opens it: the owner's real $0 purchase.
  open: false,
};

(() => {
  "use strict";

  const PADDLE_JS = "https://cdn.paddle.com/paddle/v2/paddle.js";
  const STORE = "voxenite.bought";
  // Unpaid keys kept: checkouts opened and perhaps closed unpaid. A paid key is
  // never dropped.
  const KEPT = 10;
  // Crockford base32, as the service reads keys: no I, L, O or U.
  const DIGITS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  // bought.html asks every 4 s for the first minute, then every 15 s up to five
  // minutes: about 35 asks a visit, against the service's 120 an IP a window.
  const POLL_FAST_MS = 4000;
  const POLL_FAST_FOR_MS = 60 * 1000;
  const POLL_SLOW_MS = 15000;
  const POLL_FOR_MS = 5 * 60 * 1000;
  const RECENT_MS = 60 * 60 * 1000;
  // A purchase claim from the service: 32 random bytes as base64url.
  const CLAIM_PATTERN = /^[A-Za-z0-9_-]{43}$/;

  // The claim in buy.html#claim=..., taken out of the address bar (and so out of
  // history and any later copy of the address) before Paddle.js loads. "" when
  // there is none. A fragment is never sent to a server or put in a Referer.
  function takeClaim() {
    const found = /^#claim=([^&]*)$/.exec(location.hash);
    if (!found) return "";
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      location.hash = "";
    }
    return CLAIM_PATTERN.test(found[1]) ? found[1] : "";
  }

  // Only a copy on this PC (the board's test shop on localhost) opens Paddle's
  // sandbox: a test_ token on voxenite.com, or on any other host serving these
  // files, would let anyone take a tester key with a test card.
  const SANDBOX_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

  function environment(token) {
    if (token.startsWith("test_")) return SANDBOX_HOSTS.includes(location.hostname) ? "sandbox" : "";
    if (token.startsWith("live_")) return "live";
    return "";
  }

  // localStorage can be missing or refuse (a private window, blocked site data).
  function readKeys() {
    try {
      const list = JSON.parse(localStorage.getItem(STORE) || "[]");
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function writeKeys(list) {
    try {
      const unpaid = list.filter((row) => !row.paid);
      const dropped = new Set(unpaid.slice(0, Math.max(0, unpaid.length - KEPT)));
      localStorage.setItem(STORE, JSON.stringify(list.filter((row) => !dropped.has(row))));
      return true;
    } catch {
      return false;
    }
  }

  // 20 digits from the browser's random source: 100 bits. 256 is a multiple of 32,
  // so taking each byte's low five bits keeps every digit equally likely.
  function newKey() {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    const digits = Array.from(bytes, (b) => DIGITS[b & 31]).join("");
    return { digits, text: `VOX-${digits.match(/.{5}/g).join("-")}` };
  }

  async function sha256Hex(text) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function loadPaddle() {
    return new Promise((done, fail) => {
      const script = document.createElement("script");
      script.src = PADDLE_JS;
      script.onload = () => done(window.Paddle);
      script.onerror = () => fail(new Error("Paddle.js did not load"));
      document.head.appendChild(script);
    });
  }

  // ---- buy.html -----------------------------------------------------------

  // The address #preview, taken out of the address bar: the owner's way to the
  // live checkout while the tester gate holds it shut. Anyone who types it can
  // buy at the full price, which is no harm; it is not a secret.
  function takePreview() {
    if (location.hash !== "#preview") return false;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch {
      location.hash = "";
    }
    return true;
  }

  // Whether the checkout may open: the sandbox on this PC always does; the live
  // one once the tester gate is open, or for #preview. O(1).
  function shopOpen(env, preview) {
    return env !== "live" || VOXENITE_CHECKOUT.open === true || preview;
  }

  // The shut Buy button's words while the tester gate holds (M3-180).
  function showGateShut(button) {
    button.querySelector(".btn-label").textContent = "Opens after the first play-test";
    button.querySelector(".btn-sub").textContent = "Free keys go to early testers first";
    const shut = document.getElementById("buy-gate-shut");
    if (shut) shut.hidden = false;
  }

  async function openBuy() {
    const env = environment(VOXENITE_CHECKOUT.token);
    const priceId = VOXENITE_CHECKOUT.prices[env];
    const button = document.getElementById("buy-button");
    const preview = takePreview();
    if (env && button && !shopOpen(env, preview)) {
      showGateShut(button);
      return;
    }
    const early = document.getElementById("buy-early");
    if (env && early) early.hidden = false;
    const claim = takeClaim();
    // A claim link opened in this tab while the page is open changes only the
    // fragment, which reloads nothing: load the page again so it is taken as above.
    window.addEventListener?.("hashchange", () => {
      if (location.hash.startsWith("#claim=")) location.reload();
    });
    if (!env || !priceId || !button || !window.crypto?.subtle) return;
    let claimHash = claim ? await sha256Hex(claim) : "";
    // Whose account the claim is for, masked. A claim the service will not name
    // (run out, used, unknown, or no service to ask) is dropped: the payer gets a key.
    let account = claimHash ? await claimAccount(claimHash) : "";
    if (claimHash && !account) {
      claimHash = "";
      document.getElementById("buy-claim-gone").hidden = false;
    }
    if (claimHash) {
      document.getElementById("buy-account").textContent = account;
      document.getElementById("buy-for-account").hidden = false;
      document.getElementById("buy-not-mine").addEventListener("click", () => {
        claimHash = "";
        account = "";
        document.getElementById("buy-for-account").hidden = true;
        document.getElementById("buy-key-instead").hidden = false;
      });
    }
    const Paddle = await loadPaddle();
    // Before any other Paddle.js call; without it Paddle.js is live.
    if (env === "sandbox") Paddle.Environment.set("sandbox");
    Paddle.Initialize({
      token: VOXENITE_CHECKOUT.token,
      eventCallback(event) {
        if (event?.name !== "checkout.completed") return;
        const hash = event.data?.custom_data?.voxenite_key_hash;
        const list = readKeys();
        const entry = list.find((row) => row.hash === hash);
        if (entry) {
          entry.paid = true;
          entry.txn = event.data?.transaction_id || "";
          writeKeys(list);
        }
      },
    });

    const live = document.createElement("button");
    live.type = "button";
    live.id = "buy-button";
    live.className = "btn btn-ember";
    live.innerHTML = '<span class="btn-label">Buy Voxenite</span><span class="btn-sub">Payment by Paddle</span>';
    button.replaceWith(live);
    live.addEventListener("click", async () => {
      const key = newKey();
      const hash = await sha256Hex(key.digits);
      const list = readKeys();
      list.push({ key: key.text, hash, claimHash, account, made: Date.now(), paid: false, txn: "", env });
      if (!writeKeys(list)) {
        alert("This browser won't keep your licence key (site data is blocked or this is a private window). "
          + "Allow site data for voxenite.com, or use a normal window, then press Buy again.");
        return;
      }
      Paddle.Checkout.open({
        items: [{ priceId, quantity: 1 }],
        customData: { voxenite_key_hash: hash, ...(claimHash ? { voxenite_claim_hash: claimHash } : {}) },
        settings: { displayMode: "overlay", successUrl: new URL("bought.html", location.href).href },
      });
    });
  }

  // ---- bought.html --------------------------------------------------------

  const STATE_WORDS = {
    waiting: "Paddle is confirming your payment. Your key starts working within a minute or two; this page will say so.",
    ready: "Your key is ready.",
    used: "This key is on an account now.",
    ended: "This key no longer works: the order was refunded or charged back.",
    busy: "We can't check your key just now (too many checks from your network). It still works: "
      + "enter it in the game, or come back to this page in an hour.",
  };

  const OWNED_WORDS = {
    waiting: "Paddle is confirming your payment. Your account gets the game within a minute or two; this page will say so.",
    owned: "You own Voxenite: go back to the game. If it is still locked, close it and start it again.",
    ended: "This purchase was refunded or charged back, so the account no longer has the game.",
    busy: "We can't check just now (too many checks from your network). Go back to the game: once your payment "
      + "has gone through, it unlocks. Or come back to this page in an hour.",
    late: "Your payment hasn't reached us yet. Keep this page open or come back later; if your game is still locked "
      + "in an hour, email us with your Paddle order number.",
  };

  function serviceUrl(path) {
    return `${VOXENITE_CHECKOUT.service.replace(/\/$/, "")}${path}`;
  }

  // The masked email of the account a live claim is for, or "".
  async function claimAccount(claimHash) {
    if (!VOXENITE_CHECKOUT.service) return "";
    try {
      const answer = await fetch(serviceUrl(`/store/claim?hash=${claimHash}`));
      return answer.ok ? (await answer.json()).account || "" : "";
    } catch {
      return "";
    }
  }

  // The checkout's transaction id goes along too: once the claim's row has
  // expired, it alone still says how the sale went.
  async function keyState(hash, claimHash = "", txn = "") {
    if (!VOXENITE_CHECKOUT.service) return "";
    try {
      const claim = claimHash ? `&claim=${claimHash}` : "";
      const sale = /^txn_[0-9a-z]{1,64}$/.test(txn) ? `&txn=${txn}` : "";
      const answer = await fetch(serviceUrl(`/store/key?hash=${hash}${claim}${sale}`));
      if (answer.status === 429) return "busy";
      if (!answer.ok) return "";
      return (await answer.json()).state || "";
    } catch {
      return "";
    }
  }

  // A key the service has seen paid is kept like one Paddle.js said was paid.
  function markPaid(hash) {
    const list = readKeys();
    const entry = list.find((row) => row.hash === hash);
    if (entry && !entry.paid) {
      entry.paid = true;
      writeKeys(list);
    }
  }

  function showKey(entry) {
    document.getElementById("bought-key").textContent = entry.key;
    document.getElementById("bought-found").hidden = false;
    document.getElementById("bought-missing").hidden = true;
    document.getElementById("bought-copy").addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(entry.key);
        document.getElementById("bought-copy-note").textContent = "Copied.";
      } catch {
        document.getElementById("bought-copy-note").textContent = "Select the key and copy it.";
      }
    });
    const file = new Blob([`Your Voxenite licence key:\r\n${entry.key}\r\n\r\nOrder ${entry.txn || "(see Paddle's receipt)"}\r\n`],
      { type: "text/plain" });
    const save = document.getElementById("bought-save");
    save.href = URL.createObjectURL(file);
    save.download = "Voxenite licence key.txt";
    if (entry.env === "sandbox") document.getElementById("bought-sandbox").hidden = false;
  }

  // A purchase from the game: the account gets it, so no key is shown unless the
  // sale fell back to the key (the service then answers the key's own state).
  function showOwned(text) {
    document.getElementById("bought-owned").hidden = false;
    document.getElementById("bought-missing").hidden = true;
    document.getElementById("bought-owned-state").textContent = text;
  }

  async function watchKey(entry) {
    const line = document.getElementById("bought-state");
    const started = Date.now();
    let keyShown = !entry.claimHash;
    if (entry.claimHash) showOwned(OWNED_WORDS.waiting);
    for (;;) {
      const state = await keyState(entry.hash, entry.claimHash, entry.txn);
      if (state === "ready" || state === "used" || state === "owned") markPaid(entry.hash);
      if (entry.claimHash && (state === "owned" || (state === "ended" && !keyShown))) {
        showOwned(state === "owned" && entry.account
          ? `You own Voxenite on the account ${entry.account}: go back to the game. If it is still locked, close it and start it again.`
          : OWNED_WORDS[state]);
        return;
      }
      if (entry.claimHash && (state === "ready" || state === "used") && !keyShown) {
        document.getElementById("bought-owned").hidden = true;
        document.getElementById("bought-fell-back").hidden = false;
        showKey(entry);
        keyShown = true;
      }
      if (state && keyShown) line.textContent = STATE_WORDS[state] || "";
      if (state && !keyShown) document.getElementById("bought-owned-state").textContent = OWNED_WORDS[state] || "";
      if (state && state !== "waiting") return;
      if (!keyShown && Date.now() - started > POLL_FOR_MS) {
        showOwned(OWNED_WORDS.late);
        return;
      }
      if (!state && !VOXENITE_CHECKOUT.service) return;
      if (Date.now() - started > POLL_FOR_MS) {
        line.textContent = "Your payment hasn't reached us yet. Keep this page and your key; it will start working "
          + "soon. If it still doesn't in an hour, email us with your Paddle order number.";
        return;
      }
      await new Promise((go) => setTimeout(go, Date.now() - started < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS));
    }
  }

  async function openBought() {
    const list = readKeys();
    // The checkout this browser finished last; else one whose payment the service has
    // seen (the page was closed before Paddle said it was complete).
    let entry = [...list].reverse().find((row) => row.paid);
    if (!entry) {
      for (const row of [...list].reverse()) {
        if (["ready", "used", "owned"].includes(await keyState(row.hash, row.claimHash, row.txn))) {
          markPaid(row.hash);
          entry = row;
          break;
        }
      }
    }
    // Else the key of a checkout opened in the last hour, which Paddle may still be
    // finishing; an older one was most likely a checkout closed without paying.
    const last = list.at(-1);
    if (!entry && last && Date.now() - last.made < RECENT_MS) entry = last;
    if (!entry) return;
    if (!entry.claimHash) showKey(entry);
    await watchKey(entry);
  }

  // For the service's tests (tools/report_receiver/service.test.mjs), which load
  // this file and check that a key made here is the key the service takes.
  VOXENITE_CHECKOUT.forTests = { newKey, sha256Hex, shopOpen };

  const page = typeof document === "undefined" ? "" : document.body?.dataset.page;
  if (page === "buy") openBuy().catch(() => {});
  if (page === "bought") openBought().catch(() => {});
})();
