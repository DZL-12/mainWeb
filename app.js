// app.js - 통합 초기화 관리자 (RPC 최적화 버전)
// 지갑 연결 전에는 RPC 호출 없이 UI만 로드

const APP_STATE = {
  walletReady: false,
  contractReady: false,
  uiReady: false,
  loadingContract: false,
  initError: null,
  retryCount: 0,
  maxRetries: 3
};

const TIMEOUTS = {
  walletInit: 5000,       // 5초
  contractInit: 8000,    // 8초
  rpcCall: 8000           // 8초
};

// 타임아웃이 있는 Promise 래퍼
function withTimeout(promise, ms, errorMsg) {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMsg || `Timeout after ${ms}ms`)), ms)
    )
  ]);
}

// 로딩 상태 UI 업데이트
function updateLoadingUI(message, isError = false) {
  const statusBox = document.getElementById('mintStatusBox');
  if (!statusBox) return;
  
  const statusClass = isError ? 'mint__status--error' : 'mint__status--info';
  statusBox.innerHTML = `
    <div class="mint__status ${statusClass}">
      <div class="mint__statusIcon">
        ${isError ? 
          '<i data-lucide="alert-circle"></i>' : 
          '<div class="spinner"></div>'
        }
      </div>
      <div class="mint__statusText">${message}</div>
      ${isError ? `
        <button class="mint__retryBtn" onclick="window.retryInitialization()">
          <i data-lucide="refresh-cw"></i> Retry
        </button>
      ` : ''}
    </div>
  `;
  
  if (window.lucide) window.lucide.createIcons();
}

// 초기화 재시도
window.retryInitialization = async function() {
  if (APP_STATE.retryCount >= APP_STATE.maxRetries) {
    updateLoadingUI('⚠️ The maximum number of retries has been reached. Please refresh the page.', true);
    return;
  }

  // ✅ 지갑 연결 전에는 RPC(컨트랙트 로드)를 절대 시도하지 않음
  try {
    const { getWalletState } = await import('./wallet.js');
    const st = getWalletState();
    if (!st.connected) {
      updateLoadingUI('🔒 Connect wallet first.', true);
      showConnectWalletOverlay();
      return;
    }
  } catch {
    updateLoadingUI('🔒 Connect wallet first.', true);
    showConnectWalletOverlay();
    return;
  }
  
  APP_STATE.retryCount++;
  updateLoadingUI(`🔄 Retrying initialization (${APP_STATE.retryCount}/${APP_STATE.maxRetries})...`);
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  await loadContractData();
};

// 메인 초기화 함수 (지갑 연결 전에는 기본 UI만 로드)
export async function initializeApp() {
  console.log('🚀 Starting app initialization...');
  
  try {
    // 1단계: Contract 설정만 검증 (RPC 호출 없음)
    const { CONTRACT_ADDRESS } = await import('./contract.js');
    
    if (!CONTRACT_ADDRESS || CONTRACT_ADDRESS === "0x0000000000000000000000000000000000000000") {
      throw new Error('Contract address not configured');
    }
    
    APP_STATE.contractReady = true;
    console.log('✅ Contract configuration verified');
    
    // 2단계: Wallet UI만 초기화 (Contract 데이터는 지갑 연결 후 로드)
    const walletMod = await import('./wallet.js');
    await walletMod.initWalletUI();
    
    APP_STATE.walletReady = true;
    console.log('✅ Wallet UI initialized');
    
    // ✅ 새로고침(F5) 후에도 이미 연결된 지갑이면 자동으로 컨트랙트 로드
    const st = walletMod.getWalletState();
    // ✅ 크롬/확장 지갑 환경에서는 새로고침 직후 chainId 판별이 늦거나 실패하는 케이스가 있어
    // "연결됨"만 확인되면 컨트랙트 데이터(READ RPC)는 로드한다.
    // (민트 실행은 mint.js에서 isCorrectNetwork로 계속 제어)
    if (st.connected) {
      console.log('🔁 Wallet already connected - auto loading contract data');
      await loadContractData();
    } else {
      // Connect Wallet 오버레이 표시
      showConnectWalletOverlay();

      // 지갑이 나중에 연결되면 자동 로드 (중복 호출 방지)
      walletMod.onWalletStateChange(async (next) => {
        if (APP_STATE.uiReady || APP_STATE.loadingContract) return;
        if (next.connected) {
          await loadContractData();
        }
      });
    }
    
    console.log('🎉 App initialization complete (waiting for wallet connection)');
    
    // 초기화 완료 이벤트 발생
    window.dispatchEvent(new CustomEvent('app:initialized'));
    
  } catch (error) {
    console.error('❌ Initialization failed:', error);
    APP_STATE.initError = error;
    
    const errorMsg = getErrorMessage(error);
    updateLoadingUI(`❌ ${errorMsg}`, true);
  }
}

