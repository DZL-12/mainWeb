// mint.js (ESM)

const { ethers } = window;

import {
  getReadContract,
  getWriteContract,
  normalizeEvmError,
  toPercent,
  TARGET_CHAIN,
} from "./contract.js";

import {
  initWalletUI,
  getWalletState,
  onWalletStateChange,
  connectWallet,
} from "./wallet.js";

let mintPhase = "whitelist";
let mintAmount = 1;

let lastStatus = null;
let lastUserInfo = null;
let lastTotals = null;
let lastLimits = null;

let previousEpoch = 0;
let whitelistCheckStatus = "unchecked";
let isMinting = false;
let isUIBound = false;


const READ_PROVIDER = new ethers.JsonRpcProvider(
  TARGET_CHAIN.rpcUrls[0],
  TARGET_CHAIN.chainId
);

function $id(id) {
  return document.getElementById(id);
}
function setText(id, text) {
  const el = $id(id);
  if (el) el.textContent = text;
}
function setHTML(id, html) {
  const el = $id(id);
  if (el) el.innerHTML = html;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function weiToEthStr(weiBigint) {
  try {
    return ethers.formatEther(weiBigint);
  } catch {
    return "0";
  }
}

function formatEthFixed(ethStr, digits = 4) {
  const x = Number(ethStr);
  if (!Number.isFinite(x)) return ethStr;
  return x.toFixed(digits);
}

function getUserFriendlyError(err) {
  const msg = normalizeEvmError(err);
  
  if (msg.includes("user rejected") || msg.includes("User rejected")) {
    return "You cancelled the transaction.";
  }
  if (msg.includes("insufficient funds")) {
    return "Insufficient funds in your wallet. Please add more ETH.";
  }
  if (msg.includes("gas")) {
    return "Gas fee error. Try increasing gas limit or check network congestion.";
  }
  if (msg.includes("NotWhitelisted")) {
    return "You are not on the whitelist for this mint phase.";
  }
  if (msg.includes("WhitelistMintNotStarted")) {
    return "Whitelist minting has not started yet. Please wait for announcement.";
  }
  if (msg.includes("PublicMintNotStarted")) {
    return "Public minting has not started yet. Please check back later.";
  }
  if (msg.includes("MintAmountExceedsLimit")) {
    return "Mint amount exceeds your allowed limit for this transaction.";
  }
  if (msg.includes("IncorrectETHAmount")) {
    return "Incorrect ETH amount sent. Please check the total cost.";
  }
  if (msg.includes("SaleRangeExceeded")) {
    return "Sale limit reached for this epoch. All NFTs are minted.";
  }
  if (msg.includes("MaxSupplyExceeded")) {
    return "Maximum supply has been reached. Minting is closed.";
  }
  if (msg.includes("TransfersPaused") || msg.includes("Pausable: paused")) {
    return "Contract is currently paused by admin. Please try again later.";
  }
  if (msg.includes("EpochNotStarted")) {
    return "Current round has not started yet. Please wait for admin to start a new round.";
  }
  if (msg.includes("WhitelistMintLimitExceeded")) {
    return "You have reached your whitelist mint limit (2 NFTs) for this round.";
  }
  if (msg.includes("PublicMintLimitExceeded")) {
    return "You have reached your public mint limit (12 NFTs) for this round.";
  }
  
  return msg.length > 200 ? "Transaction failed. Please check console for details." : msg;
}

function showErrorModal(title, message) {
  const modal = document.createElement('div');
  modal.className = 'error-modal';
  modal.innerHTML = `
    <div class="error-modal__overlay"></div>
    <div class="error-modal__panel">
      <div class="error-modal__icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="12" y1="8" x2="12" y2="12"></line>
          <line x1="12" y1="16" x2="12.01" y2="16"></line>
        </svg>
      </div>
      <h3 class="error-modal__title">${title}</h3>
      <p class="error-modal__message">${message}</p>
      <button class="error-modal__btn" type="button">OK</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const btn = modal.querySelector('.error-modal__btn');
  const overlay = modal.querySelector('.error-modal__overlay');
  
  const close = () => modal.remove();
  
  btn.addEventListener('click', close);
  overlay.addEventListener('click', close);
  
  requestAnimationFrame(() => modal.classList.add('show'));
}

function showSuccessModal(title, message, txHash = null) {
  const modal = document.createElement('div');
  modal.className = 'success-modal';
  
  const explorerLink = txHash 
    ? `<a href="https://sepolia.etherscan.io/tx/${txHash}" target="_blank" class="success-modal__link">View on Explorer</a>`
    : '';
  
  modal.innerHTML = `
    <div class="success-modal__overlay"></div>
    <div class="success-modal__panel">
      <div class="success-modal__icon">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
          <polyline points="22 4 12 14.01 9 11.01"></polyline>
        </svg>
      </div>
      <h3 class="success-modal__title">${title}</h3>
      <p class="success-modal__message">${message}</p>
      ${explorerLink}
      <button class="success-modal__btn" type="button">OK</button>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const btn = modal.querySelector('.success-modal__btn');
  const overlay = modal.querySelector('.success-modal__overlay');
  
  const close = () => modal.remove();
  
  btn.addEventListener('click', close);
  overlay.addEventListener('click', close);
  
  requestAnimationFrame(() => modal.classList.add('show'));
}

async function fetchAllStatuses() {
  const { provider: walletProvider, address, connected, isCorrectNetwork } = getWalletState();

  const readProvider = walletProvider || READ_PROVIDER;
  const c = getReadContract(readProvider);
  const [
    totalMinted,
    maxSupply,
    paused,
    currentEpoch,
    saleEndTokenId,
    limits,
    whitelistStart,
    publicStart,
  ] = await Promise.all([
    c.totalMinted(),
    c.maxSupply(),
    c.paused(),
    c.currentEpoch(),
    c.saleEndTokenId(),
    c.perTxMintLimits(),
    c.whitelistStart(),
    c.publicStart(),
  ]);

  const epochNum = Number(currentEpoch);
  if (epochNum !== previousEpoch && previousEpoch !== 0) {
    console.log(`🔄 Epoch changed: ${previousEpoch} → ${epochNum}`);
    whitelistCheckStatus = "unchecked";
    previousEpoch = epochNum;
  } else if (previousEpoch === 0) {
    previousEpoch = epochNum;
  }

  lastTotals = {
    totalMinted,
    maxSupply,
    paused,
    currentEpoch,
    saleEndTokenId,
    whitelistStart,
    publicStart
  };

  lastLimits = {
    whitelistPerTx: limits[0],
    publicPerTx: limits[1],
    operatorPerTx: limits[2],
  };

  const user = connected && address ? address : ethers.ZeroAddress;

  const [wlStatus, pubStatus] = await Promise.all([
    c.whitelistMintStatus(user),
    c.publicMintStatus(user),
  ]);

  if (connected && address) {
    try {
      const info = await c.getUserMintInfo(address);
      lastUserInfo = {
        whitelistMintedThisEpoch: info[0],
        publicMintedThisEpoch: info[1],
        totalMintedThisEpoch: info[2],
        whitelistRemainingThisEpoch: info[3],
        publicRemainingThisEpoch: info[4],
        maxPossibleMintThisEpoch: info[5],
        epoch: info[6],
      };
    } catch (e) {
      lastUserInfo = null;
    }
  } else {
    lastUserInfo = null;
  }

  lastStatus = {
    whitelist: {
      isOpen: wlStatus[0],
      isWhitelisted: wlStatus[1],
      priceWei: wlStatus[2],
      nextTokenId: wlStatus[3],
      endTokenId: wlStatus[4],
      remaining: wlStatus[5],
      userMintedWhitelist: wlStatus[6],
      userRemainingWhitelist: wlStatus[7],
      epoch: wlStatus[8],
    },
    public: {
      isOpen: pubStatus[0],
      priceWei: pubStatus[1],
      nextTokenId: pubStatus[2],
      endTokenId: pubStatus[3],
      remaining: pubStatus[4],
      userMintedPublic: pubStatus[5],
      userRemainingPublic: pubStatus[6],
      epoch: pubStatus[7],
    },
  };

  return lastStatus;
}

function getPhaseStatus() {
  if (!lastStatus) return null;
  return mintPhase === "whitelist" ? lastStatus.whitelist : lastStatus.public;
}

function getPhasePerTxLimit() {
  if (!lastLimits) return 1;
  return Number(mintPhase === "whitelist" ? lastLimits.whitelistPerTx : lastLimits.publicPerTx);
}

function computeMintAmountUpperBound() {
  const st = getPhaseStatus();
  if (!st) return 1;

  const perTx = getPhasePerTxLimit();
  const remaining = Number(st.remaining ?? 0);
  
  const isWhitelist = mintPhase === "whitelist";
  const userRemaining = Number(
    isWhitelist ? (st.userRemainingWhitelist ?? perTx) : (st.userRemainingPublic ?? perTx)
  );

  return Math.max(1, Math.min(perTx, userRemaining, remaining));
}

function renderPhaseTitle() {
  const titleEl = $id("mintPhaseTitle");
  if (!titleEl) return;
  
  const isWhitelist = mintPhase === "whitelist";
  titleEl.textContent = isWhitelist ? "Whitelist Mint" : "Public Mint";
}

function renderTabs() {
  const tabWl = $id("tabWhitelist");
  const tabPb = $id("tabPublic");
  if (!tabWl || !tabPb) return;

  if (mintPhase === "whitelist") {
    tabWl.setAttribute("aria-selected", "true");
    tabPb.setAttribute("aria-selected", "false");
    tabWl.classList.add("mint__tab--active");
    tabPb.classList.remove("mint__tab--active");
  } else {
    tabWl.setAttribute("aria-selected", "false");
    tabPb.setAttribute("aria-selected", "true");
    tabWl.classList.remove("mint__tab--active");
    tabPb.classList.add("mint__tab--active");
  }
}

function renderAmountControls() {
  const amt = $id("mintAmount");
  const minus = $id("mintMinus");
  const plus = $id("mintPlus");

  if (amt) amt.textContent = mintAmount;

  const upper = computeMintAmountUpperBound();

  if (minus) minus.disabled = mintAmount <= 1;
  if (plus) plus.disabled = mintAmount >= upper;
}

function renderPriceAndTotal() {
  const st = getPhaseStatus();
  if (!st) {
    setText("priceLabel", "TBD");
    setText("totalCostLabel", "TBD");
    return;
  }

  const priceWei = BigInt(st.priceWei ?? 0);
  const priceEth = weiToEthStr(priceWei);
  const priceFormatted = formatEthFixed(priceEth, 4);
  
  const priceText = priceWei === 0n ? "TBD" : `${priceFormatted} ETH`;

  setText("priceLabel", priceText);

  const total = priceWei * BigInt(mintAmount);
  const totalEth = weiToEthStr(total);
  const totalFormatted = formatEthFixed(totalEth, 4);
  const totalText = priceWei === 0n ? "TBD" : `${totalFormatted} ETH`;

  setText("totalCostLabel", totalText);
}

function renderProgress() {
  // ✅ 첫 번째 진행바: Total Minted (MAX_SUPPLY 기준)
  const totalBar = $id("mintProgressBar");
  const totalLabel = $id("totalMintedLabel");

  // ✅ 두 번째 진행바: Round X Minted (현재 라운드 기준)
  const roundBar = $id("roundProgressBar");
  const roundLabel = $id("roundMintedLabel");
  const roundTitle = $id("roundProgressTitle");

  if (!lastTotals) {
    if (totalLabel) totalLabel.innerHTML = "<b>0</b> / 0";
    if (totalBar) totalBar.style.width = "0%";
    if (roundLabel) roundLabel.innerHTML = "<b>-</b>";
    if (roundBar) roundBar.style.width = "0%";
    if (roundTitle) roundTitle.textContent = "Not Started";
    return;
  }

  const minted = Number(lastTotals.totalMinted);
  const max = Number(lastTotals.maxSupply);
  const endId = Number(lastTotals.saleEndTokenId);
  const currentEpoch = Number(lastTotals.currentEpoch || 0);

  // ✅ Total Minted: maxSupply 기준
  const totalPct = max > 0 ? toPercent(BigInt(minted), BigInt(max)) : 0;
  if (totalLabel) totalLabel.innerHTML = `<b>${minted}</b> / ${max}`;
  if (totalBar) totalBar.style.width = `${totalPct}%`;

  // ✅ Epoch 0 처리: Round Not Started
  if (currentEpoch === 0) {
    if (roundTitle) roundTitle.textContent = "Not Started";
    if (roundLabel) roundLabel.innerHTML = "<b>-</b>";
    if (roundBar) roundBar.style.width = "0%";
    return;
  }

  // ✅ Round X Minted: saleEndTokenId 기준
  const roundAmount = endId > 0 ? endId : 0;
  const roundPct = roundAmount > 0 ? toPercent(BigInt(minted), BigInt(roundAmount)) : 0;
  
  if (roundLabel) roundLabel.innerHTML = `<b>${minted}</b> / ${roundAmount}`;
  if (roundBar) roundBar.style.width = `${roundPct}%`;
  if (roundTitle) roundTitle.textContent = `Round ${currentEpoch} Minted`;
}

function renderLiveStatus() {
  const dot = $id("liveStatusDot");
  const txt = $id("liveStatusText");
  
  const whitelistStart = lastTotals?.whitelistStart ?? false;
  const publicStart = lastTotals?.publicStart ?? false;
  
  const isWhitelist = mintPhase === "whitelist";
  const phaseStarted = isWhitelist ? whitelistStart : publicStart;
  
  if (dot) {
    dot.className = phaseStarted ? "dot dot--live" : "dot dot--closed";
  }
  if (txt) {
    txt.textContent = phaseStarted ? "MINT LIVE" : "Closed";
  }
}

function renderMintButton() {
  const btn = $id("mintBtn");
  if (!btn) return;

  const { connected, isCorrectNetwork } = getWalletState();
  
  if (isMinting) {
    btn.disabled = true;
    btn.textContent = "Minting...";
    btn.style.background = "#9ca3af";
    btn.style.opacity = "0.8";
    btn.style.cursor = "wait";
    return;
  }

  if (connected && !isCorrectNetwork) {
    btn.disabled = false;
    btn.textContent = "Switch Network";
    btn.style.background = "#f59e0b";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    return;
  }

  if (!connected) {
    btn.disabled = false;
    btn.textContent = "Connect Wallet";
    btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
    return;
  }

  const st = getPhaseStatus();
  const paused = lastTotals?.paused ?? false;
  const epoch = Number(lastTotals?.currentEpoch ?? 0);
  const whitelistStart = lastTotals?.whitelistStart ?? false;
  const publicStart = lastTotals?.publicStart ?? false;

  const isWhitelist = mintPhase === "whitelist";
  const phaseStarted = isWhitelist ? whitelistStart : publicStart;
  
  const epochOk = epoch > 0;
  
  const whitelistOk = !isWhitelist || (st?.isWhitelisted === true);
  
  const userRemaining = isWhitelist
    ? Number(st?.userRemainingWhitelist ?? 0)
    : Number(st?.userRemainingPublic ?? 0);
  const totalRemaining = Number(st?.remaining ?? 0);
  
  const hasRemaining = userRemaining > 0 && totalRemaining > 0;

  const canMint = connected && phaseStarted && !paused && epochOk && whitelistOk && hasRemaining;

  btn.disabled = !canMint;

  if (!phaseStarted) {
    btn.textContent = isWhitelist ? "Whitelist Closed" : "Public Mint Closed";
    btn.style.background = "#dc2626";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (paused) {
    btn.textContent = "Contract Paused";
    btn.style.background = "#f59e0b";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (!epochOk) {
    btn.textContent = "Round Not Started";
    btn.style.background = "#f59e0b";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (isWhitelist && !whitelistOk) {
    btn.textContent = "Not Whitelisted";
    btn.style.background = "#dc2626";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (userRemaining <= 0) {
    btn.textContent = isWhitelist ? "WL Limit Reached" : "Public Limit Reached";
    btn.style.background = "#6b7280";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (totalRemaining <= 0) {
    btn.textContent = "Sold Out";
    btn.style.background = "#6b7280";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  } else if (canMint) {
    btn.textContent = "Mint";
    btn.style.background = "linear-gradient(135deg, #667eea 0%, #764ba2 100%)";
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
  } else {
    btn.textContent = "Mint Unavailable";
    btn.style.background = "#6b7280";
    btn.style.opacity = "0.6";
    btn.style.cursor = "not-allowed";
  }
}

function renderMintStatusBox() {
  if (!lastTotals) {
    return;
  }

  const isWhitelist = mintPhase === "whitelist";
  const st = getPhaseStatus();
  if (!st) {
    return;
  }

  const { connected, isCorrectNetwork } = getWalletState();
  const epochNum = Number(lastTotals.currentEpoch);
  const phaseStarted = isWhitelist ? lastTotals.whitelistStart : lastTotals.publicStart;

  const roundText = epochNum === 0 ? "ROUND NOT STARTED" : `ROUND ${epochNum} / 12`;

  let statusText = "CLOSED";
  let statusColor = "#dc2626";
  let statusBg = "#fee2e2";

  if (!lastTotals.paused && phaseStarted && epochNum > 0) {
    statusText = "LIVE";
    statusColor = "#16a34a";
    statusBg = "#dcfce7";
  }

  const userMinted = isWhitelist
    ? Number(st.userMintedWhitelist || 0)
    : Number(st.userMintedPublic || 0);
  const userRemaining = isWhitelist
    ? Number(st.userRemainingWhitelist || 0)
    : Number(st.userRemainingPublic || 0);

  const userMintText = connected
    ? `You minted: ${userMinted}`
    : "Connect wallet to see your status";
    
  const userRemainText = connected
    ? `Remaining: ${userRemaining}`
    : "";

  let whitelistStatusHTML = '';
  if (isWhitelist) {
    if (!connected) {
      whitelistStatusHTML = `
        <div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:#fef3c7;border:1px solid #f59e0b;">
          <span style="font-size:13px;color:#92400e;font-weight:700;">Please connect your wallet to check whitelist status</span>
        </div>
      `;
    } else if (whitelistCheckStatus === "unchecked") {
      whitelistStatusHTML = `
        <div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:#e0e7ff;border:1px solid #6366f1;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13px;color:#4338ca;font-weight:700;">Please check your whitelist status</span>
          <button id="checkWhitelistBtn" type="button" style="padding:6px 16px;border-radius:6px;border:none;background:#6366f1;color:white;font-size:12px;font-weight:700;cursor:pointer;transition:all 0.2s;box-shadow:0 2px 4px rgba(99,102,241,0.2);">
            Check Now
          </button>
        </div>
      `;
    } else if (whitelistCheckStatus === "checking") {
      whitelistStatusHTML = `
        <div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:#f3f4f6;border:1px solid #9ca3af;">
          <span style="font-size:13px;color:#6b7280;font-weight:700;">Checking whitelist status...</span>
        </div>
      `;
    } else if (whitelistCheckStatus === "checked" && st) {
      const isWhitelisted = st.isWhitelisted === true;
      const wlColor = isWhitelisted ? "#16a34a" : "#dc2626";
      const wlBg = isWhitelisted ? "#dcfce7" : "#fee2e2";
      const wlIcon = isWhitelisted ? "✓" : "✗";
      const wlText = isWhitelisted ? "You are whitelisted" : "Not whitelisted";
      
      whitelistStatusHTML = `
        <div style="margin-top:12px;padding:10px 14px;border-radius:8px;background:${wlBg};border:2px solid ${wlColor};display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:14px;color:${wlColor};font-weight:800;">${wlIcon} ${wlText}</span>
          <button id="checkWhitelistBtn" type="button" style="padding:6px 12px;border-radius:6px;border:1px solid ${wlColor};background:transparent;color:${wlColor};font-size:11px;font-weight:700;cursor:pointer;transition:all 0.2s;">
            Refresh
          </button>
        </div>
      `;
    }
  }

  const html = `
    <div style="padding:16px;border:1px solid #e5e7eb;border-radius:16px;background:#fff;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      <div style="display:flex;justify-content:space-between;align-items:center;padding-bottom:10px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:800;letter-spacing:0.08em;font-size:11px;text-transform:uppercase;color:#6b7280;">
          ${roundText}
        </div>
        <div style="padding:4px 10px;border-radius:6px;font-size:10px;font-weight:950;letter-spacing:0.18em;text-transform:uppercase;background:${statusBg};color:${statusColor};border:1px solid ${statusColor};">
          ${statusText}
        </div>
      </div>
      
      ${whitelistStatusHTML}
      
      <div style="margin-top:12px;display:flex;justify-content:space-between;align-items:center;padding:8px 0;">
        <span style="font-size:13px;color:#111827;">${userMintText}</span>
        <span style="font-weight:950;color:#111827;font-size:14px;">${userRemainText}</span>
      </div>
    </div>
  `;

  setHTML("mintStatusBox", html);
  
  const checkWlBtn = document.getElementById("checkWhitelistBtn");
  if (checkWlBtn) {
    checkWlBtn.addEventListener("click", async () => {
      whitelistCheckStatus = "checking";
      await fullRender();
      
      try {
        await refreshAndRender();
        whitelistCheckStatus = "checked";
        await fullRender();
        
        setTimeout(async () => {
          await fullRender();
        }, 1500);
      } catch (e) {
        whitelistCheckStatus = "unchecked";
        showErrorModal("Check Failed", "Failed to check whitelist status. Please try again.");
        await fullRender();
      }
    });
  }
}

function renderFootnote() {
  const note = $id("mintFootnote");
  if (!note) return;
  
  const perTx = getPhasePerTxLimit();
  note.textContent = `Max ${perTx} per transaction`;
}

async function fullRender() {
  renderPhaseTitle();
  renderTabs();
  renderAmountControls();
  renderPriceAndTotal();
  renderProgress();
  renderLiveStatus();
  renderMintButton();
  renderMintStatusBox();
  renderFootnote();
}

async function doMint() {
  const ws = getWalletState();

  if (!ws.connected) {
    await connectWallet();
    return;
  }
  if (!ws.signer || !ws.provider) {
    throw new Error("Signer/provider not ready.");
  }

  const st = getPhaseStatus();
  if (!st) throw new Error("Status not loaded.");

  const upper = computeMintAmountUpperBound();
  mintAmount = clamp(mintAmount, 1, upper);

  const priceWei = BigInt(st.priceWei);
  const value = priceWei * BigInt(mintAmount);

  const c = getWriteContract(ws.signer);

  const fn = mintPhase === "whitelist" ? "whitelistMint" : "publicMint";

  const tx = await c[fn](mintAmount, { value });

  const receipt = await tx.wait();

  showSuccessModal(
    "Mint Successful!",
    `Successfully minted ${mintAmount} NFT${mintAmount > 1 ? 's' : ''}`,
    tx.hash
  );

  await refreshAndRender();
  setTimeout(refreshAndRender, 3000);
}

let retryCount = 0;
let isFirstLoadSuccess = false;
let backoffDelay = 2000;

async function refreshAndRender() {
  try {
    await fetchAllStatuses();
    await fullRender();
    
    if (!isFirstLoadSuccess) {
      isFirstLoadSuccess = true;
      console.log("✅ First load successful");
    }
    retryCount = 0;
    backoffDelay = 2000;
  } catch (e) {
    console.error("Refresh failed:", normalizeEvmError(e));
    
    if (!isFirstLoadSuccess) {
      retryCount++;
      
      setText("mintPhaseTitle", "Connecting...");
      setText("liveStatusText", `Retry ${retryCount}`);
      setText("priceLabel", "...");
      setText("totalMintedLabel", "Connecting to network...");
      
      const btn = $id("mintBtn");
      if (btn) {
        btn.innerHTML = `
          <span style="display:flex;align-items:center;justify-content:center;gap:8px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="23 4 23 10 17 10"></polyline>
              <polyline points="1 20 1 14 7 14"></polyline>
              <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            Refresh
          </span>
        `;
        btn.disabled = false;
        btn.style.cursor = "pointer";
        btn.style.opacity = "1";
        btn.style.background = "#667eea";
        btn.onclick = () => location.reload();
      }
      
      setText("mintFootnote", `Auto retry in ${Math.ceil(backoffDelay/1000)}s or click Refresh`);
      
      setTimeout(() => refreshAndRender(), backoffDelay);
      backoffDelay = Math.min(backoffDelay * 1.5, 30000);
    }
  }
}

const handleTabWhitelistClick = async () => {
  mintPhase = "whitelist";
  mintAmount = 1;
  whitelistCheckStatus = "unchecked";
  await refreshAndRender();
};

const handleTabPublicClick = async () => {
  mintPhase = "public";
  mintAmount = 1;
  await refreshAndRender();
};

const handleMinusClick = async () => {
  mintAmount = clamp(mintAmount - 1, 1, computeMintAmountUpperBound());
  await fullRender();
};

const handlePlusClick = async () => {
  mintAmount = clamp(mintAmount + 1, 1, computeMintAmountUpperBound());
  await fullRender();
};

const handleMintBtnClick = async () => {
  const ws = getWalletState();
  
  if (!ws.connected) {
    try {
      await connectWallet();
    } catch (e) {
      console.error("Wallet connection failed:", e);
      showErrorModal("Connection Failed", "Failed to connect wallet. Please try again.");
    }
    return;
  }
  
  if (ws.connected && ws.isCorrectNetwork === false) {
    try {
      await connectWallet();
    } catch (e) {
      showErrorModal("Wrong Network", "Please switch to the correct network and try again.");
    }
    return;
  }

  if (isMinting) return;
  
  isMinting = true;
  await fullRender();
  
  try {
    await doMint();
  } catch (e) {
    const friendlyMsg = getUserFriendlyError(e);
    showErrorModal("Mint Failed", friendlyMsg);
  } finally {
    isMinting = false;
    await fullRender();
  }
};

function bindUI() {
  if (isUIBound) {
    console.log("⚠️ UI already bound, skipping duplicate binding");
    return;
  }

  const tabWl = $id("tabWhitelist");
  const tabPb = $id("tabPublic");
  const minus = $id("mintMinus");
  const plus = $id("mintPlus");
  const mintBtn = $id("mintBtn");

  if (tabWl) {
    tabWl.removeEventListener("click", handleTabWhitelistClick);
    tabWl.addEventListener("click", handleTabWhitelistClick);
  }
  
  if (tabPb) {
    tabPb.removeEventListener("click", handleTabPublicClick);
    tabPb.addEventListener("click", handleTabPublicClick);
  }

  if (minus) {
    minus.removeEventListener("click", handleMinusClick);
    minus.addEventListener("click", handleMinusClick);
  }

  if (plus) {
    plus.removeEventListener("click", handlePlusClick);
    plus.addEventListener("click", handlePlusClick);
  }

  if (mintBtn) {
    mintBtn.removeEventListener("click", handleMintBtnClick);
    mintBtn.addEventListener("click", handleMintBtnClick);
  }

  isUIBound = true;
  console.log("✅ UI bound successfully");
}

export async function initMint() {
  try {
    await initWalletUI();
    
    await refreshAndRender();
    
    bindUI();

    onWalletStateChange(async () => {
      await refreshAndRender();
    });

    setInterval(async () => {
      if (document.hidden) {
        console.log("⏸️ Page hidden, skipping refresh");
        return;
      }
      await refreshAndRender();
    }, 15000);
    
    document.addEventListener("visibilitychange", async () => {
      if (!document.hidden && isFirstLoadSuccess) {
        console.log("👁️ Page visible, refreshing...");
        await refreshAndRender();
      }
    });
    
  } catch (e) {
    console.error("initMint failed:", normalizeEvmError(e));
    
    setInterval(async () => {
      if (document.hidden) return;
      console.log("Retrying after critical error...");
      await refreshAndRender();
    }, 15000);
  }
}