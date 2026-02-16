// Bandor Pata Tapper â€” Farcaster Mini App (production static)
// IMPORTANT: keep asset/script URLs relative so the app works on any deployed domain.

import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk";
import { Attribution } from "https://esm.sh/ox/erc8021";


// ---------- Runtime config (Vercel ENV) ----------
// PAYMASTER_SERVICE_URL is read at RUNTIME from /api/config so you can change it from Vercel
// without rebuilding the frontend bundle.
let PAYMASTER_SERVICE_URL = "";

async function loadRuntimeConfig() {
  // Optional manual override (useful for local testing)
  if (typeof window !== "undefined" && typeof window.PAYMASTER_SERVICE_URL === "string") {
    PAYMASTER_SERVICE_URL = window.PAYMASTER_SERVICE_URL.trim();
    return PAYMASTER_SERVICE_URL;
  }
  try {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (!r.ok) return PAYMASTER_SERVICE_URL;
    const j = await r.json();
    const url = (j?.paymasterServiceUrl || "").trim();
    if (url) PAYMASTER_SERVICE_URL = url;
  } catch {
    // ignore
  }
  return PAYMASTER_SERVICE_URL;
}

// Cache wallet capabilities once per session to avoid extra RPC calls
let __walletCaps = null;

async function getWalletCapabilities(provider, userAddress) {
  if (__walletCaps) return __walletCaps;
  try {
    __walletCaps = await provider.request({
      method: "wallet_getCapabilities",
      params: [userAddress],
    });
  } catch {
    __walletCaps = {};
  }
  return __walletCaps;
}

function walletSupportsPaymaster(caps, chainIdHex) {
  // Base docs: capabilities are returned per chain id, e.g. caps["0x2105"].paymasterService.supported
  return !!caps?.[chainIdHex]?.paymasterService?.supported;
}

const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_DECIMALS = 6;

// Base Mainnet (8453 / 0x2105) â€” this is where your contract lives.
const BASE_MAINNET_CHAIN_ID = "0x2105";

// Your onchain contract to hit on every tap.
const TAP_CONTRACT = "0x40344818472F5CAF05f7AC50cb6867442b3F55ea"; // checksummed

// Optional: the same address is used as the USDC tip recipient in the Tip tab.
const TIP_RECIPIENT = "0xe8Bda2Ed9d2FC622D900C8a76dc455A3e79B041f";

// Contract function: logAction(bytes32,bytes)
// selector = keccak256("logAction(bytes32,bytes)")[0:4] = 0x2d9bc1fb
const LOG_ACTION_SELECTOR = "0x2d9bc1fb";
const ACTION_TAP = "TAP";

// Builder Code attribution via `dataSuffix` (ERC-8021).
// You can replace this with your real code from base.dev.
// IMPORTANT: Per Base Account docs, the `dataSuffix` capability must be an object
// with a `value` field (hex string). Passing a raw string will throw:
//   "Expected object, received string".
const BUILDER_CODE = "bc_w5t12vu3";
const builderCodeSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

function isHexAddress(addr) {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function isReadyToSend() {
  // We never want to crash or block the UI â€” just surface clear errors.
  if (!isHexAddress(TAP_CONTRACT)) return false;
  return true;
}

function toast(msg, ms = 2200) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.add("show");
  window.clearTimeout(toast._t);
  toast._t = window.setTimeout(() => el.classList.remove("show"), ms);
}

function todayKey() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- Local state ----------
const store = {
  getPata() {
    const v = localStorage.getItem("pata");
    const n = v ? Number(v) : 150;
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 150;
  },
  setPata(n) {
    localStorage.setItem("pata", String(Math.max(0, Math.floor(n))));
  },
  getEnergy() {
    const v = localStorage.getItem("energy");
    const n = v ? Number(v) : 80;
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.floor(n))) : 80;
  },
  setEnergy(n) {
    localStorage.setItem("energy", String(Math.max(0, Math.min(100, Math.floor(n)))));
  },
  getStreak() {
    const v = localStorage.getItem("streak");
    const n = v ? Number(v) : 0;
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  },
  setStreak(n) {
    localStorage.setItem("streak", String(Math.max(0, Math.floor(n))));
  },
  getLastPlayDay() {
    return localStorage.getItem("lastPlayDay") || "";
  },
  setLastPlayDay(d) {
    localStorage.setItem("lastPlayDay", d);
  },
};