// 지갑 연결 후 Contract 데이터 로드
export async function loadContractData() {
  if (APP_STATE.loadingContract) return;
  APP_STATE.loadingContract = true;
  console.log('📡 Loading contract data after wallet connection...');
  
  try {
    updateLoadingUI('📡 Loading contract data...');
    
    const { initMint } = await import('./mint.js');
    
    await withTimeout(
      initMint(),
      TIMEOUTS.contractInit,
      'Contract data loading timeout'
    );
    
    APP_STATE.uiReady = true;
    console.log('✅ Contract data loaded');
    
    // 오버레이 제거
    hideConnectWalletOverlay();
    
    // 초기화 완료
    APP_STATE.initError = null;
    APP_STATE.retryCount = 0;
    APP_STATE.loadingContract = false;
    
  } catch (error) {
    console.error('❌ Contract data loading failed:', error);
    APP_STATE.initError = error;
    APP_STATE.loadingContract = false;
    
    const errorMsg = getErrorMessage(error);
    updateLoadingUI(`❌ ${errorMsg}`, true);
    
    // 자동 재시도 (최대 횟수 미만일 때)
    if (APP_STATE.retryCount < APP_STATE.maxRetries) {
      APP_STATE.retryCount++;
      setTimeout(() => {
        loadContractData();
      }, 3000);
    }
  }
}

// Connect Wallet 오버레이 표시
function showConnectWalletOverlay() {
  const mintCard = document.querySelector('.mint__card');
  if (!mintCard) return;
  
  // 기존 오버레이 제거
  const existingOverlay = document.getElementById('connectWalletOverlay');
  if (existingOverlay) existingOverlay.remove();
  
  // 오버레이 생성
  // ✅ 뒤 UI 잠금(블러/클릭방지)
  mintCard.classList.add('mint__card--locked');

  const hasWallet = typeof window !== 'undefined' && !!window.ethereum;

  const overlay = document.createElement('div');
  overlay.id = 'connectWalletOverlay';
  overlay.className = 'connect-wallet-overlay';
  overlay.innerHTML = `
    <div class="connect-wallet-overlay__content">
      <div class="connect-wallet-overlay__icon">
        <i data-lucide="wallet"></i>
      </div>
      <h3 class="connect-wallet-overlay__title">${hasWallet ? 'Connect Your Wallet' : 'Wallet Not Found'}</h3>
      <p class="connect-wallet-overlay__desc">
        ${hasWallet
          ? 'Connect your wallet to load mint data and start minting.'
          : 'Please install MetaMask (or another EVM wallet) to use minting features.'}
      </p>
      <button id="overlayConnectBtn" class="connect-wallet-overlay__btn" type="button">
        <i data-lucide="wallet"></i>
        <span>${hasWallet ? 'Connect Wallet' : 'Install MetaMask'}</span>
      </button>
    </div>
  `;

  mintCard.appendChild(overlay);
  
  const overlayBtn = document.getElementById('overlayConnectBtn');
  if (overlayBtn) {
    overlayBtn.addEventListener('click', async () => {
      try {
        if (!hasWallet) {
          window.open('https://metamask.io/download/', '_blank', 'noopener,noreferrer');
          return;
        }
        const { connectWallet } = await import('./wallet.js');
        await connectWallet();
        
        await loadContractData();
      } catch (err) {
        console.error('Wallet connection failed:', err);
      }
    });
  }
  
  if (window.lucide) window.lucide.createIcons();
}

function hideConnectWalletOverlay() {
  const overlay = document.getElementById('connectWalletOverlay');
  if (overlay) {
    overlay.classList.add('connect-wallet-overlay--hide');
    setTimeout(() => overlay.remove(), 300);
  }

  const mintCard = document.querySelector('.mint__card');
  if (mintCard) mintCard.classList.remove('mint__card--locked');
}

function getErrorMessage(error) {
  const message = error?.message || error?.toString() || 'Unknown error';
  
  if (message.includes('timeout')) {
    return 'Connection timeout. Please check your network.';
  }
  if (message.includes('MetaMask') || message.includes('wallet')) {
    return 'Wallet connection failed. Please install MetaMask.';
  }
  if (message.includes('network') || message.includes('chain')) {
    return 'Network error. Please check your RPC connection.';
  }
  if (message.includes('contract')) {
    return 'Contract loading failed. Please try again.';
  }
  
  return `Initialization failed: ${message}`;
}

export function getAppState() {
  return { ...APP_STATE };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeApp);
} else {
  initializeApp();
}