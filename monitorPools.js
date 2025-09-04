// monitorPools.js - v1.3.5-enhancedRateLimitProtection
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { ethers, JsonRpcProvider, Contract, formatEther } from "ethers";
import { 
  sendTelegramMessage, 
  escapeMarkdown,
  sendLpPoolAlert,
  sendLpPoolSummary,
  sendMonitorError,
  sendExternalBuyAlert
} from "../utils/telegram.js";
import { getDexConfig } from "../config/dexConfig.js";

// === 参数校验: 必须传 userId network deployId ===
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const userId = process.argv[2];
const network = process.argv[3];
const deployId = process.argv[4];

if (!userId || !network || !deployId) {
  console.error("❌ 用法: node monitorPools.js <userId> <network> <deployId> [intervalSec]");
  process.exit(1);
}

const envPath = path.resolve(__dirname, `../configs/${userId}/.env`);
if (!fs.existsSync(envPath)) {
  console.error(`❌ 找不到专属env: ${envPath}`);
  process.exit(1);
}
dotenv.config({ path: envPath });

const INTERVAL_SEC = Number(process.argv[5]) || Number(process.env.POOL_MONITOR_INTERVAL_SEC) || 60;
const MIN_ETH_ALERT = Number(process.env.MIN_ETH_ALERT || 0.01);
const MIN_TOKEN_ALERT = Number(process.env.MIN_TOKEN_ALERT || 1);
const MIN_LP_ALERT = Number(process.env.MIN_LP_ALERT || 0.1);
const MIN_BUY_ALERT = MIN_TOKEN_ALERT; // 使用相同的阈值

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const hasTelegram = TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID;

console.log(`🌐 监控网络: ${network}`);
console.log(`🆔 任务用户: ${userId} 任务: ${deployId}`);
console.log(`⏱️ 监测间隔: ${INTERVAL_SEC}s`);
console.log(`📡 Telegram通知: ${hasTelegram ? '已启用' : '未配置'}`);
console.log(`🔐 Telegram配置: BOT_TOKEN=${TELEGRAM_BOT_TOKEN ? '已设置' : '未设置'}, CHAT_ID=${TELEGRAM_CHAT_ID ? '已设置' : '未设置'}`);

const deploymentDir = path.join(__dirname, `../deployments/${userId}/${network}/${deployId}`);

// 买家累计购买金额跟踪器
const buyerAccumulatedBuys = {};

// 更新买家累计购买金额
function updateBuyerAccumulated(tokenAddress, buyerAddress, amount) {
  const tokenKey = tokenAddress.toLowerCase();
  const buyerKey = buyerAddress.toLowerCase();
  
  if (!buyerAccumulatedBuys[tokenKey]) {
    buyerAccumulatedBuys[tokenKey] = {};
  }
  
  if (!buyerAccumulatedBuys[tokenKey][buyerKey]) {
    buyerAccumulatedBuys[tokenKey][buyerKey] = 0;
  }
  
  buyerAccumulatedBuys[tokenKey][buyerKey] += amount;
  return buyerAccumulatedBuys[tokenKey][buyerKey];
}

// 加载交易者白名单函数
function loadTraderWallets() {
  const walletPath = path.resolve(__dirname, `../wallets/${userId}/${deployId}/trader_wallets.json`);
  const exemptAddresses = new Set();
  
  if (fs.existsSync(walletPath)) {
    try {
      const wallets = JSON.parse(fs.readFileSync(walletPath, 'utf8'));
      
      // 从钱包对象中提取地址
      wallets.forEach(wallet => {
        if (wallet.address) {
          exemptAddresses.add(wallet.address.toLowerCase());
        }
      });
      
      console.log(`✅ 加载 ${exemptAddresses.size} 个白名单交易者地址`);
    } catch (e) {
      console.error(`❌ 加载交易者钱包失败: ${e.message}`);
    }
  } else {
    console.log('ℹ️ 未找到 trader_wallets.json，将监控所有买入行为');
  }
  return exemptAddresses;
}

