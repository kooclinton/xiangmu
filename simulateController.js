// simulateController.js - v8.8-RealisticMarketMaker
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { Wallet, JsonRpcProvider, ethers } from "ethers";
import { initRpcManager, getRpcProvider } from "../config/rpcManager.js";
import { getDexConfig } from "../config/dexConfig.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  base: "ETH"
};

// 更真实的交易参数
const PHASE_INTERVAL = 30000 + Math.floor(Math.random() * 30000); // 增加阶段间隔
const MIN_ETH_RESERVE = ethers.parseEther("0.001");
const GAS_LIMIT = 350000;
const TX_TIMEOUT = 35000;

// 流动性监控参数
const LP_MONITOR_INTERVAL = 60000; // 减少监控频率

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 获取当前时间戳 (HH:mm:ss)
function getTimestamp() {
  const now = new Date();
  return now.toTimeString().split(' ')[0];
}

// 人性化交易金额模板
const HUMANIZED_AMOUNTS = [
  0.001, 0.002, 0.003, 0.004, 0.005, 0.006, 0.007, 0.008, 0.009,
  0.01, 0.015, 0.02, 0.025, 0.03, 0.035, 0.04, 0.045, 0.05
].map(amount => ethers.parseEther(amount.toString()));

// 生成真实的人类交易金额
function generateHumanAmount(maxAmount, role) {
  // 确保有足够的余额
  if (maxAmount < MIN_ETH_RESERVE + ethers.parseEther("0.001")) return 0n;
  
  // 计算可用余额（保留gas费）
  const availableAmount = maxAmount - MIN_ETH_RESERVE;
  if (availableAmount <= 0n) return 0n;
  
  // 从模板中筛选可用的金额
  const possibleAmounts = HUMANIZED_AMOUNTS.filter(amount => 
    amount <= availableAmount && amount >= ethers.parseEther("0.001")
  );
  
  if (possibleAmounts.length === 0) {
    // 如果没有匹配的模板金额，使用可用余额的随机百分比
    let minPercentage, maxPercentage;
    
    // 基于角色设置不同的购买比例范围
    switch(role) {
      case 'whale':
        minPercentage = 0.3;
        maxPercentage = 0.7;
        break;
      case 'fish':
        minPercentage = 0.1;
        maxPercentage = 0.3;
        break;
      case 'arbitrageur':
        minPercentage = 0.2;
        maxPercentage = 0.5;
        break;
      default:
        minPercentage = 0.2;
        maxPercentage = 0.5;
    }
    
    const percentage = minPercentage + Math.random() * (maxPercentage - minPercentage);
    return availableAmount * BigInt(Math.floor(percentage * 100)) / 100n;
  }
  
  // 随机选择一个合适的金额
  return possibleAmounts[Math.floor(Math.random() * possibleAmounts.length)];
}

// 基于角色和阶段的动态延迟函数
function getDynamicDelay(role, phase) {
  // 基础延迟配置（单位：秒）
  const BASE_DELAYS = {
    whale: { 0: 15, 1: 10, 2: 20 },   // 鲸鱼交易间隔更长
    fish: { 0: 8, 1: 5, 2: 12 },      // 小鱼交易更频繁
    arbitrageur: { 0: 25, 1: 18, 2: 15 } // 套利者交易最谨慎
  };
  
  // 角色基础延迟
  const baseDelay = BASE_DELAYS[role][phase];
  
  // 添加随机性 (±30%)
  const jitter = baseDelay * 0.3 * (Math.random() - 0.5);
  
  // 最终延迟（毫秒）
  return (baseDelay + jitter) * 1000;
}

class UltimateMarketMaker {
  constructor(traders, tokenAddress, dex, network, lpAddress) {
    this.traders = traders;
    this.tokenAddress = tokenAddress;
    this.dex = dex;
    this.network = network;
    this.lpAddress = lpAddress;
    this.phase = 0;
    this.active = true;
    this.traderStates = new Map();
    this.marketHeat = 0.7;
    this.tokenPrice = 0;
    this.pumpCount = 0;
    this.lastPriceChange = "0.00%";
    
    // 根据网络获取基础代币符号
    this.baseSymbol = tokenSymbols[network] || "ETH";
    
    // 交易者角色
    this.whales = [];    // 大额买家 (30%)
    this.fish = [];      // 小额买家 (60%)
    this.arbitrageurs = []; // 套利者 (10%)
    
    // 流动性数据
    this.liquidityData = {
      reserveWETH: 0,
      reserveToken: 0
    };
    
    // 流动性监控定时器
    this.lpMonitorInterval = null;
    
    // 交易nonce缓存
    this.nonceCache = new Map();
  }

