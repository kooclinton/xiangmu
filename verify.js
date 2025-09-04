import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import { execa } from 'execa';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENTS_DIR = path.join(__dirname, "../deployments");

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
}

function getDeploymentData(userId, network, deployId) {
  const contractDir = path.join(DEPLOYMENTS_DIR, userId, network, deployId);
  const deployPath = path.join(contractDir, "deployment.json");
  
  if (!fs.existsSync(deployPath)) {
    throw new Error(`找不到部署文件: ${deployPath}`);
  }
  
  try {
    return JSON.parse(fs.readFileSync(deployPath, "utf8"));
  } catch (e) {
    throw new Error(`部署文件解析失败: ${e.message}`);
  }
}

async function verifyWithRetry(address, constructorArgs, contractPath, network, contractName, retries = 3) {
  // 获取 API Keys
  const apiKeys = process.env.ETHERSCAN_API_KEY 
    ? process.env.ETHERSCAN_API_KEY.split(',').filter(Boolean) 
    : [];
  
  if (apiKeys.length === 0) {
    throw new Error('❌ 未设置 ETHERSCAN_API_KEY 环境变量');
  }
  
  // 创建临时文件存储构造参数
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
  const argsPath = path.join(tempDir, `args-${Date.now()}.json`);
  
  // 将构造参数保存为JSON文件
  fs.writeFileSync(argsPath, JSON.stringify(constructorArgs));
  
  // 标准化路径
  const normalizedContractPath = contractPath.replace(/\\/g, '/');
  const normalizedArgsPath = argsPath.replace(/\\/g, '/');

  let currentKeyIndex = 0;
  let attempt = 0;

  while (attempt < retries) {
    // 设置当前 API Key
    const currentKey = apiKeys[currentKeyIndex];
    process.env.ETHERSCAN_API_KEY = currentKey;
    
    console.log(`🔑 使用 API Key (${currentKeyIndex + 1}/${apiKeys.length}): ${currentKey}`);
    
    const args = [
      'hardhat',
      'verify',
      address,
      '--network', network,
      '--contract', normalizedContractPath,
      '--constructor-args', normalizedArgsPath
    ];

    try {
      console.log(`⏳ 验证尝试 ${attempt + 1}/${retries}`);
      await execa('npx', args, { stdio: 'inherit' });
      console.log(`✅ 验证成功: ${address}`);
      
      // 清理临时文件
      try { fs.unlinkSync(argsPath); } catch (e) {}
      
      return true;
    } catch (error) {
      // 特殊处理合约已验证的情况
      if (error.message.includes('already verified') || 
          error.message.includes('already verified with a full match')) {
        console.log(`ℹ️ 合约已通过验证: ${address}`);
        try { fs.unlinkSync(argsPath); } catch (e) {}
        return true;
      }
      
      console.warn(`⚠️ 验证失败: ${error.message}`);
      attempt++;
      
      // 切换到下一个 Key
      currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
      
      if (attempt < retries) {
        const delay = 10 + attempt * 5;
        console.log(`⏱ ${delay}秒后使用下一个 Key 重试...`);
        await new Promise(r => setTimeout(r, delay * 1000));
      }
    }
  }
  
  try { fs.unlinkSync(argsPath); } catch (e) {}
  throw new Error(`❌ 多次验证失败: ${address}`);
}

async function verifyProxy(userId, network, deployId) {
  console.log("══════════════════════════════════════════════");
  console.log(`[用户ID]         : ${userId}`);
  console.log(`[网络]           : ${network}`);
  console.log(`[部署ID]         : ${deployId}`);
  console.log("══════════════════════════════════════════════\n");
  
  console.log(`🤖 开始验证合约...`);
  
  // 1. 获取部署数据
  const deployData = getDeploymentData(userId, network, deployId);
  console.log("📦 加载部署数据完成");
  
  // 2. 准备验证参数
  const constructorArgs = [
    deployData.logic,
    deployData.adminDeployer
  ];
  
  // 3. 准备合约文件路径
  const contractPath = `contracts/ProxyVariants/${deployData.proxyVariant}.sol:${deployData.proxyVariant}`;
  
  console.log("📝 验证参数:");
  console.log(`- 代理地址: ${deployData.proxy}`);
  console.log(`- 逻辑地址: ${deployData.logic}`);
  console.log(`- 管理员: ${deployData.adminDeployer}`);
  console.log(`- 合约路径: ${contractPath}`);
  
  // 4. 执行验证
  try {
    console.log("🔍 正在验证代理合约...");
    await verifyWithRetry(
      deployData.proxy,
      constructorArgs,
      contractPath,
      network,
      deployId
    );
    
    console.log("\n✅ 代理合约验证成功!");
    const explorerLink = `${deployData.blockExplorerUrl}/address/${deployData.proxy}#code`;
    console.log(`🌐 浏览器链接: ${explorerLink}`);
    
    console.log("\n══════════════════════════════════════════════");
    console.log("✅ 验证完成! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");
    
  } catch (error) {
    console.error("\n❌ 验证失败:", error.message);
    
    console.log("\n══════════════════════════════════════════════");
    console.log("❌ 验证失败! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");
    
    process.exit(1);
  }
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 3) {
    console.log(`
用法: 
  node verify.js <userId> <network> <deployId>

示例:
  node verify.js 2121539489 sepolia ms-20250804-002821-7336

（所有文件读取目录均为 deployments/<userId>/<network>/<deployId>/）
    `);
    process.exit(1);
  }

  const userId = args[0];
  const network = args[1];
  const deployId = args[2];

  // 加载环境变量
  const globalEnvPath = path.resolve(__dirname, "../.env");
  if (fs.existsSync(globalEnvPath)) {
    dotenv.config({ path: globalEnvPath });
    console.log('✅ 已加载全局环境变量:', globalEnvPath);
  }

  const userEnvPath = path.resolve(__dirname, "../configs", userId, ".env");
  if (fs.existsSync(userEnvPath)) {
    dotenv.config({ path: userEnvPath, override: true });
    console.log('✅ 已加载用户环境变量:', userEnvPath);
  } else {
    console.warn('⚠️ 用户专属 env 不存在:', userEnvPath);
  }
  
  // 检查 API Keys
  if (!process.env.ETHERSCAN_API_KEY) {
    console.error("❌ 错误: ETHERSCAN_API_KEY 未设置");
    process.exit(1);
  }
  
  const apiKeyCount = process.env.ETHERSCAN_API_KEY.split(',').length;
  console.log(`🔑 加载 ${apiKeyCount} 个 API Key`);
  
  // Etherscan V2 迁移提示
  console.log("ℹ️ 注意: 已迁移到 Etherscan V2 API，使用单一 API Key");
  
  try {
    await verifyProxy(userId, network, deployId);
  } catch (error) {
    console.error("❌ 脚本执行失败:", error);
    
    console.log("\n══════════════════════════════════════════════");
    console.log("❌ 全局错误! 可复制信息:");
    console.log(`${userId} ${network} ${deployId}`);
    console.log("══════════════════════════════════════════════");
    
    process.exit(1);
  }
}

try {
  main().catch((error) => {
    console.error("❌ 脚本执行失败:", error);
    process.exit(1);
  });
} catch (importError) {
  console.error("❌ 模块导入错误:", importError);
  process.exit(1);
}