function loadDeployments() {
  const metaPath = path.join(deploymentDir, ".meta.json");

  if (!fs.existsSync(metaPath)) {
    throw new Error(`❌ 找不到部署文件: ${metaPath}`);
  }

  try {
    const rawData = fs.readFileSync(metaPath, "utf8");
    const parsedData = JSON.parse(rawData);
    const deployments = Array.isArray(parsedData) ? parsedData : [parsedData];
    console.log(`📝 [${deployId}] [${network}] 成功加载 ${deployments.length} 个部署项`);
    
    // 为每个部署项添加tokenAddress字段（使用proxyAddress）
    deployments.forEach(dep => {
      if (!dep.tokenAddress) {
        dep.tokenAddress = dep.proxyAddress;
        console.log(`ℹ️ 使用代理地址作为代币地址: ${dep.proxyAddress}`);
      }
    });
    
    return deployments;
  } catch (e) {
    throw new Error(`❌ 解析部署文件失败: ${e.message}`);
  }
}

const lpAbi = [
  "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function totalSupply() external view returns (uint256)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)" // 添加Swap事件
];

// 代币ABI包含Transfer事件
const erc20Abi = [
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)"
];

const fundTrackers = {};

// 添加lastBlock字段
function initFundTracker(lpAddr) {
  if (!fundTrackers[lpAddr]) {
    fundTrackers[lpAddr] = {
      reserve0: 0,
      reserve1: 0,
      totalSupply: 0,
      lastCheck: 0,
      lastBlock: 0  // 新增最后检查区块
    };
  }
}

async function getTokenSymbol(tokenAddress, provider) {
  if (tokenAddress === ethers.ZeroAddress) return "ETH";
  try {
    const token = new Contract(tokenAddress, erc20Abi, provider);
    return await token.symbol();
  } catch (e) {
    console.error(`⚠️ 获取代币符号失败: ${e.message}`);
    return "UNKNOWN";
  }
}

function formatNumber(value, decimals = 6) {
  if (typeof value !== 'number') return 'N/A';
  return value.toFixed(decimals);
}

async function testRpcConnection(provider) {
  try {
    const blockNumber = await provider.getBlockNumber();
    console.log(`✅ RPC 连接成功 | 最新区块: ${blockNumber}`);
    return true;
  } catch (e) {
    console.error(`❌ RPC 连接失败: ${e.message}`);
    if (hasTelegram) {
      try {
        await sendTelegramMessage(
          `⚠️ *RPC 连接失败* \\n` +
          `📌 网络: ${escapeMarkdown(network)} \\n` +
          `🔗 RPC: ${escapeMarkdown(provider.connection.url)} \\n` +
          `🕒 ${new Date().toLocaleString()}`
        );
      } catch (tgErr) {
        console.error(`[TG] 错误通知发送失败: ${tgErr.message}`);
      }
    }
    return false;
  }
}

