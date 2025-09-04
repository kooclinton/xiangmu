// allocateDeployerWallets.js - v2.1.2-FixEthers
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Wallet, parseEther, formatEther as ethersFormatEther, JsonRpcProvider } from "ethers";
import { fileURLToPath } from "url";
import { dynamicPrivacyPath } from "../modules/mixer.js";
import { initRpcManager, getOptimalRpcProvider, getRpcProviderList } from "../config/rpcManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 网络到代币符号映射（添加更多网络支持）
const tokenSymbols = {
  bsc: "BNB",
  bsc_testnet: "BNB",
  polygon: "MATIC",
  ethereum: "ETH",
  arbitrum: "ETH",
  optimism: "ETH",
  avax: "AVAX",
  fantom: "FTM",
  base: "ETH",
  sepolia: "ETH",
  goerli: "ETH",
  mainnet: "ETH"
};

const userId = process.argv[2];
const network = process.argv[3];
let deployId = process.argv[4];
const shouldFund = process.argv.includes("--fund");

if (!userId || !network) {
  console.error("❌ 用法: node allocateDeployerWallets.js <userId> <network> [deployId|auto] [--fund]");
  process.exit(1);
}

// 获取当前网络的代币符号
const tokenSymbol = tokenSymbols[network.toLowerCase()] || "ETH";

// 自动生成 deployId
function genDeployId() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, "0");
  return `ms-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${Math.floor(Math.random() * 10000)}`;
}

if (!deployId || deployId.toLowerCase() === "auto") {
  deployId = genDeployId();
  console.log(`📦 自动生成 DeployID: ${deployId}`);
}

// ✅ 关键修复：初始化RPC管理器
try {
  initRpcManager(userId);
  console.log('✅ RPC管理器初始化成功');
} catch (error) {
  console.error('❌ RPC管理器初始化失败:', error.message);
  process.exit(1);
}

// 打印格式化的用户信息
console.log("══════════════════════════════════════════════");
console.log(`[用户ID]         : ${userId}`);
console.log(`[网络]           : ${network} (${tokenSymbol})`);
console.log(`[部署ID]         : ${deployId}`);
console.log("══════════════════════════════════════════════");

const walletDir = path.join(__dirname, "../wallets", userId, deployId);
const deployDir = path.join(__dirname, "../deployments", userId, network, deployId);
const envPath = path.join(__dirname, "../configs", userId, ".env");

dotenv.config({ path: envPath });

if (!fs.existsSync(walletDir)) fs.mkdirSync(walletDir, { recursive: true });
if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

// 自动生成 deployer 钱包（logic/proxy/admin）
const roles = ["logic", "proxy", "admin"];
const deployers = roles.map(role => {
  const w = Wallet.createRandom();
  return {
    role,
    address: w.address,
    privateKey: w.privateKey,
    createdAt: new Date().toISOString()
  };
});

fs.writeFileSync(path.join(walletDir, "deployers.json"), JSON.stringify(deployers, null, 2));

// 生成 whitelist
const whitelistPath = path.join(deployDir, "whitelist.json");
const whitelist = deployers.map(w => w.address);
fs.writeFileSync(whitelistPath, JSON.stringify(whitelist, null, 2));

console.log(`\n✅ Deployer 钱包已生成并写入 deployers.json 和 whitelist.json (${tokenSymbol})`);

