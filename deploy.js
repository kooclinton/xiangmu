// MirageStrike Supreme™ v12.3.1-multitenant - 修复版
// 完全多用户多任务隔离

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import hre from "hardhat";
import dotenv from "dotenv";
import { ethers } from "ethers";
import {
  Contract,
  ContractFactory,
  Wallet,
  JsonRpcProvider,
  Interface,
  parseEther,
  formatEther,
} from "ethers";
import { buildRandomProxyVariant } from "../builder/ProxyVariantBuilder.js";
import { getRandomNamePair } from "../utils/deepseek.js";
import { getDexConfig } from "../config/dexConfig.js";
import { initRpcManager, getRpcProviderList } from "../config/rpcManager.js";
import { sendDeploymentReport, sendErrorNotification } from "../utils/telegram.js";

// ======== 1. 参数校验与提取 userId/network/deployId ========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 新增：交易确认超时配置
const CONFIRMATION_TIMEOUT = 15000;
const CONFIRMATION_RETRY_DELAY = 5000;
const CONFIRMATION_MAX_ATTEMPTS = 5;

const userId = process.argv[2];
const network = process.argv[3];
const deployId = process.argv[4];

if (!userId || !network || !deployId) {
  console.error("❌ 用法: node deploy.js <userId> <network> <deployId>");
  console.error("   deployId 必须使用 allocateDeployerWallets.js 生成的ID");
  process.exit(1);
}

console.log(`🔧 [deploy.js] 使用已生成的 deployId: ${deployId}`);

// ✅ 关键修复：初始化RPC管理器
try {
  initRpcManager(userId);
  console.log('✅ RPC管理器初始化成功');
} catch (error) {
  console.error('❌ RPC管理器初始化失败:', error.message);
  process.exit(1);
}

// ======== 2. 目录结构全隔离 ========
const deployBase = path.join(__dirname, "../deployments", userId, network, deployId);
const walletTraderBase = path.join(__dirname, "../wallets", userId, deployId);
const configEnvPath = path.join(__dirname, "../configs", userId, ".env");

// 确保所有目录存在
for (const dir of [deployBase, walletTraderBase]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ======== 3. 加载专属env配置 ========
if (!fs.existsSync(configEnvPath)) {
  console.error(`❌ 专属env不存在: ${configEnvPath}`);
  process.exit(1);
}
dotenv.config({ path: configEnvPath });

// ======== 4. 钱包和数据归档工具 ========
function writeJsonFileSync(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { encoding: "utf8" });
}

// ======== 5. RPC/DEX 配置与钱包加载 ========
async function getNextProvider(network) {
  const rpcList = getRpcProviderList(network);
  for (const url of rpcList) {
    try {
      const provider = new JsonRpcProvider(url);
      await provider.getBlockNumber();
      
      let providerUrl = url;
      try {
        providerUrl = provider.connection?.url || 
                     provider._getConnection?.().url || 
                     url;
      } catch {}
      
      console.log(`🌐 使用RPC节点: ${providerUrl}`);
      return provider;
    } catch {
      console.warn(`⚠️ RPC节点不可用: ${url}`);
    }
  }
  throw new Error("❌ 所有RPC节点均不可用");
}