// ---------- Game ----------
const MILESTONES = [
  { at: 500, label: "Nice! ðŸ¥³" },
  { at: 1000, label: "Big Pata Energy ðŸ˜Ž" },
  { at: 2500, label: "Leaf Legend ðŸƒðŸ‘‘" },
];

let pata = store.getPata();
let energy = store.getEnergy();
let streak = store.getStreak();
let nextMilestoneIdx = 0;

function fmt(n) {
  try { return n.toLocaleString("en-US"); } catch { return String(n); }
}

function updateHud() {
  document.getElementById("pataText").textContent = `Pata: ${fmt(pata)}`;
  document.getElementById("energyText").textContent = `${energy}/100`;
  document.getElementById("streakText").textContent = String(streak);
}

function maybeUpdateStreak() {
  const today = todayKey();
  const last = store.getLastPlayDay();
  if (!last) {
    streak = 1;
    store.setStreak(streak);
    store.setLastPlayDay(today);
    return;
  }
  if (last === today) return;

  // if last was yesterday, continue streak; else reset
  const lastDate = new Date(last + "T00:00:00");
  const todayDate = new Date(today + "T00:00:00");
  const diffDays = Math.round((todayDate - lastDate) / 86400000);
  if (diffDays === 1) {
    streak += 1;
  } else {
    streak = 1;
  }
  store.setStreak(streak);
  store.setLastPlayDay(today);
}

function spawnPlus(x, y, text) {
  const el = document.createElement("div");
  el.className = "floatPlus";
  el.textContent = text;
  const area = document.getElementById("tapArea");
  const r = area.getBoundingClientRect();
  el.style.left = `${x - r.left}px`;
  el.style.top = `${y - r.top}px`;
  area.appendChild(el);
  window.setTimeout(() => el.remove(), 700);
}

function onTap(ev) {
  maybeUpdateStreak();

  // Keep the UI responsive: show feedback immediately,
  // but only add +1 Pata after the tx is confirmed.
  const point = ev.touches?.[0] || ev;
  spawnPlus(point.clientX, point.clientY, "+1");

  // Optional energy meter (never blocks onchain taps)
  if (energy > 0) {
    energy -= 1;
    store.setEnergy(energy);
    updateHud();
  }

  enqueueTapTx();

  if (nextMilestoneIdx < MILESTONES.length) {
    const m = MILESTONES[nextMilestoneIdx];
    if (pata >= m.at) {
      toast(m.label);
      nextMilestoneIdx += 1;
    }
  }
}

function startEnergyRegen() {
  window.setInterval(() => {
    const current = store.getEnergy();
    if (current < 100) {
      const next = Math.min(100, current + 1);
      store.setEnergy(next);
      energy = next;
      updateHud();
    }
  }, 5000);
}

// ---------- Navigation ----------
function showPanel(name) {
  const earn = document.getElementById("earnPanel");
  if (name === "earn") earn.classList.add("show");
  else earn.classList.remove("show");

  document.getElementById("navGame").classList.toggle("primary", name === "game");
  document.getElementById("navEarn").classList.toggle("primary", name === "earn");
  document.getElementById("navTip").classList.toggle("primary", name === "tip");
}

function openSheet() {
  const bd = document.getElementById("sheetBackdrop");
  bd.classList.add("show");
  bd.setAttribute("aria-hidden", "false");
}
function closeSheet() {
  const bd = document.getElementById("sheetBackdrop");
  bd.classList.remove("show");
  bd.setAttribute("aria-hidden", "true");
}

// ---------- USDC transfer encoding ----------
const TRANSFER_SELECTOR = "a9059cbb";

function pad32(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}

