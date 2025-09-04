// allocateTraderWallets.js - v2.1.2-FixEthers
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { Wallet, parseEther, JsonRpcProvider } from "ethers";
import { fileURLToPath } from "url";
import { dynamicPrivacyPath } from "../modules/mixer.js";
import { initRpcManager, getOptimalRpcProvider, getRpcProviderList } from "../config/rpcManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const userId = process.argv[2];
const network = process.argv[3];
const deployId = process.argv[4];
const countArgIndex = process.argv.indexOf("--count");
const count = countArgIndex !== -1 ? parseInt(process.argv[countArgIndex + 1]) : 5;
const shouldFund = process.argv.includes("--fund");

if (!userId || !network || !deployId) {
  console.error("❌ 用法: node allocateTraderWallets.js <userId> <network> <deployId> [--count N] [--fund]");
  process.exit(1);
}
// ✅ 关键修复：初始化RPC管理器
try {
  initRpcManager(userId);
  console.log('✅ RPC管理器初始化成功');
} catch (error) {
  console.error('❌ RPC管理器初始化失败:', error.message);
  process.exit(1);
}
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

// 获取当前网络的代币符号
const symbol = tokenSymbols[network] || "ETH";

// 打印格式化的用户信息
console.log("══════════════════════════════════════════════");
console.log(`[用户ID]         : ${userId}`);
console.log(`[网络]           : ${network} (${symbol})`);
console.log(`[部署ID]         : ${deployId}`);
console.log(`[钱包数量]       : ${count}`);
console.log("══════════════════════════════════════════════");

const walletDir = path.join(__dirname, "../wallets", userId, deployId);
const deployDir = path.join(__dirname, "../deployments", userId, network, deployId);
const envPath = path.join(__dirname, "../configs", userId, ".env");

dotenv.config({ path: envPath });

if (!fs.existsSync(walletDir)) fs.mkdirSync(walletDir, { recursive: true });
if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir, { recursive: true });

// 生成 trader 钱包
const traders = Array.from({ length: count }).map(() => {
  const w = Wallet.createRandom();
  return {
    address: w.address,
    privateKey: w.privateKey,
    createdAt: new Date().toISOString()
  };
});

fs.writeFileSync(path.join(walletDir, "trader_wallets.json"), JSON.stringify(traders, null, 2));

// 追加 whitelist
const whitelistPath = path.join(deployDir, "whitelist.json");
let whitelist = fs.existsSync(whitelistPath)
  ? JSON.parse(fs.readFileSync(whitelistPath, "utf8"))
  : [];
for (const w of traders) {
  if (!whitelist.includes(w.address)) whitelist.push(w.address);
}
fs.writeFileSync(whitelistPath, JSON.stringify(whitelist, null, 2));

console.log(`\n✅ Trader 钱包已生成 ${count} 个并写入 trader_wallets.json 和 whitelist.json`);

function splitRandomAmounts(totalEth, count, minEth) {
  const amounts = [];
  let remaining = totalEth;

  for (let i = 0; i < count; i++) {
    const maxForThis = remaining - minEth * (count - i - 1);
    const value = i === count - 1
      ? remaining
      : Math.max(minEth, Math.random() * (maxForThis - minEth) + minEth);

    const rounded = parseFloat(value.toFixed(6));
    amounts.push(rounded);
    remaining -= rounded;
  }

  return amounts;
}

// 打印结尾可复制信息
const printCompletionInfo = (success = true) => {
  console.log("\n══════════════════════════════════════════════");
  console.log(`${success ? "✅" : "⚠️"} 交易钱包生成${success ? "完成" : "失败"}! 可复制信息:`);
  console.log(`${userId} ${network} ${deployId}`);
  console.log("══════════════════════════════════════════════");
};

if (shouldFund) {
  const totalStr = process.env.TOTAL_TRADER_FUND_ETH || "0.3";
  const totalEth = parseFloat(totalStr);
  const minEth = 0.02;

  if (totalEth < minEth * count) {
    console.error(`\n❌ 总金额 ${totalEth} ${symbol} 不足以分配给 ${count} 个钱包（每个至少 ${minEth} ${symbol}）`);
    printCompletionInfo(false);
    process.exit(1);
  }

  const ethList = splitRandomAmounts(totalEth, count, minEth);

  const targets = traders.map((w, i) => ({
    address: w.address,
    amount: parseEther(ethList[i].toString())
  }));

  const run = async () => {
    try {
      console.log(`\n💰 为 ${count} 个 trader 钱包注资总计 ${totalEth} ${symbol}（随机拆分）...`);
      
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
      
      // 正确计算2%缓冲（BigInt不能使用小数）
      const totalAmount = parseEther(totalEth.toString());
      const required = totalAmount * 102n / 100n; // 增加2%缓冲
      
      if (balance < required) {
        console.error(`❌ 主钱包余额不足: ${ethersFormatEther(balance)} ${symbol} < 需要 ${ethersFormatEther(required)} ${symbol}`);
        console.error(`💡 请向主钱包 ${mainWallet.address} 充值`);
        printCompletionInfo(false);
        return;
      }
      
      const result = await dynamicPrivacyPath(targets, network, userId, deployId, "trader");
      if (result.success) {
        console.log(`✅ Trader 注资成功 traceId: ${result.traceId}`);
      } else {
        console.log("⚠️ Trader 注资失败");
      }
    } catch (error) {
      console.error("⚠️ 注资过程中出错:", error.message);
      
      // 应急解决方案
      console.log("\n🛠️ 应急解决方案:");
      console.log("1. 手动为以下地址注资:");
      traders.forEach((trader, i) => {
        console.log(`   ${trader.address} - ${ethList[i].toFixed(6)} ${symbol}`);
      });
      console.log("2. 重新运行命令: node allocateTraderWallets.js", userId, network, deployId, "--fund");
    } finally {
      printCompletionInfo();
    }
  };
  
  run();
} else {
  printCompletionInfo();
}