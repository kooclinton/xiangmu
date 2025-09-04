// collectAllFunds.js - v15.4.0-RPC-Stability-Fix
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers, Wallet, JsonRpcProvider, formatEther, parseEther, parseUnits, Interface } from "ethers";
import { initRpcManager, getOptimalRpcProvider, getRpcProviderList, getRpcProvider } from "../config/rpcManager.js";
import { getDexConfig } from "../config/dexConfig.js";
import { safeSendRaw } from "../modules/mixer.js"; // 导入安全发送函数

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === 参数提取：必须传 userId network deployId ===
const userId = process.argv[2];
const network = process.argv[3];
const deployId = process.argv[4];

if (!userId || !network || !deployId) {
  console.error("用法: node collectAllFunds.js <userId> <network> <deployId>");
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

// 网络到代币符号映射
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
  sepolia: "ETH"
};

// 获取当前网络的代币符号
const symbol = tokenSymbols[network] || "ETH";

// 打印格式化的用户信息
console.log("══════════════════════════════════════════════");
console.log(`[用户ID]         : ${userId}`);
console.log(`[网络]           : ${network} (${symbol})`);
console.log(`[部署ID]         : ${deployId}`);
console.log("══════════════════════════════════════════════");

// === 加载专属 env ===
const envPath = path.join(__dirname, "../configs", userId, ".env");
if (!fs.existsSync(envPath)) {
  console.error(`❌ 找不到 env 文件: ${envPath}`);
  process.exit(1);
}

// 强制只加载用户专属 env 文件
const envResult = dotenv.config({ 
  path: envPath,
  override: true
});

if (envResult.error) {
  console.error(`❌ 解析env文件失败: ${envResult.error}`);
  process.exit(1);
}

const userEnv = envResult.parsed || {};
const COLLECTOR_ADDRESS = userEnv.COLLECTOR_ADDRESS;

if (!COLLECTOR_ADDRESS) {
  console.error('❌ .env 缺少 COLLECTOR_ADDRESS（主钱包地址）');
  process.exit(1);
}

// === 路径定义 ===
const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments", userId, network, deployId);
const WALLETS_DIR = path.join(__dirname, "../wallets", userId, deployId);
const DEPLOYERS_FILE = path.join(WALLETS_DIR, "deployers.json");
const TRADER_WALLETS_FILE = path.join(WALLETS_DIR, "trader_wallets.json"); // 新增trader钱包文件路径

// ========== 第一部分：移除LP并归集ETH到 admin 钱包 ==========

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// 加载 meta 信息（修改为可选）
function loadMeta() {
  const metaPath = path.join(DEPLOYMENTS_DIR, ".meta.json");
  if (!fs.existsSync(metaPath)) {
    log(`⚠️ 找不到meta文件: ${metaPath}，跳过LP移除操作`);
    return null;
  }
  return JSON.parse(fs.readFileSync(metaPath, "utf8"));
}

// 加载 deployers 钱包
function loadDeployerWallet(role) {
  if (!fs.existsSync(DEPLOYERS_FILE)) throw new Error(`找不到钱包文件: ${DEPLOYERS_FILE}`);
  const wallets = JSON.parse(fs.readFileSync(DEPLOYERS_FILE, "utf8"));
  const wallet = wallets.find(w => w.role === role);
  if (!wallet) throw new Error(`未找到 ${role} 角色钱包`);
  return wallet;
}

// 获取移除流动性所需的ABI
function getRouterABI() {
  return [
    "function removeLiquidityETH(address token, uint liquidity, uint amountTokenMin, uint amountETHMin, address to, uint deadline) external returns (uint amountToken, uint amountETH)",
    "function getAmountsOut(uint amountIn, address[] memory path) external view returns (uint[] memory amounts)"
  ];
}