// 处理注资操作
const handleFunding = async () => {
  // 直接使用环境变量或默认值
  const toBigInt = (value, defaultValue) => 
    parseEther(process.env[value] || defaultValue);

  const fundAmounts = {
    logic: toBigInt("FUND_AMOUNT_LOGIC", "0.05"),
    proxy: toBigInt("FUND_AMOUNT_PROXY", "0.05"),
    admin: toBigInt("FUND_AMOUNT_ADMIN", "1.0")
  };

  const targets = [
    { address: deployers[0].address, amount: fundAmounts.logic, role: "logic" },
    { address: deployers[1].address, amount: fundAmounts.proxy, role: "proxy" },
    { address: deployers[2].address, amount: fundAmounts.admin, role: "admin" }
  ];
  
  console.log(`\n💰 正在为部署钱包注资 (${tokenSymbol})...`);
  
  try {
    // 创建最优 RPC 提供者
      let provider;
      try {
        provider = await getOptimalRpcProvider(network);
        
        // 安全获取URL
        let providerUrl = "未知";
        try {
          providerUrl = provider.connection?.url || 
                       provider._getConnection?.().url || 
                       "未知";
        } catch (e) {
          providerUrl = "无法获取URL";
        }
        console.log(`🔗 使用最优 RPC 节点: ${providerUrl}`);
      } catch (rpcError) {
        console.error(`❌ 无法获取最优 RPC 节点: ${rpcError.message}`);
        console.error(`⚠️ 使用默认 RPC 节点`);
        const rpcList = getRpcProviderList(network);
        provider = new JsonRpcProvider(rpcList[0]); // 使用导入的 JsonRpcProvider
      }
    
    // 检查主钱包余额
    const mainWallet = new Wallet(process.env.PRIVATE_KEY, provider);
    const balance = await provider.getBalance(mainWallet.address);
    
    // 将缓冲从2%降低到0.5%
    const totalAmount = fundAmounts.logic + fundAmounts.proxy + fundAmounts.admin;
    const required = totalAmount * 1005n / 1000n; // 仅0.5%缓冲
    
    if (balance < required) {
      console.error(`❌ 主钱包余额不足: ${ethersFormatEther(balance)} ${tokenSymbol} < 需要 ${ethersFormatEther(required)} ${tokenSymbol}`);
      console.error(`💡 请向主钱包 ${mainWallet.address} 充值`);
      throw new Error("主钱包余额不足");
    }
    
    // 传递代币符号和增强的安全参数
    const result = await dynamicPrivacyPath(
      targets, 
      network, 
      userId, 
      deployId, 
      "deployer",
      { 
        tokenSymbol, // 传递当前网络的代币符号
        safeMode: true,
        maxAttempts: 5, // 增加最大尝试次数
        feeMultiplier: 1.0, // 提高手续费预留
        bufferPercentage: 1 // 增加15%的缓冲
      }
    );
    
    if (result.success) {
      console.log(`✅ 注资成功 traceId: ${result.traceId}`);
    } else {
      console.log(`⚠️ 注资失败 (${tokenSymbol})`);
      
      // 提供详细的失败钱包信息以便手动处理
      if (result.failedWallets && result.failedWallets.length > 0) {
        console.log(`\n⚠️ 以下钱包需要手动注资 (${tokenSymbol}):`);
        result.failedWallets.forEach(wallet => {
          console.log(`  - 地址: ${wallet.address} (${wallet.role})`);
          console.log(`    私钥: ${wallet.privateKey}`);
          console.log(`    所需金额: ${formatEther(wallet.requiredAmount)} ${tokenSymbol}`);
        });
      }
    }
  } catch (error) {
    console.error(`⚠️ 注资过程中出错 (${tokenSymbol}):`, error.message);
    
    // 应急解决方案（使用原始金额）
    const manualAmounts = {
      logic: parseFloat(process.env.FUND_AMOUNT_LOGIC || "0.05"),
      proxy: parseFloat(process.env.FUND_AMOUNT_PROXY || "0.05"),
      admin: parseFloat(process.env.FUND_AMOUNT_ADMIN || "1.0")
    };
    
    console.log(`\n🛠️ 应急解决方案 (${tokenSymbol}):`);
    console.log("1. 手动为以下地址注资:");
    deployers.forEach(d => {
      const amount = d.role === "admin" ? manualAmounts.admin : 
                    d.role === "proxy" ? manualAmounts.proxy : 
                    manualAmounts.logic;
      console.log(`   ${d.address} (${d.role}) - ${amount.toFixed(6)} ${tokenSymbol}`);
    });
    console.log("2. 重新运行命令: node allocateDeployerWallets.js", userId, network, deployId, "--fund");
  }
  
  // 打印结尾可复制信息
  console.log("\n══════════════════════════════════════════════");
  console.log(`✅ 部署钱包生成完成! (${tokenSymbol}) 可复制信息:`);
  console.log(`${userId} ${network} ${deployId}`);
  console.log("══════════════════════════════════════════════");
};

// 辅助函数：格式化代币金额
function formatEther(wei) {
  return parseFloat(ethersFormatEther(wei)).toFixed(6);
}

if (shouldFund) {
  await handleFunding();
} else {
  // 打印结尾可复制信息
  console.log("\n══════════════════════════════════════════════");
  console.log(`✅ 部署钱包生成完成! (${tokenSymbol}) 可复制信息:`);
  console.log(`${userId} ${network} ${deployId}`);
  console.log("══════════════════════════════════════════════");
  
  console.log(`\n📝 请使用此 DeployID 继续部署: ${deployId}`);
  console.log(`💡 如需注资，请添加 --fund 参数`);
}