  async init(provider) {
    console.log("🔥 初始化市场制造引擎...");
    
    // 初始化钱包状态
    for (const trader of this.traders) {
      const wallet = new Wallet(trader.privateKey, provider);
      const ethBalance = await provider.getBalance(wallet.address);
      
      this.traderStates.set(trader.address, {
        wallet,
        ethBalance,
        tokenBalance: 0n,
        lastAction: 0,
        aggression: 0.6 + Math.random() * 0.4,
        fomoFactor: 0.7 + Math.random() * 0.3,
        activityLevel: 0.8,
        gasReserve: MIN_ETH_RESERVE
      });
      
      // 初始化nonce缓存
      this.nonceCache.set(trader.address, await provider.getTransactionCount(wallet.address, 'pending'));
      
      console.log(`💰 ${trader.address} | ${this.baseSymbol}: ${ethers.formatEther(ethBalance)}`);
    }
    
    // 分配交易者角色
    this.assignTraderRoles();
    
    // 获取初始代币价格
    await this.fetchTokenPrice(provider);
    
    // 启动流动性监控
    if (this.lpAddress) {
      this.startLiquidityMonitoring(provider);
    }
    
    console.log(`✅ 已初始化 ${this.traderStates.size} 个交易机器人 | 初始价格: ${this.tokenPrice.toFixed(8)} ${this.baseSymbol}`);
    console.log("🎯 目标: 制造真实市场行为，引诱外部BOT跟风");
  }
  
  // 分配交易者角色
  assignTraderRoles() {
    // 按ETH余额排序
    const sortedTraders = [...this.traders].sort((a, b) => {
      const balanceA = this.traderStates.get(a.address)?.ethBalance || 0n;
      const balanceB = this.traderStates.get(b.address)?.ethBalance || 0n;
      return balanceB > balanceA ? 1 : -1;
    });
    
    // 角色分配比例
    const whaleCount = Math.max(1, Math.floor(this.traders.length * 0.3));
    const fishCount = Math.max(1, Math.floor(this.traders.length * 0.6));
    const arbitrageurCount = Math.max(1, this.traders.length - whaleCount - fishCount);
    
    this.whales = sortedTraders.slice(0, whaleCount);
    this.fish = sortedTraders.slice(whaleCount, whaleCount + fishCount);
    this.arbitrageurs = sortedTraders.slice(whaleCount + fishCount);
    
    console.log(`👥 角色分配: ${this.whales.length}大额 | ${this.fish.length}小额 | ${this.arbitrageurs.length}套利`);
    
    // 打印角色分配
    this.whales.forEach(t => console.log(`🐳 大额买家: ${t.address}`));
    this.fish.forEach(t => console.log(`🐟 小额买家: ${t.address}`));
    this.arbitrageurs.forEach(t => console.log(`🦊 套利者: ${t.address}`));
  }
  
  // 启动流动性监控
  startLiquidityMonitoring(provider) {
    console.log("🔍 启动流动性监控...");
    this.monitorLiquidity(provider);
    this.lpMonitorInterval = setInterval(() => {
      this.monitorLiquidity(provider);
    }, LP_MONITOR_INTERVAL);
  }
  
  // 监控流动性池
  async monitorLiquidity(provider) {
  try {
    const pairContract = new ethers.Contract(this.lpAddress, [
      "function getReserves() view returns (uint112, uint112, uint32)",
      "function token0() view returns (address)",
      "function token1() view returns (address)"
    ], provider);
    
    // 1. 获取代币对地址
    const [token0, token1] = await Promise.all([
      pairContract.token0(),
      pairContract.token1()
    ]);
    
    // 2. 获取储备量
    const [reserve0, reserve1] = await pairContract.getReserves();
    
    // 3. 确定基础代币（WETH）的位置
    const wethAddress = this.dex.weth.toLowerCase();
    let baseReserve, tokenReserve;
    
    if (token0.toLowerCase() === wethAddress) {
      baseReserve = reserve0;
      tokenReserve = reserve1;
    } else if (token1.toLowerCase() === wethAddress) {
      baseReserve = reserve1;
      tokenReserve = reserve0;
    } else {
      console.warn(`⚠️ [${getTimestamp()}] 无法识别基础代币: ${wethAddress}`);
      return;
    }
    
    // 4. 格式化并存储流动性数据
    this.liquidityData = {
      reserveBase: parseFloat(ethers.formatEther(baseReserve)),
      reserveToken: parseFloat(ethers.formatEther(tokenReserve))
    };
    
    // 5. 打印格式化信息
    console.log(
      `💧 [${getTimestamp()}] 流动性: ${this.baseSymbol}=${this.liquidityData.reserveBase.toFixed(4)} ` +
      `| 代币=${this.liquidityData.reserveToken.toFixed(0)}`
    );
  } catch (e) {
    console.warn(`⚠️ [${getTimestamp()}] 流动性监控失败: ${e.message}`);
  }
}