// ======== 6. 合约部署与初始化 ========
async function deployWithRetry(factory, args, signer, label) {
  for (let i = 0; i < 3; i++) {
    try {
      const contract = await factory.connect(signer).deploy(...args);
      const txHash = contract.deploymentTransaction().hash;
      console.log(`📤 ${label}合约部署交易已发送: ${txHash}`);
      
      let receipt = null;
      let confirmationAttempts = 0;
      
      while (confirmationAttempts < CONFIRMATION_MAX_ATTEMPTS && !receipt) {
        confirmationAttempts++;
        
        try {
          receipt = await Promise.race([
            contract.deploymentTransaction().wait(1),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('交易确认超时')), CONFIRMATION_TIMEOUT)
            )
          ]);
          
          console.log(`✅ ${label}合约部署成功: ${await contract.getAddress()}`);
          return contract;
        } catch (waitError) {
          if (waitError.message === '交易确认超时') {
            console.warn(`⏰ ${label}合约等待确认超时 (尝试 ${confirmationAttempts}/${CONFIRMATION_MAX_ATTEMPTS})`);
            
            if (confirmationAttempts >= CONFIRMATION_MAX_ATTEMPTS) {
              try {
                console.log(`🔍 最终尝试：直接查询链上交易状态...`);
                const provider = signer.provider;
                const finalReceipt = await provider.getTransactionReceipt(txHash);
                if (finalReceipt && finalReceipt.confirmations >= 1) {
                  console.log(`✅ ${label}合约部署成功 (区块 ${finalReceipt.blockNumber}) [通过直接查询获得]`);
                  return contract;
                }
                
                console.error(`❌ 交易 ${txHash.slice(0, 10)}... 在链上找不到确认信息`);
                throw new Error(`${label}合约部署确认失败: 在链上找不到交易确认信息`);
              } catch (queryError) {
                console.error(`❌ 最终查询也失败: ${queryError.message}`);
                throw new Error(`${label}合约部署确认过程完全失败: ${queryError.message}`);
              }
            }
            
            await new Promise((r) => setTimeout(r, CONFIRMATION_RETRY_DELAY));
            continue;
          }
          
          throw waitError;
        }
      }
    } catch (e) {
      console.warn(`⚠️ ${label}合约部署失败 (${i + 1}/3): ${e.message}`);
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`❌ ${label}合约部署多次尝试失败`);
}

async function safeContractCall(contract, methodName, args, signer, retries = 5, delay = 10000) {
  const method = contract.interface.getFunction(methodName);
  if (!method) throw new Error(`方法 ${methodName} 不存在`);
  for (let i = 0; i < retries; i++) {
    try {
      console.log(`📨 调用 ${methodName} (${i + 1}/${retries})`);
      const tx = await contract.connect(signer)[methodName](...args);
      
      let receipt = null;
      let confirmationAttempts = 0;
      
      while (confirmationAttempts < CONFIRMATION_MAX_ATTEMPTS && !receipt) {
        confirmationAttempts++;
        
        try {
          receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('交易确认超时')), CONFIRMATION_TIMEOUT)
            )
          ]);
          
          console.log(`✅ 交易确认 (区块 ${receipt.blockNumber})`);
          return receipt;
        } catch (waitError) {
          if (waitError.message === '交易确认超时') {
            console.warn(`⏰ ${methodName} 等待确认超时 (尝试 ${confirmationAttempts}/${CONFIRMATION_MAX_ATTEMPTS})`);
            
            if (confirmationAttempts >= CONFIRMATION_MAX_ATTEMPTS) {
              try {
                console.log(`🔍 最终尝试：直接查询链上交易状态...`);
                const provider = signer.provider;
                const finalReceipt = await provider.getTransactionReceipt(tx.hash);
                if (finalReceipt && finalReceipt.confirmations >= 1) {
                  console.log(`✅ ${methodName} 交易确认 (区块 ${finalReceipt.blockNumber}) [通过直接查询获得]`);
                  return finalReceipt;
                }
                
                console.error(`❌ 交易 ${tx.hash.slice(0, 10)}... 在链上找不到确认信息`);
                throw new Error(`${methodName} 交易确认失败: 在链上找不到交易确认信息`);
              } catch (queryError) {
                console.error(`❌ 最终查询也失败: ${queryError.message}`);
                throw new Error(`${methodName} 交易确认过程完全失败: ${queryError.message}`);
              }
            }
            
            await new Promise((r) => setTimeout(r, CONFIRMATION_RETRY_DELAY));
            continue;
          }
          
          throw waitError;
        }
      }
    } catch (e) {
      console.warn(`⚠️ ${methodName} 调用失败 (${i + 1}/${retries}):`, e.message);
      if (i < retries - 1) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error(`❌ ${methodName} 多次调用失败`);
}