function parseUsdcToBaseUnits(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("Enter an amount");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount");
  const [whole, frac = ""] = s.split(".");
  const fracPadded = (frac + "0".repeat(USDC_DECIMALS)).slice(0, USDC_DECIMALS);
  const units = BigInt(whole) * BigInt(10 ** USDC_DECIMALS) + BigInt(fracPadded || "0");
  if (units <= 0n) throw new Error("Amount must be > 0");
  return units;
}

function encodeErc20Transfer(to, units) {
  const addr = to.replace(/^0x/, "").toLowerCase();
  const amt = units.toString(16);
  return "0x" + TRANSFER_SELECTOR + pad32(addr) + pad32(amt);
}

// ---------- ABI encoding (no external deps) ----------
function hexPadLeft(hexNo0x, bytes) {
  return hexNo0x.replace(/^0x/, "").padStart(bytes * 2, "0");
}

function hexPadRight(hexNo0x, bytes) {
  return hexNo0x.replace(/^0x/, "").padEnd(bytes * 2, "0");
}

function bytes32FromAscii(text) {
  const enc = new TextEncoder();
  const b = enc.encode(String(text));
  const sliced = b.slice(0, 32);
  let hex = "";
  for (const x of sliced) hex += x.toString(16).padStart(2, "0");
  return "0x" + hexPadRight(hex, 32);
}

function uint256ToHex32(n) {
  const v = BigInt(n);
  return "0x" + hexPadLeft(v.toString(16), 32);
}

function abiEncodeLogAction(actionBytes32, dataHex) {
  const action = hexPadLeft(actionBytes32, 32);
  const dataNo0x = String(dataHex || "0x").replace(/^0x/, "");
  const dataLen = dataNo0x.length / 2;
  const offset = hexPadLeft("40", 32); // bytes offset to dynamic part
  const lenWord = hexPadLeft(dataLen.toString(16), 32);
  const paddedData = dataNo0x.padEnd(Math.ceil(dataLen / 32) * 64, "0");
  return LOG_ACTION_SELECTOR + action + offset + lenWord + paddedData;
}

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

// ---------- Wallet helpers ----------
// ---------- Wallet helpers ----------
// IMPORTANT: Farcaster hosts (and some wallets) do NOT like multiple interactive requests
// (eth_requestAccounts / wallet_switchEthereumChain / wallet_sendCalls) fired back-to-back.
// So we cache provider + account, and we strictly serialize connect/switch/send.

let __provider = null;
let __account = null;

let __connectInFlight = null;
let __switchInFlight = null;

async function getProvider() {
  if (__provider) return __provider;

  // Farcaster Mini App SDK provider (preferred)
  if (sdk?.wallet?.getEthereumProvider) {
    const p = await sdk.wallet.getEthereumProvider();
    if (p) {
      __provider = p;
      return __provider;
    }
  }

  // Fallback for regular browsers
  if (window.ethereum) {
    __provider = window.ethereum;
    return __provider;
  }

  throw new Error("No wallet provider found");
}

async function ensureConnected(provider) {
  if (__account) return __account;

  // Try non-interactive first
  try {
    const existing = await provider.request({ method: "eth_accounts" });
    const addr = existing?.[0];
    if (addr) {
      __account = addr;
      return __account;
    }
  } catch {
    // ignore
  }

  // Interactive connect (ONLY ONE at a time)
  if (!__connectInFlight) {
    __connectInFlight = (async () => {
      const accounts = await provider.request({ method: "eth_requestAccounts" });
      const addr = accounts?.[0];
      if (!addr) throw new Error("No account selected");
      __account = addr;
      return __account;
    })().finally(() => {
      __connectInFlight = null;
    });
  }
  return __connectInFlight;
}

async function ensureBaseMainnet(provider) {
  // Serialize chain switching too (wallet UIs often break if we overlap switch + send)
  if (!__switchInFlight) {
    __switchInFlight = (async () => {
      const chainId = await provider.request({ method: "eth_chainId" });
      if (chainId === BASE_MAINNET_CHAIN_ID) return chainId;

      try {
        await provider.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: BASE_MAINNET_CHAIN_ID }],
        });
      } catch {
        throw new Error("Please switch to Base Mainnet (8453)");
      }

      const next = await provider.request({ method: "eth_chainId" });
      if (next !== BASE_MAINNET_CHAIN_ID) throw new Error("Could not switch to Base Mainnet");
      return next;
    })().finally(() => {
      __switchInFlight = null;
    });
  }
  return __switchInFlight;
}

