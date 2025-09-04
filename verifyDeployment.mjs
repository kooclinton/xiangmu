// verifyDeployment.mjs
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// BSC Testnet RPC 节点列表（不需要 API 密钥）
const BSC_TESTNET_RPC_NODES = [
  "https://data-seed-prebsc-1-s1.binance.org:8545",
  "https://data-seed-prebsc-2-s1.binance.org:8545", 
  "https://data-seed-prebsc-1-s2.binance.org:8545",
  "https://data-seed-prebsc-2-s2.binance.org:8545",
  "https://data-seed-prebsc-1-s3.binance.org:8545",
  "https://data-seed-prebsc-2-s3.binance.org:8545"
];

async function getProvider() {
  for (const rpcUrl of BSC_TESTNET_RPC_NODES) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      // 测试连接
      await provider.getBlockNumber();
      console.log(`✅ 使用 RPC 节点: ${rpcUrl}`);
      return provider;
    } catch (error) {
      console.log(`❌ RPC 节点不可用: ${rpcUrl}`);
      continue;
    }
  }
  throw new Error("所有 RPC 节点均不可用");
}

async function verifyDeployment() {
  try {
    // 设置 Provider
    const provider = await getProvider();

    // 从部署元数据中读取代理合约地址
    const deployBase = path.join(__dirname, "../deployments/2121539489/bsc_testnet/ms-20250829-030607-6148");
    const metaPath = path.join(deployBase, ".meta.json");
    
    if (!fs.existsSync(metaPath)) {
      console.error("❌ 找不到部署元数据文件");
      return;
    }
    
    const metaData = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const proxyAddress = metaData.proxyAddress;
    const fakeFactoryAddress = metaData.fakeFactoryAddress;
    
    console.log("代理合约地址:", proxyAddress);
    console.log("预期伪装工厂地址:", fakeFactoryAddress);

    // 逻辑合约 ABI 片段
    const logicABI = [
      "function getFakeFactory() external view returns (address)",
      "function name() external view returns (string memory)",
      "function symbol() external view returns (string memory)"
    ];
    
    // 创建合约实例
    const proxyContract = new ethers.Contract(proxyAddress, logicABI, provider);
    
    try {
      // 先尝试获取代币名称和符号，确认合约可访问
      const name = await proxyContract.name();
      const symbol = await proxyContract.symbol();
      console.log(`✅ 合约可访问: ${name} (${symbol})`);
      
      // 调用 getFakeFactory 函数
      const actualFakeFactoryAddress = await proxyContract.getFakeFactory();
      console.log("✅ 从代理合约获取的伪装工厂地址:", actualFakeFactoryAddress);
      
      if (actualFakeFactoryAddress.toLowerCase() === fakeFactoryAddress.toLowerCase()) {
        console.log("✅ 验证成功: 代理合约正确使用了伪装工厂地址");
      } else {
        console.log("❌ 验证失败: 代理合约使用的伪装工厂地址与预期不符");
        console.log("预期地址:", fakeFactoryAddress);
        console.log("实际地址:", actualFakeFactoryAddress);
      }
    } catch (error) {
      console.error("❌ 调用合约函数失败:", error.message);
      console.log("尝试其他验证方法...");
      
      // 尝试其他方法验证
      await verifyUsingAlternativeMethods(provider, proxyAddress, fakeFactoryAddress);
    }
  } catch (error) {
    console.error("❌ 验证过程中出错:", error.message);
  }
}

async function verifyUsingAlternativeMethods(provider, proxyAddress, expectedFakeFactory) {
  console.log("\n尝试替代验证方法...");
  
  // 方法1: 检查部署数据
  try {
    const deploymentPath = path.join(__dirname, "../deployments/2121539489/bsc_testnet/ms-20250829-030607-6148/deployment.json");
    if (fs.existsSync(deploymentPath)) {
      const deploymentData = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
      
      // 检查初始化数据中是否包含伪装工厂地址
      if (deploymentData.initData && deploymentData.fakeFactory === expectedFakeFactory) {
        console.log("✅ 部署数据验证成功: 初始化数据包含正确的伪装工厂地址");
      } else {
        console.log("❌ 部署数据中未找到正确的伪装工厂地址");
      }
    }
  } catch (error) {
    console.log("部署数据验证失败:", error.message);
  }
  
  // 方法2: 检查代理合约的字节码中是否包含对伪装工厂的引用
  try {
    const code = await provider.getCode(proxyAddress);
    if (code.includes(expectedFakeFactory.slice(2).toLowerCase())) {
      console.log("✅ 字节码验证成功: 代理合约字节码中包含伪装工厂地址");
    } else {
      console.log("❌ 代理合约字节码中未找到伪装工厂地址");
    }
  } catch (error) {
    console.log("字节码验证失败:", error.message);
  }
  
  // 方法3: 检查初始化交易
  try {
    // 获取代理合约的创建交易
    const proxyCreationTx = await provider.getTransactionReceipt(proxyAddress);
    if (proxyCreationTx) {
      console.log("代理合约创建交易:", proxyCreationTx.transactionHash);
      
      // 获取初始化交易（如果有）
      const proxyABI = ["event Initialized(uint8 version)"];
      const proxyContract = new ethers.Contract(proxyAddress, proxyABI, provider);
      
      const events = await proxyContract.queryFilter("Initialized", proxyCreationTx.blockNumber, proxyCreationTx.blockNumber + 100);
      if (events.length > 0) {
        console.log("✅ 找到初始化事件");
        // 可以进一步解析初始化交易的数据
      } else {
        console.log("❌ 未找到初始化事件");
      }
    }
  } catch (error) {
    console.log("交易验证失败:", error.message);
  }
}

// 运行验证
verifyDeployment();