  async fetchTokenPrice(provider) {
    try {
      const router = new ethers.Contract(this.dex.router, [
        "function getAmountsOut(uint,address[]) view returns (uint[])"
      ], provider);
      
      const path = [this.dex.weth, this.tokenAddress];
      const amountIn = ethers.parseEther("1");
      
      const amounts = await router.getAmountsOut(amountIn, path);
      const tokensPerEth = parseFloat(ethers.formatEther(amounts[1]));
      
      // 添加最小值保护
      this.tokenPrice = tokensPerEth > 1e-10 ? 1 / tokensPerEth : 1e-10;
      
      return this.tokenPrice;
    } catch (e) {
      console.warn(`⚠️ [${getTimestamp()}] 获取代币价格失败: ${e.message}`);
      return 0;
    }
  }
  
  // 更新所有钱包余额
  async updateBalances(provider) {
    for (const [address, state] of this.traderStates.entries()) {
      try {
        // 更新ETH余额
        state.ethBalance = await provider.getBalance(address);
        
        // 更新代币余额
        const tokenContract = new ethers.Contract(this.tokenAddress, [
          "function balanceOf(address) view returns (uint)"
        ], provider);
        state.tokenBalance = await tokenContract.balanceOf(address);
        
        console.log(`🔄 [${getTimestamp()}] ${address} | ${this.baseSymbol}: ${ethers.formatEther(state.ethBalance)} | 代币: ${ethers.formatEther(state.tokenBalance)}`);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 更新 ${address} 余额失败: ${e.message}`);
      }
    }
  }

  async run(provider) {
    await this.init(provider);
    console.log("🚀 启动市场制造引擎 - 真实市场模式...");
    
    // 初始操作 - 制造初始热度
    await this.createInitialHeat(provider);
    
    while (this.active && this.phase < 3) {
      console.log(`\n===== 🔥 [${getTimestamp()}] 进入阶段 ${this.phase + 1}/3 =====`);
      
      // 更新所有钱包余额
      await this.updateBalances(provider);
      
      // 更新价格
      await this.fetchTokenPrice(provider);
      console.log(`📈 [${getTimestamp()}] 当前价格: ${this.tokenPrice.toFixed(8)} ${this.baseSymbol} | 市场热度: ${(this.marketHeat * 100).toFixed(0)}%`);
      
      try {
        switch(this.phase) {
          case 0:
            await this.executePumpPhase(provider);
            break;
          case 1:
            await this.executeFomoPhase(provider);
            break;
          case 2:
            await this.executeVolatilityPhase(provider);
            break;
        }
      } catch (e) {
        console.error(`⚠️ [${getTimestamp()}] 阶段 ${this.phase + 1} 执行失败:`, e.message);
        this.phase++;
        continue;
      }
      
      this.phase++;
      
      // 阶段之间添加随机操作
      if (this.active) {
        const delay = PHASE_INTERVAL;
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进入下一阶段...`);
        await sleep(delay);
        await this.executeRandomActions(provider, 2 + Math.floor(Math.random() * 3)); // 减少随机操作次数
      }
    }
    
    console.log(`\n🎯 [${getTimestamp()}] 市场制造完成 - 等待BOT上钩`);
    