// === LP归集
async function removeLiquidityETH(
  adminSigner,
  lpToken,
  lpBalance,
  routerAddress,
  tokenAddress,
  wethAddress
) {
  log(`🔄 开始移除流动性...`);

  // Router合约
  const routerABI = getRouterABI();
  const routerContract = new ethers.Contract(routerAddress, routerABI, adminSigner);

  // LP合约
  const lpABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)"
  ];
  const lpContract = new ethers.Contract(lpToken, lpABI, adminSigner);

  // 授权Router操作LP代币
  log(`🔒 授权Router操作LP代币...`);
  const approveLpTx = await lpContract.approve(routerAddress, lpBalance);
  await approveLpTx.wait();

  // 检查授权
  const allowance = await lpContract.allowance(adminSigner.address, routerAddress);
  if (allowance < lpBalance) {
    throw new Error(`❌ 授权失败！预期: ${lpBalance}，实际: ${allowance}`);
  }
  log(`✅ 授权成功，额度: ${ethers.formatUnits(allowance, 18)} LP`);

  // 移除流动性
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  log(`ℹ️ 获取输出量估算... 路径: ${tokenAddress} -> ${wethAddress}`);
  let minTokenAmount = 0n, minETHAmount = 0n;
  try {
    const amountsOut = await routerContract.getAmountsOut(lpBalance, [
      tokenAddress,
      wethAddress
    ]);
    minTokenAmount = amountsOut[0] > 0 ? amountsOut[0] * 90n / 100n : 0n;
    minETHAmount = amountsOut[1] > 0 ? amountsOut[1] * 90n / 100n : 0n;

    log(`ℹ️ 预估输出: ${ethers.formatUnits(amountsOut[0], 18)} 代币 + ${ethers.formatEther(amountsOut[1])} ${symbol}`);
    log(`ℹ️ 最小接受: ${ethers.formatUnits(minTokenAmount, 18)} 代币 + ${ethers.formatEther(minETHAmount)} ${symbol}`);
  } catch (error) {
    throw new Error(`getAmountsOut 调用失败: ${error.reason || error.message}`);
  }

  log(`🔥 移除流动性并提取${symbol}...`);
  const removeTx = await routerContract.removeLiquidityETH(
    tokenAddress,
    lpBalance,
    minTokenAmount,
    minETHAmount,
    adminSigner.address,
    deadline
  );
  const removeReceipt = await removeTx.wait();
  log(`✅ 流动性移除成功: ${removeReceipt.hash}`);
  return removeReceipt;
}

// ========== 第二部分：回收所有deployer钱包ETH到主钱包 ==========

const SAFE_BUFFER = parseEther("0.0001"); // 增加安全缓冲金额 (0.0001 ETH)

function explorerLink(network, txHash) {
  const explorers = {
    base: "https://basescan.org/tx/",
    sepolia: "https://sepolia.etherscan.io/tx/",
    mainnet: "https://etherscan.io/tx/",
    polygon: "https://polygonscan.com/tx/",
    arbitrum: "https://arbiscan.io/tx/",
    optimism: "https://optimistic.etherscan.io/tx/",
    bsc: "https://bscscan.com/tx/",
    bsc_testnet: "https://testnet.bscscan.com/tx/"
  };
  
  return explorers[network] ? `${explorers[network]}${txHash}` : `https://${network}.etherscan.io/tx/${txHash}`;
}