async function safeInitialize(contract, initData, signer) {
  for (let i = 0; i < 3; i++) {
    try {
      const tx = await contract.connect(signer).initializeProxy(initData);
      
      let receipt = null;
      let confirmationAttempts = 0;
      
      while (confirmationAttempts < CONFIRMATION_MAX_ATTEMPTS && !receipt) {
        confirmationAttempts++;
        
        try {
          receipt = await Promise.race([
            tx.wait(),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('交易确认超时')), CONFIRMATION_TIMEOUT)
            )
          ]);
          
          return receipt;
        } catch (waitError) {
          if (waitError.message === '交易确认超时') {
            console.warn(`⏰ 初始化等待确认超时 (尝试 ${confirmationAttempts}/${CONFIRMATION_MAX_ATTEMPTS})`);
            
            if (confirmationAttempts >= CONFIRMATION_MAX_ATTEMPTS) {
              try {
                console.log(`🔍 最终尝试：直接查询链上交易状态...`);
                const provider = signer.provider;
                const finalReceipt = await provider.getTransactionReceipt(tx.hash);
                if (finalReceipt && finalReceipt.confirmations >= 1) {
                  console.log(`✅ 初始化交易确认 (区块 ${finalReceipt.blockNumber}) [通过直接查询获得]`);
                  return finalReceipt;
                }
                
                console.error(`❌ 交易 ${tx.hash.slice(0, 10)}... 在链上找不到确认信息`);
                throw new Error(`初始化交易确认失败: 在链上找不到交易确认信息`);
              } catch (queryError) {
                console.error(`❌ 最终查询也失败: ${queryError.message}`);
                throw new Error(`初始化交易确认过程完全失败: ${queryError.message}`);
              }
            }
            
            await new Promise((r) => setTimeout(r, CONFIRMATION_RETRY_DELAY));
            continue;
          }
          
          throw waitError;
        }
      }
    } catch (e) {
      if (e.message.includes("Already initialized")) {
        console.warn("⚠️ 合约已初始化，跳过初始化步骤");
        return { skipped: true };
      }
      console.warn(`⚠️ 初始化尝试 ${i + 1}/3 失败:`, e.message);
      if (i >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  throw new Error("初始化失败");
}

// ======== 7. 部署/元数据输出到专属目录 ========
async function exportDeploymentFiles(deployBase, deployData) {
  fs.mkdirSync(deployBase, { recursive: true });
  writeJsonFileSync(path.join(deployBase, ".meta.json"), deployData.meta);
  writeJsonFileSync(path.join(deployBase, "deployment.json"), deployData);
  const abiFolder = path.join(deployBase, "abis");
  fs.mkdirSync(abiFolder, { recursive: true });
  writeJsonFileSync(path.join(abiFolder, "Proxy_ABI.json"), deployData.proxyArtifact.abi);
  writeJsonFileSync(path.join(abiFolder, "Logic_ABI.json"), deployData.logicArtifact.abi);
  writeJsonFileSync(path.join(abiFolder, "Admin_ABI.json"), deployData.adminArtifact.abi);
  if (deployData.fakeFactoryArtifact) {
    writeJsonFileSync(path.join(abiFolder, "FakeUniswapFactory_ABI.json"), deployData.fakeFactoryArtifact.abi);
  }
}

// ======== 8. 日志与异常隔离到专属目录 ========
function writeLogToDeployBase(message) {
  const logPath = path.join(deployBase, "deploy.log");
  fs.appendFileSync(logPath, message + "\n", { encoding: "utf8" });
}
function writeErrorToDeployBase(error) {
  const errPath = path.join(deployBase, "error.log");
  fs.appendFileSync(errPath, `[${new Date().toISOString()}] ${error.stack || error}\n`, { encoding: "utf8" });
}

// ======== 主流程 ========
async function main() {
  try {
    // -------- 钱包加载 --------
    const deployerWalletsPath = path.join(walletTraderBase, "deployers.json");
    if (!fs.existsSync(deployerWalletsPath)) {
      throw new Error(`❌ deployers.json 文件不存在于 ${walletTraderBase}，请先运行 allocateDeployerWallets.js`);
    }
    const deployers = JSON.parse(fs.readFileSync(deployerWalletsPath, "utf8"));
    const deployerWallets = new Map();
    deployers.forEach(w => {
      deployerWallets.set(w.role, w);
    });
    const logicW = deployerWallets.get("logic");
    const proxyW = deployerWallets.get("proxy");
    const adminW = deployerWallets.get("admin");
    
    if (!logicW || !proxyW || !adminW) {
      throw new Error(`❌ 钱包文件格式错误，缺少必要的角色: ${deployerWalletsPath}`);
    }
    
    writeLogToDeployBase(`[WALLET] Logic: ${logicW.address}, Proxy: ${proxyW.address}, Admin: ${adminW.address}`);

    // 加载交易钱包
    const traderWalletsPath = path.join(walletTraderBase, "trader_wallets.json");
    let traderWallets = [];
    if (fs.existsSync(traderWalletsPath)) {
      traderWallets = JSON.parse(fs.readFileSync(traderWalletsPath, "utf8"));
    } else {
      console.warn("⚠️ trader_wallets.json 文件不存在，将使用空列表");
    }

    // 加载归集钱包
    const collectorWalletsPath = path.join(walletTraderBase, "collector_wallets.json");
    let collectorWallets = [];
    if (fs.existsSync(collectorWalletsPath)) {
      collectorWallets = JSON.parse(fs.readFileSync(collectorWalletsPath, "utf8"));
    } else {
      console.warn("⚠️ collector_wallets.json 文件不存在，将使用空列表");
    }

    // 统一白名单地址收集
    const whitelist = [
      logicW.address,
      proxyW.address,
      adminW.address,
      ...traderWallets.map((w) => w.address),
      ...collectorWallets.map((w) => w.address),
    ];
    writeJsonFileSync(path.join(deployBase, "whitelist.json"), whitelist);

    // -------- 链接 RPC/DEX --------
    const provider = await getNextProvider(network);
    const { router, weth, explorer, factory } = getDexConfig(network);
    writeLogToDeployBase(`[INFO] router=${router}, weth=${weth}, explorer=${explorer}`);

    // -------- 合约名和模板 --------
    const { name, symbol } = await getRandomNamePair();
    const buildResult = await buildRandomProxyVariant(name, symbol, weth);
    writeLogToDeployBase(`[INFO] 编译器版本: ${buildResult.compilerVersion}, 模板: ${buildResult.templateType}`);

    await hre.run("compile");
    writeLogToDeployBase("[INFO] 合约编译完成");

    const getArtifact = (n) => JSON.parse(
      fs.readFileSync(path.resolve("artifacts", "contracts", "ProxyVariants", `${n}.sol`, `${n}.json`))
    );
    
    // 获取FakeUniswapFactory合约的artifact
    const getFakeFactoryArtifact = () => JSON.parse(
      fs.readFileSync(path.resolve("artifacts", "contracts", "FakeFactories", "FakeUniswapFactory.sol", "FakeUniswapFactory.json"))
    );
    
    const proxyName = buildResult.contractName;
    const logicName = `${proxyName}Logic`;
    const adminName = `${proxyName}Admin`;
    const proxyArtifact = getArtifact(proxyName);
    const logicArtifact = getArtifact(logicName);
    const adminArtifact = getArtifact(adminName);

    // -------- 部署合约 --------
    // 1. 首先部署FakeUniswapFactory合约（不依赖其他合约）
    console.log("🛠️ 正在部署FakeUniswapFactory合约...");
    const fakeFactoryArtifact = getFakeFactoryArtifact();
    // 修复：使用临时地址作为参数，稍后在初始化时更新
    const fakeFactory = await deployWithRetry(
      new ContractFactory(fakeFactoryArtifact.abi, fakeFactoryArtifact.bytecode),
      [factory, adminW.address, adminW.address, weth], // 使用临时地址
      new Wallet(adminW.privateKey, provider),
      "FakeUniswapFactory"
    );
    const fakeFactoryAddress = await fakeFactory.getAddress();
    writeLogToDeployBase(`[INFO] FakeUniswapFactory部署完成: ${fakeFactoryAddress}`);

    // 2. 部署Logic合约
    console.log("🛠️ 正在部署Logic合约...");
    const logic = await deployWithRetry(
      new ContractFactory(logicArtifact.abi, logicArtifact.bytecode),
      [],
      new Wallet(logicW.privateKey, provider),
      "Logic"
    );
    const logicAddress = await logic.getAddress();

    // 3. 部署Proxy合约
    console.log("🛠️ 正在部署Proxy合约...");
    const proxy = await deployWithRetry(
      new ContractFactory(proxyArtifact.abi, proxyArtifact.bytecode),
      [logicAddress, adminW.address],
      new Wallet(proxyW.privateKey, provider),
      "Proxy"
    );
    const proxyAddress = await proxy.getAddress();

    // 4. 部署Admin合约
    console.log("🛠️ 正在部署Admin合约...");
    const admin = await deployWithRetry(
      new ContractFactory(adminArtifact.abi, adminArtifact.bytecode),
      [adminW.address, proxyAddress, router],
      new Wallet(adminW.privateKey, provider),
      "Admin"
    );
    const adminAddress = await admin.getAddress();

    // -------- 初始化 --------
    const initArgs = [
      name,
      symbol,
      router,
      weth,
      adminAddress,
      parseEther(process.env.TOKEN_TOTAL_SUPPLY || "10000000").toString(),
      proxyAddress,
      adminAddress,
      whitelist,
      fakeFactoryAddress // 传入已部署的伪装工厂地址
    ];
    const iface = new Interface(logicArtifact.abi);
    const initData = iface.encodeFunctionData("initialize", initArgs);

    const proxyContract = new Contract(proxyAddress, proxyArtifact.abi, provider);
    const adminSigner = new Wallet(adminW.privateKey, provider);

    try {
      const initResult = await safeInitialize(proxyContract, initData, adminSigner);
      if (!initResult.skipped) writeLogToDeployBase(`[INFO] 初始化完成: ${initResult.transactionHash}`);
    } catch (e) {
      writeErrorToDeployBase(e);
      throw e;
    }

    // 权限移交
    try {
      await safeContractCall(proxyContract, "changeAdmin", [adminAddress], adminSigner);
      writeLogToDeployBase("[INFO] 权限移交Admin合约完成");
    } catch (e) {
      writeErrorToDeployBase(e);
      throw e;
    }

    // 更新FakeUniswapFactory的储备代理和代币地址
    try {
      const fakeFactoryContract = new Contract(fakeFactoryAddress, fakeFactoryArtifact.abi, adminSigner);
      // 调用setCustomPair设置正确的配对信息
      await safeContractCall(
        fakeFactoryContract, 
        "setCustomPair", 
        [proxyAddress, weth, proxyAddress], 
        adminSigner
      );
      writeLogToDeployBase("[INFO] FakeUniswapFactory配对信息更新完成");
    } catch (e) {
      writeErrorToDeployBase(e);
      console.warn("⚠️ 更新FakeUniswapFactory配对信息失败，但这不会影响主要功能:", e.message);
    }

    // -------- 最终校验 --------
    const proxyLogicContract = new Contract(proxyAddress, logicArtifact.abi, provider);
    const [currentAdmin, currentProxy, currentAdminContract] = await Promise.all([
      proxyLogicContract.admin(),
      proxyLogicContract.proxyAddress(),
      proxyLogicContract.adminContract(),
    ]);
    const proxyAdmin = await proxyContract.getAdmin();
    if (
      currentAdmin.toLowerCase() !== adminAddress.toLowerCase() ||
      currentProxy.toLowerCase() !== proxyAddress.toLowerCase() ||
      currentAdminContract.toLowerCase() !== adminAddress.toLowerCase() ||
      proxyAdmin.toLowerCase() !== adminAddress.toLowerCase()
    ) {
      writeErrorToDeployBase("合约状态验证失败");
      throw new Error("合约状态验证失败");
    }

    // -------- meta与abi归档到deployBase --------
    const deployData = {
      meta: {
        userId,
        network,
        deployId,
        name,
        symbol,
        proxyVariant: proxyName,
        compilerVersion: buildResult.compilerVersion,
        templateType: buildResult.templateType,
        timestamp: new Date().toISOString(),
        proxyAddress,
        logicAddress,
        adminAddress,
        fakeFactoryAddress,
        deployer: proxyW.address,
        adminDeployer: adminW.address,
        blockExplorerUrl: explorer,
        wethAddress: weth,
        wallets: { logic: logicW.address, proxy: proxyW.address, admin: adminW.address },
        whitelistFile: path.relative(__dirname, path.join(deployBase, "whitelist.json")),
        traderWalletFile: path.relative(__dirname, path.join(walletTraderBase, "trader_wallets.json")),
        collectorWalletFile: path.relative(__dirname, path.join(walletTraderBase, "collector_wallets.json")),
        env: configEnvPath,
      },
      deploymentId: deployId,
      network,
      contractName: name,
      symbol,
      proxyVariant: proxyName,
      compilerVersion: buildResult.compilerVersion,
      templateType: buildResult.templateType,
      logic: logicAddress,
      proxy: proxyAddress,
      admin: adminAddress,
      fakeFactory: fakeFactoryAddress,
      deployer: proxyW.address,
      adminDeployer: adminW.address,
      blockExplorerUrl: explorer,
      wethAddress: weth,
      initData,
      sourceFile: buildResult.logicPath || null,
      proxyArtifact,
      logicArtifact,
      adminArtifact,
      fakeFactoryArtifact,
      timestamp: new Date().toISOString(),
    };
    await exportDeploymentFiles(deployBase, deployData);

    // -------- 部署信息输出 --------
    console.log("════════════════════════ MirageStrike Supreme™ v12.3.1 部署完成 ═════════════════════════════");
    console.log(`[用户ID]         : ${userId}`);
    console.log(`[网络]           : ${network}`);
    console.log(`[部署ID]         : ${deployId}`);
    console.log(`[Meta文件]       : ${path.relative(__dirname, path.join(deployBase, ".meta.json"))}`);
    console.log(`[ABI目录]        : ${path.relative(__dirname, path.join(deployBase, "abis"))}`);
    console.log(`[钱包目录]       : wallets/${userId}/${deployId}/deployers.json`);
    console.log(`[交易钱包]       : ${path.relative(__dirname, walletTraderBase)}`);
    console.log(`[白名单]         : ${path.relative(__dirname, path.join(deployBase, "whitelist.json"))}`);
    console.log(`[env文件]        : ${path.relative(__dirname, configEnvPath)}`);
    console.log(`[区块链浏览器]   : ${explorer}/address/${proxyAddress}`);
    console.log(`[伪装工厂地址]   : ${fakeFactoryAddress}`);
    console.log(`[后续可直接对接]  addLiquidity.js / simulateTrader.js / collectFunds.js`);
    console.log("════════════════════════════════════════════════════════════════════════════════════════════");
    console.log("✅ 部署流程已完成! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("════════════════════════════════════════════════════════════════════════════════════════════");

    await sendDeploymentReport({
      network,
      name,
      symbol,
      strategy: buildResult.templateType,
      version: buildResult.compilerVersion,
      address: proxyAddress,
      logicAddress,
      adminAddress,
      fakeFactoryAddress,
      explorer,
      deployer: proxyW.address,
      bytecodeSize: proxyArtifact.deployedBytecode.length / 2,
      fundAmount: "0",
      mixerEnabled: false,
      userId,
      deployId,
    });
  } catch (err) {
    writeErrorToDeployBase(err);
    await sendErrorNotification(err, {
      network,
      contractName: "deploy.js",
      stage: "deployment",
      errorDetails: err.message,
      userId,
      deployId,
    });
    console.error("❌ 部署失败, 详细错误已写入本任务目录 error.log");
    process.exit(1);
  }
}

main();