// ---------- Tap -> onchain tx (one tx per tap, queued) ----------
let tapQueue = 0;
let tapSending = false;

function setTapHint(text) {
  const el = document.getElementById("hint");
  if (el) el.textContent = text;
}

async function getEthBalanceWei(provider, address) {
  const hex = await provider.request({ method: "eth_getBalance", params: [address, "latest"] });
  return BigInt(hex);
}

// ---------- Paymaster helpers ----------
// We ONLY attach paymasterService if:
// 1) PAYMASTER_SERVICE_URL is configured (from Vercel env via /api/config), AND
// 2) the connected wallet reports paymasterService support for Base mainnet (0x2105).
async function maybeAttachPaymaster(provider, from, req) {
  if (!PAYMASTER_SERVICE_URL) return { attached: false, req };
  const caps = await getWalletCapabilities(provider, from);
  if (!walletSupportsPaymaster(caps, BASE_MAINNET_CHAIN_ID)) return { attached: false, req };

  req.capabilities = req.capabilities || {};
  req.capabilities.paymasterService = { url: PAYMASTER_SERVICE_URL };
  return { attached: true, req };
}

async function sendCallsWithPaymasterFallback(provider, from, req) {
  const { attached } = await maybeAttachPaymaster(provider, from, req);

  try {
    return await provider.request({ method: "wallet_sendCalls", params: [req] });
  } catch (e) {
    // If paymaster was attached and the paymaster/allowlist/policy rejects,
    // retry once WITHOUT paymaster so the app doesn't break.
    if (attached) {
      try {
        if (req?.capabilities?.paymasterService) delete req.capabilities.paymasterService;
        return await provider.request({ method: "wallet_sendCalls", params: [req] });
      } catch {
        // fall through to original error
      }
    }
    throw e;
  }
}


async function waitForCallBundleFinal(provider, bundleId, { timeoutMs = 45000, pollMs = 800 } = {}) {
  const start = Date.now();
  while (true) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Transaction pending too long. Please try again in a moment.");
    }
    try {
      const status = await provider.request({ method: "wallet_getCallsStatus", params: [bundleId] });

      // EIP-5792 status codes:
      // 100 = pending, 200 = confirmed success, 400 = offchain failure (and 5xx possible for chain rule failures)
      const code = Number(status?.status);
      if (code >= 200 && code < 300) {
        // If receipts exist, ensure they are successful
        const receipts = status?.receipts || [];
        const anyFailed = receipts.some(r => String(r?.status || "").toLowerCase() === "0x0");
        if (anyFailed) throw new Error("Transaction reverted.");
        return status;
      }
      if (code >= 400) {
        throw new Error("Transaction failed (wallet/bundler).");
      }
      // else pending
    } catch (e) {
      const msg = String(e?.message || e || "");
      // If wallet_getCallsStatus isn't supported, we can't reliably confirm; just wait a bit and return.
      if (msg.toLowerCase().includes("method not found") || msg.toLowerCase().includes("unsupported") || msg.toLowerCase().includes("does not exist")) {
        await sleep(1500);
        return { status: 100 };
      }
      // For intermittent provider errors, keep polling a few times.
    }
    await sleep(pollMs);
  }
}