// 获取交易详情并分析支付金额
async function getBuyAmountDetails(provider, txHash, tokenAddress, tokenAmount, lpAddress) {
  try {
    // 获取交易收据
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
      console.error(`⚠️ 无法获取交易收据: ${txHash}`);
      return null;
    }
    
    // 获取LP合约实例
    const lpContract = new Contract(lpAddress, lpAbi, provider);
    const token0 = await lpContract.token0();
    const token1 = await lpContract.token1();
    
    // 确定代币在LP池中的位置
    const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
    const baseToken = isToken0 ? token1 : token0;
    const baseSymbol = await getTokenSymbol(baseToken, provider);
    
    // 解析Swap事件
    for (const log of receipt.logs) {
      try {
        // 确保日志来自LP池
        if (log.address.toLowerCase() === lpAddress.toLowerCase()) {
          const parsedLog = lpContract.interface.parseLog(log);
          if (parsedLog && parsedLog.name === "Swap") {
            const { amount0In, amount1In, amount0Out, amount1Out, to } = parsedLog.args;
            
            // 检查是否是我们关注的代币交易
            const receivedAmount = isToken0 ? 
              (amount0Out > 0 ? Number(formatEther(amount0Out)) : 0) :
              (amount1Out > 0 ? Number(formatEther(amount1Out)) : 0);
            
            // 检查收到的代币数量是否匹配
            if (Math.abs(receivedAmount - tokenAmount) < 0.01) {
              const paidAmount = isToken0 ? 
                Number(formatEther(amount1In)) : 
                Number(formatEther(amount0In));
              
              return {
                paidAmount,
                baseSymbol,
                baseToken
              };
            }
          }
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
    
    console.warn(`⚠️ 未找到匹配的Swap事件: ${txHash}`);
    return null;
  } catch (e) {
    console.error(`⚠️ 分析交易失败: ${e.message}`);
    return null;
  }
}

// 监控代币转账函数（增强版速率限制保护）
async function monitorTokenTransfers(provider, dep, exemptAddresses, externalBuyFlags) {
  if (!dep.tokenAddress || !dep.lpAddress) {
    console.log(`⚠️ [${dep.name}] 缺少代币或LP地址，跳过监控`);
    return;
  }
  
  const tokenContract = new Contract(dep.tokenAddress, erc20Abi, provider);
  const tracker = fundTrackers[dep.lpAddress] || {};
  const currentBlock = await provider.getBlockNumber();
  
  // 1. 大幅减少查询范围（从500减少到100个区块）
  const fromBlock = Math.max(tracker.lastBlock || 0, currentBlock - 100);
  
  try {
    // 2. 增加请求前的延迟（3秒）
    console.log(`⏳ [${dep.symbol}] 等待3秒后进行转账事件查询...`);
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 3. 增强重试机制（5次重试，指数退避）
    let transferEvents = [];
    let retryCount = 0;
    const maxRetries = 5;
    
    while (retryCount < maxRetries) {
      try {
        console.log(`🔍 [${dep.symbol}] 查询转账事件 [区块 ${fromBlock} 到 ${currentBlock}] 尝试 #${retryCount + 1}`);
        transferEvents = await tokenContract.queryFilter(
          tokenContract.filters.Transfer(),
          fromBlock,
          currentBlock
        );
        console.log(`✅ [${dep.symbol}] 获取到 ${transferEvents.length} 个转账事件`);
        break; // 成功则跳出循环
      } catch (e) {
        // 检测各种可能的速率限制错误
        const isRateLimitError = e.message.includes("rate limit") || 
                               e.message.includes("exceeded") || 
                               e.message.includes("too many requests") ||
                               e.message.includes("timeout") ||
                               (e.info && e.info.error && e.info.error.message && 
                                (e.info.error.message.includes("rate limit") || 
                                 e.info.error.message.includes("exceeded") || 
                                 e.info.error.message.includes("too many requests")));
        
        if (isRateLimitError && retryCount < maxRetries) {
          // 使用更强的指数退避策略（3的指数）
          const delay = Math.pow(3, retryCount) * 1000; // 3^0=1秒, 3^1=3秒, 3^2=9秒, 3^3=27秒, 3^4=81秒
          console.warn(`⚠️ [${dep.symbol}] RPC限速，${delay/1000}秒后重试 (${retryCount+1}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          retryCount++;
        } else {
          // 4. 添加更详细的错误日志
          console.error(`❌ [${dep.symbol}] 获取转账事件失败: ${e.message}`);
          if (e.info) {
            console.error("错误详情:", JSON.stringify(e.info, null, 2));
          }
          throw e;
        }
      }
    }
    
    // 处理转账事件
    for (const event of transferEvents) {
      const { from, to, value } = event.args;
      const amount = Number(formatEther(value));
      const fromAddr = from.toLowerCase();
      const toAddr = to.toLowerCase();
      
      // 排除豁免地址的交易
      const isExemptFrom = exemptAddresses.has(fromAddr);
      const isExemptTo = exemptAddresses.has(toAddr);
      
      if (from !== ethers.ZeroAddress &&   // 排除铸币交易
          !isExemptFrom &&                 // 排除豁免地址卖出
          !isExemptTo &&                   // 排除豁免地址买入
          amount >= MIN_BUY_ALERT) {       // 超过最小警报阈值
        
        console.log(`🚨 [${dep.symbol}] 检测到外部买入: ${to} 买入 ${amount} ${dep.symbol}`);
        
        // 标记该池子有外部买入（用于后续通知）
        externalBuyFlags[dep.lpAddress] = true;
        
        // 更新买家累计购买金额
        const accumulatedAmount = updateBuyerAccumulated(dep.tokenAddress, to, amount);
        
        if (hasTelegram) {
          const dexConfig = getDexConfig(network);
          let buyDetails = null;
          
          try {
            // 获取交易详情和支付金额
            buyDetails = await getBuyAmountDetails(
              provider,
              event.transactionHash,
              dep.tokenAddress,
              amount,
              dep.lpAddress
            );
          } catch (e) {
            console.error(`⚠️ 获取购买详情失败: ${e.message}`);
          }
          
          await sendExternalBuyAlert({
            network,
            deployId,
            tokenSymbol: dep.symbol,
            tokenAddress: dep.tokenAddress,
            from,
            to,
            amount,
            accumulatedAmount, // 添加累计购入金额
            txHash: event.transactionHash,
            explorerUrl: dexConfig.explorerUrl,
            paidAmount: buyDetails?.paidAmount || 0,
            baseSymbol: buyDetails?.baseSymbol || "UNKNOWN"
          });
        }
      }
    }
  } catch (e) {
    console.error(`⚠️ [${dep.symbol}] 转账事件监控失败: ${e.message}`);
  }
  
  // 更新最后检查区块
  tracker.lastBlock = currentBlock;
}

async function monitorPool() {
  try {
    const deployments = loadDeployments();
    const dexConfig = getDexConfig(network);
    const provider = new JsonRpcProvider(dexConfig.rpcUrl, dexConfig.chainId);
    
    // 加载白名单地址
    const exemptAddresses = loadTraderWallets();

    // 测试RPC连接
    const isConnected = await testRpcConnection(provider);
    if (!isConnected) {
      console.error(`❌ [${deployId}] RPC连接失败，跳过本次监控`);
      return;
    }

    let anyChange = false;
    let summaryRows = [];
    // 新增：记录哪些池子有外部买入
    const externalBuyFlags = {};

    for (const dep of deployments) {
      const lpAddr = dep.lpToken || dep.lp || dep.lpAddress || null;
      if (!lpAddr) {
        console.log(`⚠️ [${deployId}] [${network}] 部署项 ${dep.name || '未命名'} 缺少LP地址，跳过`);
        continue;
      }
      
      // 确保LP地址在部署对象中
      dep.lpAddress = lpAddr;
      
      initFundTracker(lpAddr);
      const tracker = fundTrackers[lpAddr];
      const lpContract = new Contract(lpAddr, lpAbi, provider);

      let reserves, token0Symbol, token1Symbol;
      try {
        // 5. 添加对LP池查询的延迟
        console.log(`⏳ [${dep.symbol}] 等待1秒后查询LP池数据...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        reserves = await lpContract.getReserves();
        const token0 = await lpContract.token0();
        const token1 = await lpContract.token1();
        token0Symbol = await getTokenSymbol(token0, provider);
        token1Symbol = await getTokenSymbol(token1, provider);
        const totalSupply = await lpContract.totalSupply();
        tracker.totalSupply = Number(formatEther(totalSupply));
      } catch (e) {
        console.error(`⚠️ [${deployId}] [${network}] 查询LP池数据失败: ${e.message}`);
        continue;
      }

      const reserve0 = Number(formatEther(reserves[0]));
      const reserve1 = Number(formatEther(reserves[1]));
      const reserve0Change = reserve0 - tracker.reserve0;
      const reserve1Change = reserve1 - tracker.reserve1;

      const hasChange = Math.abs(reserve0Change) > 0.000001 || 
                        Math.abs(reserve1Change) > 0.000001;

      if (hasChange) {
        anyChange = true;
        tracker.reserve0 = reserve0;
        tracker.reserve1 = reserve1;
        tracker.lastCheck = Date.now();
      }

      console.log(`💰 [${deployId}] ${token0Symbol} 储备: ${reserve0.toFixed(6)} (变化: ${reserve0Change >= 0 ? '+' : ''}${reserve0Change.toFixed(6)})`);
      console.log(`💰 [${deployId}] ${token1Symbol} 储备: ${reserve1.toFixed(6)} (变化: ${reserve1Change >= 0 ? '+' : ''}${reserve1Change.toFixed(6)})`);
      console.log(`📊 [${deployId}] 总流动性: ${tracker.totalSupply.toFixed(6)}`);

      // 检查该池子是否有外部买入
      const hasExternalBuy = externalBuyFlags[lpAddr] || false;

      // 只有发生外部买入时才构建通知内容
      if (hasExternalBuy) {
        const escapedName = escapeMarkdown(dep.name || '未知');
        const escapedSymbol = escapeMarkdown(dep.symbol || '?');
        const escapedLpAddr = escapeMarkdown(lpAddr);
        const escapedToken0Symbol = escapeMarkdown(token0Symbol);
        const escapedToken1Symbol = escapeMarkdown(token1Symbol);
        
        const formattedReserve0 = escapeMarkdown(formatNumber(reserve0));
        const formattedReserve1 = escapeMarkdown(formatNumber(reserve1));
        const formattedTotalSupply = escapeMarkdown(formatNumber(tracker.totalSupply));
        
        const formattedReserve0Change = escapeMarkdown(
          (reserve0Change >= 0 ? '+' : '') + formatNumber(reserve0Change)
        );
        const formattedReserve1Change = escapeMarkdown(
          (reserve1Change >= 0 ? '+' : '') + formatNumber(reserve1Change)
        );

        summaryRows.push(
          `▫️ *${escapedName} \\(${escapedSymbol}\\)*\n` +
          `   LP: \`${escapedLpAddr}\`\n` +
          `   ${escapedToken0Symbol}: ${formattedReserve0} \\(${formattedReserve0Change}\\)\n` +
          `   ${escapedToken1Symbol}: ${formattedReserve1} \\(${formattedReserve1Change}\\)\n` +
          `   总LP: ${formattedTotalSupply}\n`
        );

        // 只有发生外部买入且储备有变化时才发送单个池子通知
        if (hasChange && hasTelegram) {
          try {
            await sendLpPoolAlert({
              network,
              deployId,
              name: dep.name || '未知',
              symbol: dep.symbol || '?',
              lpAddr,
              token0Symbol,
              token1Symbol,
              reserve0,
              reserve1,
              reserve0Change,
              reserve1Change,
              totalSupply: tracker.totalSupply
            });
            console.log(`[TG] [${deployId}] 变动已发送Telegram`);
          } catch (e) {
            console.error(`[TG] [${deployId}] 通知失败: ${e.message}`);
          }
        }
      }
      
      // 监控代币转账（传入externalBuyFlags用于标记外部买入）
      try {
        await monitorTokenTransfers(provider, dep, exemptAddresses, externalBuyFlags);
      } catch (e) {
        console.error(`⚠️ [${dep.symbol}] 代币转账监控失败: ${e.message}`);
      }
    }

    // 只有发生外部买入时才发送汇总报告
    if (Object.keys(externalBuyFlags).length > 0 && hasTelegram && summaryRows.length) {
      try {
        await sendLpPoolSummary({
          network,
          deployId,
          summaryRows
        });
        console.log(`[TG] [${deployId}] 摘要报告发送成功`);
      } catch (e) {
        console.error(`[TG] [${deployId}] 摘要发送失败: ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`❌ [${deployId}] 监控出错: ${e.message}`);
    if (hasTelegram) {
      try {
        await sendMonitorError(e, {
          network,
          deployId
        });
      } catch (tgErr) {
        console.error(`[TG] 错误通知发送失败: ${tgErr.message}`);
      }
    }
  }
}

async function startLoop() {
  console.log(`🚀 [${deployId}] LP池监控启动，每隔${INTERVAL_SEC}秒自动检测...`);
  
  // 6. 在每次监控循环之间添加额外延迟
  const extraDelay = Math.floor(INTERVAL_SEC / 3) * 1000; // 间隔时间的1/3
  console.log(`⏳ 在监控循环之间添加 ${extraDelay/1000} 秒额外延迟...`);
  
  await monitorPool();
  
  // 7. 使用setTimeout替代setInterval，避免重叠执行
  setTimeout(() => {
    startLoop().catch(console.error);
  }, INTERVAL_SEC * 1000 + extraDelay);
}

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未处理的拒绝:', reason);
  if (hasTelegram) {
    const escapedDeployId = escapeMarkdown(deployId);
    const escapedReason = escapeMarkdown(reason.message || reason);
    const escapedTime = escapeMarkdown(new Date().toLocaleString());
    
    sendTelegramMessage(
        `🔥 *监控崩溃* \\n` +
        `📌 部署ID: \\\`${escapedDeployId}\\\`\\n` +
        `▫️ 原因: \\\`${escapedReason}\\\`\\n` +
        `🕒 ${escapedTime}`
    ).catch(console.error).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

startLoop().catch(e => {
  console.error(`❌ [${deployId}] 监控脚本致命错误: ${e.message}`);
  if (hasTelegram) {
    const escapedDeployId = escapeMarkdown(deployId);
    const escapedError = escapeMarkdown(e.message);
    const escapedTime = escapeMarkdown(new Date().toLocaleString());
    
    sendTelegramMessage(
        `🔥 *监控崩溃* \\n` +
        `📌 部署ID: \\\`${escapedDeployId}\\\`\\n` +
        `▫️ 错误: \\\`${escapedError}\\\`\\n` +
        `🕒 ${escapedTime}`
    ).catch(console.error).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});