    // 在结束前最大化利用所有钱包资金
    console.log(`\n💰 [${getTimestamp()}] 最大化利用剩余资金购买代币...`);
    await this.utilizeAllFunds(provider);
  }
  
  // 新增方法：最大化利用所有资金
  async utilizeAllFunds(provider) {
    // 先更新所有余额
    await this.updateBalances(provider);
    
    // 按ETH余额排序（从大到小）
    const sortedTraders = [...this.traders].sort((a, b) => {
      const balanceA = this.traderStates.get(a.address)?.ethBalance || 0n;
      const balanceB = this.traderStates.get(b.address)?.ethBalance || 0n;
      return balanceB > balanceA ? 1 : -1;
    });
    
    for (const trader of sortedTraders) {
      try {
        const state = this.traderStates.get(trader.address);
        if (!state || state.ethBalance <= MIN_ETH_RESERVE) continue;
        
        // 计算可用金额（保留最低ETH用于gas）
        const availableAmount = state.ethBalance - MIN_ETH_RESERVE;
        
        if (availableAmount > 0n) {
          await this.executeBuy(provider, trader, availableAmount, "final-buy");
          
          // 添加动态延迟
          const delay = getDynamicDelay(
            this.getTraderRole(trader.address), 
            this.phase
          );
          console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
          await sleep(delay);
        }
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 最终购买失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  // 获取交易者角色
  getTraderRole(address) {
    if (this.whales.some(t => t.address === address)) return 'whale';
    if (this.fish.some(t => t.address === address)) return 'fish';
    if (this.arbitrageurs.some(t => t.address === address)) return 'arbitrageur';
    return 'unknown';
  }

  // 制造初始市场热度
  async createInitialHeat(provider) {
    console.log(`\n🔥 [${getTimestamp()}] 制造初始市场热度...`);
    
    // 1. 所有交易者参与初始热度
    const allTraders = [...this.whales, ...this.fish, ...this.arbitrageurs];
    const shuffledTraders = [...allTraders].sort(() => Math.random() - 0.5);
    
    for (const trader of shuffledTraders) {
      try {
        const state = this.traderStates.get(trader.address);
        // 极低门槛：只要有0.002 ETH就可以参与
        if (!state || state.ethBalance < ethers.parseEther("0.002")) continue;
        
        // 生成人性化购买金额（基于角色）
        const role = this.getTraderRole(trader.address);
        const buyAmount = generateHumanAmount(state.ethBalance, role);
        
        if (buyAmount === 0n) continue;
        
        await this.executeBuy(provider, trader, buyAmount, "initial-pump");
        
        // 添加动态延迟
        const delay = getDynamicDelay(role, this.phase);
        await sleep(delay);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.1);
        this.pumpCount++;
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 初始热度制造失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  // 价格拉升阶段
  async executePumpPhase(provider) {
    console.log(`\n🚀 [${getTimestamp()}] 价格拉升阶段: 制造暴涨假象`);
    this.lastPriceChange = "0.00%";
    
    // 选择1-3个交易者执行拉升
    const pumpers = [...this.traders]
      .filter(t => {
        const state = this.traderStates.get(t.address);
        return state && state.ethBalance > ethers.parseEther("0.002");
      })
      .sort(() => Math.random() - 0.5)
      .slice(0, 1 + Math.floor(Math.random() * 2)); // 减少拉升者数量
    
    if (pumpers.length === 0) return;
    
    this.pumpCount++;
    
    for (const trader of pumpers) {
      try {
        const state = this.traderStates.get(trader.address);
        if (!state) continue;
        
        // 获取角色
        const role = this.getTraderRole(trader.address);
        
        // 基于角色生成购买金额比例
        let minPercentage, maxPercentage;
        if (role === 'whale') {
          minPercentage = 0.3;
          maxPercentage = 0.6;
        } else {
          minPercentage = 0.2;
          maxPercentage = 0.4;
        }
        
        const percentage = minPercentage + Math.random() * (maxPercentage - minPercentage);
        const baseAmount = state.ethBalance * BigInt(Math.floor(percentage * 100)) / 100n;
        
        // 使用人性化金额
        const buyAmount = generateHumanAmount(baseAmount, role);
        
        if (buyAmount === 0n) continue;
        
        // 记录拉升前价格
        const beforePrice = parseFloat(this.tokenPrice.toFixed(10));
        
        await this.executeBuy(provider, trader, buyAmount, "aggressive-pump");
        
        // 添加动态延迟
        const delay = getDynamicDelay(role, this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
        
        // 记录拉升后价格
        await this.fetchTokenPrice(provider);
        const afterPrice = parseFloat(this.tokenPrice.toFixed(10));
        
        // 计算价格变化
        let priceChange = "0.00%";
        if (beforePrice > 0) {
          const change = ((afterPrice - beforePrice) / beforePrice * 100);
          priceChange = change.toFixed(2) + '%';
          this.lastPriceChange = priceChange;
        }

        console.log(`🚀 [${getTimestamp()}] ${trader.address} 拉升价格 ${priceChange}`);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.3);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 价格拉升失败: ${trader.address} - ${e.message}`);
      }
    }
    
    // 拉升后小额买家跟风买入（减少参与人数）
    console.log(`🐟 [${getTimestamp()}] 拉升后小额买家跟风买入...`);
    const fishToActivate = Math.max(1, Math.floor(this.fish.length * 0.4)); // 只有40%的小鱼参与
    const shuffledFish = [...this.fish].sort(() => Math.random() - 0.5).slice(0, fishToActivate);
    
    for (const trader of shuffledFish) {
      try {
        const state = this.traderStates.get(trader.address);
        if (!state || state.ethBalance < ethers.parseEther("0.002")) continue;
        
        // 小额买家买入较小金额 (10-20%的余额)
        const percentage = 0.1 + Math.random() * 0.1;
        const baseAmount = state.ethBalance * BigInt(Math.floor(percentage * 100)) / 100n;
        
        // 使用人性化金额
        const buyAmount = generateHumanAmount(baseAmount, 'fish');
        
        if (buyAmount === 0n) continue;
        
        await this.executeBuy(provider, trader, buyAmount, "pump-follow");
        
        // 添加动态延迟
        const delay = getDynamicDelay('fish', this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.05);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 跟风买入失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  // FOMO阶段
  async executeFomoPhase(provider) {
    console.log(`\n💥 [${getTimestamp()}] FOMO阶段: 部分交易者入场`);
    
    // 减少参与交易的交易者数量
    const activeCount = Math.max(2, Math.floor(this.traders.length * 0.6)); // 只有60%的交易者参与
    const allTraders = [...this.traders].sort(() => Math.random() - 0.5).slice(0, activeCount);
    
    for (const trader of allTraders) {
      if (!this.active) break;
      
      try {
        const state = this.traderStates.get(trader.address);
        if (!state || state.ethBalance < ethers.parseEther("0.002")) continue;
        
        // 获取角色
        const role = this.getTraderRole(trader.address);
        
        // 基于FOMO因子决定买入量
        const buyFactor = state.fomoFactor * (0.8 + this.marketHeat * 0.4);
        const maxPercentage = Math.min(0.7, 0.5 * buyFactor); // 降低最大购买比例
        
        // 生成基础金额
        const baseAmount = state.ethBalance * BigInt(Math.floor(maxPercentage * 100)) / 100n;
        
        // 使用人性化金额（基于角色）
        const buyAmount = generateHumanAmount(baseAmount, role);
        
        if (buyAmount === 0n) continue;
        
        await this.executeBuy(provider, trader, buyAmount, "fomo-buy");
        
        // 添加动态延迟
        const delay = getDynamicDelay(role, this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.05 * state.aggression);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] FOMO买入失败: ${trader.address} - ${e.message}`);
      }
    }
    
    // 随机选择部分交易者进行小额卖出制造波动（减少卖出者比例）
    console.log(`💧 [${getTimestamp()}] FOMO阶段制造小幅波动...`);
    const sellers = [...this.traders].filter(t => {
      const state = this.traderStates.get(t.address);
      return state && state.tokenBalance > 0n;
    }).sort(() => Math.random() - 0.5)
    .slice(0, Math.max(1, Math.floor(this.traders.length * 0.3))); // 减少卖出者比例
    
    for (const trader of sellers) {
      try {
        const state = this.traderStates.get(trader.address);
        if (!state || state.tokenBalance === 0n) continue;
        
        // 小额卖出 (5-15%的代币)
        const sellPercentage = 0.05 + Math.random() * 0.1;
        const sellAmount = state.tokenBalance * BigInt(Math.floor(sellPercentage * 100)) / 100n;
        
        const tx = await this.executeSell(provider, trader, sellAmount);
        
        if (tx) {
          // 计算卖出价值
          const tokensSold = parseFloat(ethers.formatEther(sellAmount));
          const ethValue = tokensSold * this.tokenPrice;
          
          console.log(`🔻 [${getTimestamp()}] ${trader.address} 卖出 ${tokensSold.toFixed(6)} 代币 (≈${ethValue.toFixed(6)} ${this.baseSymbol}) | Tx: ${tx.hash}`);
        }
        
        // 添加动态延迟
        const role = this.getTraderRole(trader.address);
        const delay = getDynamicDelay(role, this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.05);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 卖出失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  // 波动阶段
  async executeVolatilityPhase(provider) {
    console.log(`\n⚡ [${getTimestamp()}] 波动阶段: 制造价格波动`);
    
    try {
      // 第一阶段：拉升
      await this.executePumpPhase(provider);
      
      // 添加延迟
      console.log(`⏳ [${getTimestamp()}] 等待 5秒 进行抛售操作...`);
      await sleep(5000);
      
      // 第二阶段：制造抛售
      await this.executeDump(provider);
      
      // 添加延迟
      console.log(`⏳ [${getTimestamp()}] 等待 4秒 进行二次拉升...`);
      await sleep(4000);
      
      // 第三阶段：二次拉升
      await this.executePumpPhase(provider);
      
      // 添加延迟
      console.log(`⏳ [${getTimestamp()}] 等待 3秒 进行二次抛售...`);
      await sleep(3000);
      
      // 第四阶段：二次抛售
      await this.executeDump(provider);
      
      // 添加延迟
      console.log(`⏳ [${getTimestamp()}] 等待 3秒 进行最终拉升...`);
      await sleep(3000);
      
      // 第五阶段：最终拉升
      await this.executePumpPhase(provider);
    } catch (e) {
      console.warn(`⚠️ [${getTimestamp()}] 波动阶段部分操作失败: ${e.message}`);
    }
    
    // 添加市场热度衰减
    this.marketHeat = Math.max(0.65, this.marketHeat * 0.95);
  }

  // 制造抛售
  async executeDump(provider) {
    console.log(`\n💧 [${getTimestamp()}] 制造抛售波动`);
    
    // 选择有代币余额的交易者
    const dumpers = this.traders
      .filter(t => {
        const state = this.traderStates.get(t.address);
        return state && state.tokenBalance > 0n;
      })
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.max(2, Math.floor(this.traders.length * 0.4))); // 减少抛售者数量
    
    if (dumpers.length === 0) {
      console.log(`⚠️ [${getTimestamp()}] 没有持有代币的交易者，跳过卖出`);
      return;
    }
    
    for (const trader of dumpers) {
      try {
        const state = this.traderStates.get(trader.address);
        if (!state || state.tokenBalance === 0n) continue;
        
        // 获取角色
        const role = this.getTraderRole(trader.address);
        
        // 生成卖出金额 (5-15%的代币)
        const sellPercentage = 0.05 + Math.random() * 0.1;
        const sellAmount = state.tokenBalance * BigInt(Math.floor(sellPercentage * 100)) / 100n;
        
        // 执行卖出
        const tx = await this.executeSell(provider, trader, sellAmount);
        
        if (tx) {
          // 计算卖出价值
          const tokensSold = parseFloat(ethers.formatEther(sellAmount));
          const ethValue = tokensSold * this.tokenPrice;
          
          console.log(`🔻 [${getTimestamp()}] ${trader.address} 卖出 ${tokensSold.toFixed(6)} 代币 (≈${ethValue.toFixed(6)} ${this.baseSymbol}) | Tx: ${tx.hash}`);
        }
        
        // 添加动态延迟
        const delay = getDynamicDelay(role, this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
        
        // 更新市场热度
        this.marketHeat = Math.min(0.98, this.marketHeat + 0.1);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 抛售失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  // 执行随机操作
  async executeRandomActions(provider, count) {
    console.log(`\n🎲 [${getTimestamp()}] 制造随机市场噪音...`);
    const activeTraders = this.traders.filter(t => {
      const state = this.traderStates.get(t.address);
      return state && (state.ethBalance > MIN_ETH_RESERVE || state.tokenBalance > 0n);
    });
    
    // 随机选择交易者
    const shuffledTraders = [...activeTraders].sort(() => Math.random() - 0.5);
    const selectedTraders = shuffledTraders.slice(0, Math.min(count, shuffledTraders.length));
    
    for (const trader of selectedTraders) {
      if (!this.active) break;
      
      try {
        const state = this.traderStates.get(trader.address);
        if (!state) continue;
        
        // 获取角色
        const role = this.getTraderRole(trader.address);
        
        // 50%概率买入，50%概率卖出
        const actionType = Math.random();
        
        if (actionType < 0.5 && state.ethBalance > MIN_ETH_RESERVE) {
          // 随机买入
          const buyAmount = generateHumanAmount(state.ethBalance, role);
          
          if (buyAmount > 0n) {
            await this.executeBuy(provider, trader, buyAmount, "noise-buy");
          }
        } else if (state.tokenBalance > 0n) {
          // 小额卖出制造波动 (5-15%的代币)
          const sellPercentage = 0.05 + Math.random() * 0.1;
          const sellAmount = state.tokenBalance * BigInt(Math.floor(sellPercentage * 100)) / 100n;
          
          // 执行卖出
          const tx = await this.executeSell(provider, trader, sellAmount);
          
          if (tx) {
            // 计算卖出价值
            const tokensSold = parseFloat(ethers.formatEther(sellAmount));
            const ethValue = tokensSold * this.tokenPrice;
            
            console.log(`🔻 [${getTimestamp()}] ${trader.address} 卖出 ${tokensSold.toFixed(6)} 代币 (≈${ethValue.toFixed(6)} ${this.baseSymbol}) | Tx: ${tx.hash}`);
          }
        }
        
        // 随机市场热度衰减
        if (Math.random() > 0.8) {
          this.marketHeat = Math.max(0.65, this.marketHeat * 0.95);
        }
        
        // 添加动态延迟
        const delay = getDynamicDelay(role, this.phase);
        console.log(`⏳ [${getTimestamp()}] 等待 ${(delay/1000).toFixed(1)}秒 进行下一操作...`);
        await sleep(delay);
      } catch (e) {
        console.warn(`⚠️ [${getTimestamp()}] 随机操作失败: ${trader.address} - ${e.message}`);
      }
    }
  }

  async executeBuy(provider, trader, amountWei, actionType) {
    try {
      if (!this.active) return null;
      
      const state = this.traderStates.get(trader.address);
      if (!state) return null;
      
      // 获取当前 nonce
      let nonce = this.nonceCache.get(trader.address) || await provider.getTransactionCount(trader.address, 'pending');
      
      // 获取当前 gas 价格并增加10%作为缓冲
      const feeData = await provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || feeData.maxFeePerGas;
      const gasPrice = baseGasPrice * 11n / 10n; // 增加10%避免交易失败
      
      // 估算 gas 费用
      const estimatedGasCost = gasPrice * BigInt(GAS_LIMIT);
      
      // 确保有足够余额
      const requiredAmount = amountWei + estimatedGasCost;
      if (state.ethBalance < requiredAmount) {
        // 如果余额不足，尝试使用最大可用金额
        const availableAmount = state.ethBalance - estimatedGasCost - MIN_ETH_RESERVE;
        if (availableAmount > 0n) {
          amountWei = availableAmount;
        } else {
          const balanceEth = parseFloat(ethers.formatEther(state.ethBalance)).toFixed(6);
          const requiredEth = parseFloat(ethers.formatEther(requiredAmount)).toFixed(6);
          console.log(`⚠️ [${getTimestamp()}] ${trader.address} 余额不足 (${balanceEth} ${this.baseSymbol} < ${requiredEth} ${this.baseSymbol})，跳过购买`);
          return null;
        }
      }
      
      const router = new ethers.Contract(this.dex.router, [
        "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint,address[],address,uint) payable"
      ], state.wallet);
      
      const path = [this.dex.weth, this.tokenAddress];
      const amountOutMin = 0;
      const deadline = Math.floor(Date.now() / 1000) + 300;
      
      // 添加交易超时处理
      const txPromise = router.swapExactETHForTokensSupportingFeeOnTransferTokens(
        amountOutMin,
        path,
        trader.address,
        deadline,
        {
          value: amountWei,
          gasPrice: gasPrice,
          gasLimit: GAS_LIMIT,
          nonce: nonce
        }
      );
      
      // 设置超时
      const tx = await Promise.race([
        txPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('交易超时')), TX_TIMEOUT)
        )
      ]);
      
      // 更新nonce缓存
      nonce++;
      this.nonceCache.set(trader.address, nonce);
      
      // 更新ETH余额
      state.ethBalance = await provider.getBalance(trader.address);
      
      // 更新代币余额
      const tokenContract = new ethers.Contract(this.tokenAddress, [
        "function balanceOf(address) view returns (uint)"
      ], provider);
      state.tokenBalance = await tokenContract.balanceOf(trader.address);
      
      const actualAmount = parseFloat(ethers.formatEther(amountWei));
      console.log(`✅ [${getTimestamp()}] [${actionType}] ${trader.address} 买入 ${actualAmount.toFixed(6)} ${this.baseSymbol} | Tx: ${tx.hash}`);
      
      return tx;
    } catch (e) {
      // 如果nonce错误，刷新nonce缓存
      if (e.message.includes('nonce too low') || e.message.includes('nonce has already been used')) {
        const newNonce = await provider.getTransactionCount(trader.address, 'pending');
        this.nonceCache.set(trader.address, newNonce);
        console.warn(`🔄 [${getTimestamp()}] 刷新 ${trader.address} 的nonce: ${newNonce}`);
      }
      
      console.warn(`⚠️ [${getTimestamp()}] 买入失败: ${trader.address} - ${e.message}`);
      return null;
    }
  }
  
  async executeSell(provider, trader, sellAmount) {
    try {
      if (!this.active) return null;
      
      const state = this.traderStates.get(trader.address);
      if (!state || state.tokenBalance < sellAmount) {
        console.log(`⚠️ [${getTimestamp()}] ${trader.address} 代币余额不足，跳过卖出`);
        return null;
      }
      
      // 获取当前 nonce
      let nonce = this.nonceCache.get(trader.address) || await provider.getTransactionCount(trader.address, 'pending');
      
      // 获取当前 gas 价格并增加10%作为缓冲
      const feeData = await provider.getFeeData();
      const baseGasPrice = feeData.gasPrice || feeData.maxFeePerGas;
      const gasPrice = baseGasPrice * 11n / 10n; // 增加10%避免交易失败
      
      // 确保有足够ETH支付gas费
      const estimatedGasCost = gasPrice * BigInt(GAS_LIMIT);
      if (state.ethBalance < estimatedGasCost) {
        console.log(`⚠️ [${getTimestamp()}] ${trader.address} ${this.baseSymbol} 余额不足支付gas费，跳过卖出`);
        return null;
      }
      
      // 修复合约ABI
      const tokenContract = new ethers.Contract(this.tokenAddress, [
        "function approve(address,uint) returns (bool)",
        "function balanceOf(address) view returns (uint)"
      ], state.wallet);
      
      const router = new ethers.Contract(this.dex.router, [
        "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint,uint,address[],address,uint)"
      ], state.wallet);
      
      // 批准代币
      const approveTx = await tokenContract.approve(this.dex.router, sellAmount, {
        gasPrice: gasPrice,
        gasLimit: GAS_LIMIT,
        nonce: nonce
      });
      await approveTx.wait();
      
      // 更新nonce
      nonce++;
      this.nonceCache.set(trader.address, nonce);
      
      const path = [this.tokenAddress, this.dex.weth];
      const amountOutMin = 0;
      const deadline = Math.floor(Date.now() / 1000) + 300;
      
      // 添加交易超时处理
      const txPromise = router.swapExactTokensForETHSupportingFeeOnTransferTokens(
        sellAmount,
        amountOutMin,
        path,
        trader.address,
        deadline,
        { 
          gasPrice: gasPrice,
          gasLimit: GAS_LIMIT,
          nonce: nonce
        }
      );
      
      // 设置超时
      const tx = await Promise.race([
        txPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('交易超时')), TX_TIMEOUT)
        )
      ]);
      
      // 更新nonce缓存
      nonce++;
      this.nonceCache.set(trader.address, nonce);
      
      // 更新ETH余额
      state.ethBalance = await provider.getBalance(trader.address);
      
      // 更新代币余额
      state.tokenBalance = await tokenContract.balanceOf(trader.address);
      
      return tx;
    } catch (e) {
      // 如果nonce错误，刷新nonce缓存
      if (e.message.includes('nonce too low') || e.message.includes('nonce has already been used')) {
        const newNonce = await provider.getTransactionCount(trader.address, 'pending');
        this.nonceCache.set(trader.address, newNonce);
        console.warn(`🔄 [${getTimestamp()}] 刷新 ${trader.address} 的nonce: ${newNonce}`);
      }
      
      console.warn(`⚠️ [${getTimestamp()}] 卖出失败: ${trader.address} - ${e.message}`);
      return null;
    }
  }
  
  // 停止所有活动
  stop() {
    this.active = false;
    if (this.lpMonitorInterval) {
      clearInterval(this.lpMonitorInterval);
      console.log(`🛑 [${getTimestamp()}] 流动性监控已停止`);
    }
  }
}

async function simulateController(userId, network, deployId) {
  const base = path.join(__dirname, "../");
  const deployDir = path.join(base, "deployments", userId, network, deployId);
  const walletDir = path.join(base, "wallets", userId, deployId);
  const envPath = path.join(base, "configs", userId, ".env");

  if (!fs.existsSync(envPath)) throw new Error(`找不到env: ${envPath}`);
  dotenv.config({ path: envPath });

  // ✅ 关键修复：初始化RPC管理器
  try {
    initRpcManager(userId);
    console.log('✅ RPC管理器初始化成功');
  } catch (error) {
    console.error('❌ RPC管理器初始化失败:', error.message);
    process.exit(1);
  }


  // 🔧 修复：补上缺失的右括号
  const meta = JSON.parse(fs.readFileSync(path.join(deployDir, ".meta.json"), "utf8"));
  const traderPath = path.join(walletDir, "trader_wallets.json");

  // 加载交易者钱包
  if (!fs.existsSync(traderPath)) {
    throw new Error(`❌ 交易者钱包文件不存在: ${traderPath}`);
  }
  
  const traders = JSON.parse(fs.readFileSync(traderPath, "utf8"));
  console.log(`✅ 加载 ${traders.length} 个交易机器人`);

  // 启动市场制造引擎
  const provider = getRpcProvider(network);
  const dex = getDexConfig(network);
  const tokenAddress = meta.proxyAddress || meta.proxy;
  const lpAddress = meta.lpToken || meta.lpAddress || null;
  
  console.log("🚀 启动市场模拟引擎...");
  console.log(`🎯 代币地址: ${tokenAddress}`);
  
  const marketMaker = new UltimateMarketMaker(
    traders,
    tokenAddress,
    dex,
    network,
    lpAddress
  );
  
  // 退出处理
  let exiting = false;
  const cleanup = () => {
    if (exiting) return;
    exiting = true;
    console.log(`🛑 [${getTimestamp()}] 收到退出信号，停止引擎...`);
    marketMaker.stop();
  };
  
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  try {
    await marketMaker.run(provider);
  } catch (e) {
    console.error(`❌ [${getTimestamp()}] 引擎执行失败: ${e.message}`);
  } finally {
    cleanup();
  }
}

// 主执行
const [userId, network, deployId] = process.argv.slice(2);
if (!userId || !network || !deployId) {
  console.error("❌ 用法: node simulateController.js <userId> <network> <deployId>");
  process.exit(1);
}

simulateController(userId, network, deployId).catch((err) => {
  console.error(`❌ [${getTimestamp()}] 控制器执行失败: ${err.message}`);
  process.exit(1);
});