async function walletSendCallsTap({ counter }) {
  const provider = await getProvider();

  // DO NOT call eth_requestAccounts every tap; it creates overlapping interactive prompts.
  const from = await ensureConnected(provider);

  await ensureBaseMainnet(provider);

  const actionId = bytes32FromAscii(ACTION_TAP);
  const data = uint256ToHex32(counter).replace(/^0x/, "0x");
  const calldata = abiEncodeLogAction(actionId, data);

  // Give each request a unique id (helps some hosts/wallets de-dupe UI flows).
  const reqId = `tap-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  const req = {
    version: "2.0.0",
    id: reqId,
    from,
    chainId: BASE_MAINNET_CHAIN_ID,
    atomicRequired: false,
    calls: [
      {
        to: TAP_CONTRACT,
        value: "0x0",
        data: calldata,
      },
    ],
    capabilities: {
      // ERC-8021 attribution (optional, wallet may ignore if unsupported).
      dataSuffix: {
        value: builderCodeSuffix,
        optional: true,
      },
    },
  };

  return sendCallsWithPaymasterFallback(provider, from, req);
}

async function processTapQueue() {
  if (tapSending) return;
  if (tapQueue <= 0) return;
  tapSending = true;
  try {
    while (tapQueue > 0) {
      const nextCounter = (Number(localStorage.getItem("tapCounter") || "0") || 0) + 1;
      setTapHint(`Confirm in walletâ€¦ (${tapQueue} queued)`);
      try {
        const res = await walletSendCallsTap({ counter: nextCounter });
        // wallet_sendCalls MUST NOT await finalization (EIP-5792), so we must
        // wait for wallet_getCallsStatus to confirm inclusion before we update local state.
        const bundleId = res?.id;
        if (bundleId) {
          setTapHint("Pending onchainâ€¦");
          await waitForCallBundleFinal(await getProvider(), bundleId);
        } else {
          // If wallet didn't return an id, wait briefly to avoid rapid nonce conflicts.
          await sleep(1200);
        }

        localStorage.setItem("tapCounter", String(nextCounter));

        // Only after confirmed inclusion do we add 1 Pata.
        pata += 1;
        store.setPata(pata);
        updateHud();
      } catch (e) {
        const msg = String(e?.message || e || "Transaction failed");
        if (msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("rejected")) {
          toast("Cancelled");
        } else if (msg.toLowerCase().includes("insufficient") || msg.toLowerCase().includes("fund")) {
          toast("Not enough Base ETH for gas (check the connected wallet address)");
        } else {
          toast(msg);
        }
      }
      // Let the wallet UI settle before triggering the next request.
      await sleep(220);
      tapQueue -= 1;
      setTapHint(tapQueue > 0 ? `Queued taps: ${tapQueue}` : "Tap");
    }
  } finally {
    tapSending = false;
    setTapHint("Tap");
  }
}

function enqueueTapTx() {
  if (!isReadyToSend()) {
    toast("Tap contract address invalid");
    return;
  }
  tapQueue += 1;
  setTapHint(`Queued taps: ${tapQueue}`);
  void processTapQueue();
}

async function walletSendCallsUsdc({ usdString, recipient }) {
  if (!isHexAddress(USDC_CONTRACT)) throw new Error("Invalid USDC contract");
  if (!isHexAddress(recipient)) throw new Error("Invalid recipient address");

  const provider = await getProvider();

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  const from = accounts?.[0];
  if (!from) throw new Error("No account selected");

  const chainId = await ensureBaseMainnet(provider);

  const units = parseUsdcToBaseUnits(usdString);
  const data = encodeErc20Transfer(recipient, units);

  const req = {
    version: "2.0.0",
    from,
    chainId,
    // Prefer sequential execution for maximum host compatibility.
    atomicRequired: false,
    calls: [{
      to: USDC_CONTRACT,
      value: "0x0",
      data
    }],
    capabilities: {
      dataSuffix: {
        value: builderCodeSuffix,
        optional: true,
      }
    }
  };

  // EIP-5792
  return sendCallsWithPaymasterFallback(provider, from, req);
}

// ---------- Tip modal state machine ----------
const tipState = {
  status: "idle", // idle | preparing | wallet | sending | done
  usd: ""
};

function setTipCta(text, disabled) {
  const btn = document.getElementById("tipCta");
  btn.textContent = text;
  btn.disabled = !!disabled;
}

function setPrepAnim(on) {
  document.getElementById("prepAnim").classList.toggle("show", !!on);
}

function resetTipUi() {
  tipState.status = "idle";
  setPrepAnim(false);
  setTipCta("Send USDC", false);
}

async function runTipFlow(usdString) {
  tipState.usd = usdString;

  // Pre-transaction UX: animate 1â€“1.5s BEFORE wallet opens
  tipState.status = "preparing";
  setTipCta("Preparing tipâ€¦", true);
  setPrepAnim(true);
  await new Promise((r) => setTimeout(r, 1200));

  try {
    tipState.status = "wallet";
    setTipCta("Confirm in wallet", true);

    const res = await walletSendCallsUsdc({ usdString, recipient: TIP_RECIPIENT });

    tipState.status = "sending";
    setTipCta("Sendingâ€¦", true);

    // If wallet returns immediately, we still show a short sending state.
    await new Promise((r) => setTimeout(r, 900));

    tipState.status = "done";
    setPrepAnim(false);
    setTipCta("Send again", false);

    toast("Tip sent âœ…");
    return res;
  } catch (e) {
    // Handle user rejection / errors gracefully
    setPrepAnim(false);
    resetTipUi();

    const msg = String(e?.message || e || "Transaction failed");
    if (msg.toLowerCase().includes("user rejected") || msg.toLowerCase().includes("rejected")) {
      toast("Cancelled");
    } else {
      toast(msg);
    }
    throw e;
  }
}

// ---------- Earn flow ----------
async function runEarnFlow() {
  // Fixed 1 USDC
  setEarnButtonState("Preparingâ€¦", true);
  // same pre-transaction animation
  await new Promise((r) => setTimeout(r, 1200));

  try {
    setEarnButtonState("Confirm in wallet", true);
    await walletSendCallsUsdc({ usdString: "1", recipient: TIP_RECIPIENT });
    setEarnButtonState("Earningâ€¦", true);
    await new Promise((r) => setTimeout(r, 900));

    // reward
    pata += 10000;
    energy = 100;
    store.setPata(pata);
    store.setEnergy(energy);
    updateHud();

    toast("Earned +10,000 Pata âœ…");
    setEarnButtonState("Earn with 1 USDC", false);
  } catch (e) {
    setEarnButtonState("Earn with 1 USDC", false);
  }
}

function setEarnButtonState(text, disabled) {
  const btn = document.getElementById("earnBtn");
  btn.textContent = text;
  btn.disabled = !!disabled;
}

// ---------- Boot ----------
function wireUi() {
  updateHud();
  startEnergyRegen();
  setTapHint("Tap");

  const tapArea = document.getElementById("tapArea");
  // Use Pointer Events only to avoid double-firing (pointerdown + touchstart).
  tapArea.addEventListener("pointerdown", onTap, { passive: true });

  document.getElementById("navGame").addEventListener("click", () => {
    showPanel("game");
    closeSheet();
  });
  document.getElementById("navEarn").addEventListener("click", () => {
    showPanel("earn");
    closeSheet();
  });
  document.getElementById("navTip").addEventListener("click", () => {
    showPanel("tip");
    openSheet();
  });

  document.getElementById("closeSheet").addEventListener("click", () => {
    closeSheet();
    showPanel("game");
  });
  document.getElementById("sheetBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "sheetBackdrop") {
      closeSheet();
      showPanel("game");
    }
  });

  // presets
  document.querySelectorAll(".preset").forEach((b) => {
    b.addEventListener("click", () => {
      const v = b.getAttribute("data-usd") || "";
      document.getElementById("customUsd").value = v;
      resetTipUi();
    });
  });

  document.getElementById("tipCta").addEventListener("click", async () => {
    const usd = document.getElementById("customUsd").value.trim();
    if (tipState.status === "done") {
      resetTipUi();
      return;
    }
    await runTipFlow(usd);
  });

  document.getElementById("earnBtn").addEventListener("click", async () => {
    await runEarnFlow();
  });

  // init states
  resetTipUi();
  setEarnButtonState("Earn with 1 USDC", false);
  showPanel("game");
}

async function safeReady() {
  try {
    // MUST be called so Mini App splash disappears.
    await sdk.actions.ready({ disableNativeGestures: false });
  } catch {
    // If opened in a browser (not allowed), ignore.
  }
}

window.addEventListener("load", async () => {
  await loadRuntimeConfig();
  wireUi();
  // Call ready as soon as UI is stable.
  await safeReady();
});