// === 主函数
async function main() {
  try {
    log(`=== 【流动性LP归集 & deployer钱包${symbol}归集】 ===`);
    log(`用户ID: ${userId} 网络: ${network} 部署ID: ${deployId}`);

    // === 加载配置
    let meta = null;
    let dex = null;
    let lpToken = null;
    let proxyAddress = null;
    let adminAddress = null; // 新增：admin合约地址
    let receipt = null;
    let adminWallet = null;
    let adminSigner = null;
    let lpBalance = 0n;
    
    // 新增：统计变量
    let totalCollected = 0;
    let totalCount = 0;
    let failCount = 0;
    let adminContractCollected = 0; // 从Admin合约归集的金额

    // === 使用最优RPC Provider ===
    let provider;
    try {
      log(`🔗 获取最优RPC节点...`);
      provider = await getOptimalRpcProvider(network);
      
      // 安全获取URL
      let providerUrl = "未知";
      try {
        providerUrl = provider.connection?.url || provider._getConnection?.().url || "未知";
      } catch (e) {
        providerUrl = "无法获取URL";
      }
      
      log(`✅ 使用最优RPC节点: ${providerUrl}`);
    } catch (rpcError) {
      console.error(`❌ 无法获取最优RPC节点: ${rpcError.message}`);
      
      // 回退方案：使用安全模式获取RPC节点
      log(`⚠️ 尝试使用安全模式获取RPC节点`);
      try {
        provider = getRpcProvider(network);
        log(`✅ 使用安全模式RPC节点`);
      } catch (fallbackError) {
        console.error(`❌ 安全模式获取RPC节点失败: ${fallbackError.message}`);
        throw new Error("无法获取RPC提供者");
      }
    }

    try {
      meta = loadMeta();
      if (meta) {
        dex = getDexConfig(network);
        lpToken = meta.lpToken;
        proxyAddress = meta.proxyAddress || meta.proxy;
        adminAddress = meta.adminAddress; // 新增：获取admin合约地址
      }
    } catch (metaError) {
      log(`⚠️ 加载meta信息失败: ${metaError.message}`);
    }

    // === 归集LP：移除流动性（如有LP，否则跳过）
    if (meta && lpToken) {
      try {
        // === 管理员钱包
        adminWallet = loadDeployerWallet("admin");
        adminSigner = new Wallet(adminWallet.privateKey, provider);

        // 检查LP余额
        if (lpToken !== ethers.ZeroAddress) {
          const lpABI = ["function balanceOf(address owner) view returns (uint256)"];
          const lpContract = new ethers.Contract(lpToken, lpABI, provider);
          lpBalance = await lpContract.balanceOf(adminWallet.address);
        }

        log(`ℹ️ 管理员钱包: ${adminWallet.address}`);
        log(`ℹ️ Proxy地址: ${proxyAddress}`);
        log(`ℹ️ Admin合约地址: ${adminAddress || "未设置"}`); // 新增：显示admin合约地址
        log(`ℹ️ LP地址: ${lpToken || "未设置"}`);
        log(`ℹ️ LP余额: ${ethers.formatUnits(lpBalance, 18)}`);
        log(`ℹ️ 路由器地址: ${dex.router}`);
        log(`ℹ️ WETH地址: ${dex.weth}`);

        if (lpBalance > 0n) {
          receipt = await removeLiquidityETH(
            adminSigner,
            lpToken,
            lpBalance,
            dex.router,
            proxyAddress,
            dex.weth
          );
          log(`💧 LP流动性已移除, 交易哈希: ${explorerLink(network, receipt.hash)}`);
        } else {
          log(`⚠️ 管理员钱包中无 LP 可归集`);
        }

        const ethBalance = await provider.getBalance(adminWallet.address);
        log(`💰 管理员钱包${symbol}余额: ${ethers.formatEther(ethBalance)}`);
      } catch (lpError) {
        log(`❌ LP移除失败: ${lpError.message}`);
      }
    } else {
      log(`⚠️ 未找到meta文件或缺少lpToken字段，跳过LP流动性归集`);
    }

    // === 新增：归集admin合约地址资金 ===
    if (adminAddress && adminAddress !== ethers.ZeroAddress) {
      try {
        log(`🔄 开始归集admin合约地址资金...`);
        
        // 加载admin钱包用于发送交易
        if (!adminWallet) {
          adminWallet = loadDeployerWallet("admin");
          adminSigner = new Wallet(adminWallet.privateKey, provider);
        }

        // 使用Admin合约中实际存在的函数来提取资金
        const contractABI = [
          "function withdrawAll(address lpToken, address to) external",
          "function terminateAndCollect(address lpToken, address to) external",
          "function executeCall(address target, uint256 value, bytes memory data) external returns (bytes memory)"
        ];
        const adminContract = new ethers.Contract(adminAddress, contractABI, adminSigner);
        
        // === 提取Admin合约中的BNB ===
        const adminContractBalance = await provider.getBalance(adminAddress);
        log(`ℹ️ Admin合约${symbol}余额: ${ethers.formatEther(adminContractBalance)}`);

        if (adminContractBalance > 0n) {
          // 记录提取前的余额
          const balanceBefore = parseFloat(ethers.formatEther(adminContractBalance));
          
          // 尝试使用executeCall函数提取BNB
          try {
            log(`🔄 尝试提取Admin合约中的${symbol}...`);
            
            const bnbTx = await adminContract.executeCall(
              COLLECTOR_ADDRESS,   // 目标地址
              adminContractBalance, // 转账金额
              "0x"                 // 空数据
            );
            
            const bnbReceipt = await bnbTx.wait();
            log(`✅ Admin合约${symbol}提取成功: ${explorerLink(network, bnbReceipt.hash)}`);
            
            // 检查提取后的余额
            const newBalance = await provider.getBalance(adminAddress);
            log(`ℹ️ Admin合约提取后${symbol}余额: ${ethers.formatEther(newBalance)}`);
            
            // 计算并记录提取的金额
            const balanceAfter = parseFloat(ethers.formatEther(newBalance));
            const collectedAmount = balanceBefore - balanceAfter;
            adminContractCollected += collectedAmount;
            log(`💰 从Admin合约归集了 ${collectedAmount.toFixed(6)} ${symbol}`);
            
          } catch (bnbError) {
            log(`❌ ${symbol}提取失败: ${bnbError.message}`);
            
            // 如果executeCall失败，尝试使用terminateAndCollect
            try {
              log(`🔄 尝试使用terminateAndCollect函数提取${symbol}...`);
              const terminateTx = await adminContract.terminateAndCollect(
                ethers.ZeroAddress, // lpToken参数
                COLLECTOR_ADDRESS   // 收款地址
              );
              const terminateReceipt = await terminateTx.wait();
              log(`✅ Admin合约${symbol}通过terminateAndCollect提取成功: ${explorerLink(network, terminateReceipt.hash)}`);
              
              // 检查提取后的余额
              const newBalance = await provider.getBalance(adminAddress);
              log(`ℹ️ Admin合约提取后${symbol}余额: ${ethers.formatEther(newBalance)}`);
              
              // 计算并记录提取的金额
              const balanceAfter = parseFloat(ethers.formatEther(newBalance));
              const collectedAmount = balanceBefore - balanceAfter;
              adminContractCollected += collectedAmount;
              log(`💰 从Admin合约归集了 ${collectedAmount.toFixed(6)} ${symbol}`);
            } catch (terminateError) {
              log(`❌ terminateAndCollect函数提取${symbol}失败: ${terminateError.message}`);
            }
          }
        } else {
          log(`⚠️ Admin合约${symbol}余额为0，跳过提取`);
        }
      } catch (adminError) {
        log(`❌ 归集Admin合约资金失败: ${adminError.message}`);
      }
    } else {
      log(`⚠️ 未找到admin合约地址，跳过Admin合约资金归集`);
    }

    // === 归集所有 deployer 钱包${symbol}到主钱包（COLLECTOR_ADDRESS）
    if (!fs.existsSync(DEPLOYERS_FILE)) {
      log(`⚠️ 找不到 deployers 钱包文件: ${DEPLOYERS_FILE}`);
      process.exit(1);
    }
    
    const deployerList = JSON.parse(fs.readFileSync(DEPLOYERS_FILE, 'utf-8'));
    if (!Array.isArray(deployerList)) throw new Error('deployer 钱包不是数组格式');

    log(`📦 开始归集 deployer 钱包（专属 deployId 路径），共 ${deployerList.length} 个地址`);
    const txDetails = [];

    for (const walletData of deployerList) {
      const { role, address, privateKey } = walletData;
      const wallet = new Wallet(privateKey, provider);
      const balance = await provider.getBalance(address);
      const balanceETH = parseFloat(formatEther(balance));

      // 检查余额是否足够覆盖安全缓冲
      if (balance < SAFE_BUFFER) {
        log(`⚠️ ${role} ${address} 余额过低，跳过 (${balanceETH.toFixed(6)} ${symbol})`);
        txDetails.push({ role, address, amount: '0', txHash: '-', block: '-', fail: true, reason: '余额过低' });
        continue;
      }

      // 计算转账金额（保留安全缓冲）
      const valueToSend = balance - SAFE_BUFFER;
      try {
        // 使用安全发送函数（带RPC轮询和重试机制）
        const tx = await safeSendRaw(wallet, COLLECTOR_ADDRESS, valueToSend, network);
        const amount = parseFloat(formatEther(valueToSend));
        log(`✅ ${role} ${address} 已发送 ${amount.toFixed(6)} ${symbol}`);
        log(`   ↪️ 交易哈希: ${explorerLink(network, tx.hash)}`);
        txDetails.push({ 
          role, 
          address, 
          amount: amount.toFixed(6), 
          txHash: tx.hash, 
          block: tx.blockNumber || '-' 
        });
        totalCollected += amount;
        totalCount += 1;
      } catch (err) {
        const errorMsg = err.message || err.toString();
        log(`❌ ${role} ${address} 归集失败: ${errorMsg}`);
        txDetails.push({ 
          role, 
          address, 
          amount: '0', 
          txHash: '-', 
          block: '-', 
          fail: true, 
          reason: errorMsg.slice(0, 100) 
        });
        failCount += 1;
      }
    }

    // === 新增：归集 trader 钱包 ===
    let traderList = [];
    if (fs.existsSync(TRADER_WALLETS_FILE)) {
      try {
        traderList = JSON.parse(fs.readFileSync(TRADER_WALLETS_FILE, 'utf-8'));
        if (!Array.isArray(traderList)) {
          log(`❌ trader_wallets.json 格式错误，应为数组`);
        } else {
          log(`📦 开始归集 trader 钱包，共 ${traderList.length} 个地址`);
          
          for (const walletData of traderList) {
            const { address, privateKey } = walletData;
            const role = 'trader'; // 固定角色为trader
            const wallet = new Wallet(privateKey, provider);
            const balance = await provider.getBalance(address);
            const balanceETH = parseFloat(formatEther(balance));

            if (balance < SAFE_BUFFER) {
              log(`⚠️ ${role} ${address} 余额过低，跳过 (${balanceETH.toFixed(6)} ${symbol})`);
              txDetails.push({ role, address, amount: '0', txHash: '-', block: '-', fail: true, reason: '余额过低' });
              continue;
            }

            const valueToSend = balance - SAFE_BUFFER;
            try {
              const tx = await safeSendRaw(wallet, COLLECTOR_ADDRESS, valueToSend, network);
              const amount = parseFloat(formatEther(valueToSend));
              log(`✅ ${role} ${address} 已发送 ${amount.toFixed(6)} ${symbol}`);
              log(`   ↪️ 交易哈希: ${explorerLink(network, tx.hash)}`);
              txDetails.push({ 
                role, 
                address, 
                amount: amount.toFixed(6), 
                txHash: tx.hash, 
                block: tx.blockNumber || '-' 
              });
              totalCollected += amount;
              totalCount += 1;
            } catch (err) {
              const errorMsg = err.message || err.toString();
              log(`❌ ${role} ${address} 归集失败: ${errorMsg}`);
              txDetails.push({ 
                role, 
                address, 
                amount: '0', 
                txHash: '-', 
                block: '-', 
                fail: true, 
                reason: errorMsg.slice(0, 100) 
              });
              failCount += 1;
            }
          }
        }
      } catch (err) {
        log(`❌ 读取或处理 trader_wallets.json 失败: ${err.message}`);
      }
    } else {
      log(`⚠️ 找不到 trader 钱包文件: ${TRADER_WALLETS_FILE}，跳过`);
    }

    // 计算总钱包数（包括deployer和trader）
    const totalWallets = deployerList.length + traderList.length;
    
    // 添加从Admin合约归集的金额到总归集
    totalCollected += adminContractCollected;

    // 打印归集总结
    console.log("\n══════════════════════════════════════════════");
    console.log("✅ 归集操作完成");
    console.log("══════════════════════════════════════════════");
    console.log(`总钱包数: ${totalWallets}`);
    console.log(`成功归集: ${totalCount} 个钱包`);
    console.log(`失败归集: ${failCount} 个钱包`);
    
    // 显示从Admin合约归集的金额（如果有）
    if (adminContractCollected > 0) {
      console.log(`从Admin合约归集: ${adminContractCollected.toFixed(6)} ${symbol}`);
    }
    
    console.log(`总归集${symbol}: ${totalCollected.toFixed(6)}`);
    console.log(`收款地址: ${COLLECTOR_ADDRESS}`);
    console.log("══════════════════════════════════════════════");
    
    // 打印可复制信息
    console.log("\n══════════════════════════════════════════════");
    console.log("✅ 归集完成! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");

    log('\n🎯 所有钱包归集任务完成。');
  } catch (error) {
    console.error("❌ 归集过程中发生错误:", error);
    
    // 打印可复制信息（失败时）
    console.log("\n══════════════════════════════════════════════");
    console.log("❌ 归集失败! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");
    
    process.exit(1);
  }
}

main();