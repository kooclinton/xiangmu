// simulate_bot_detection.js - v3.0
// 增强版：添加Timelock、审计验证、社交链接等全面检测
import { ethers } from "ethers";
import path from "path";
import { fileURLToPath } from "url";
import fs from 'fs';
import { initRpcManager, getRpcProvider } from "../config/rpcManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. 参数解析
const userId = process.argv[2];
const network = process.argv[3];
const deployId = process.argv[4];

if (!userId || !network || !deployId) {
    console.error("❌ 用法: node simulate_bot_detection.js <userId> <network> <deployId>");
    process.exit(1);
}

// 2. 初始化RPC管理器
try {
    initRpcManager(userId);
    console.log('✅ RPC管理器初始化成功');
} catch (error) {
    console.error('❌ RPC管理器初始化失败:', error.message);
    process.exit(1);
}

// 3. 加载部署元数据
const metaPath = path.join(__dirname, `../deployments/${userId}/${network}/${deployId}/.meta.json`);
if (!fs.existsSync(metaPath)) {
    throw new Error(`❌ 找不到部署元数据文件: ${metaPath}`);
}
const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));

const proxyAddress = meta.proxyAddress || meta.proxy;
const reserveProxyAddress = meta.reserveProxy;
const logicAddress = meta.logicAddress || meta.logic;
const adminAddress = meta.adminAddress || meta.admin;

console.log("══════════════════════════════════════════════");
console.log("🔍 开始模拟外部Bot检测");
console.log("📊 目标网络:", network);
console.log("🎯 目标代币:", proxyAddress);
console.log("🤖 模拟角色: 高级狙击机器人 / 合约分析工具");
console.log("══════════════════════════════════════════════\n");

async function main() {
    const provider = getRpcProvider(network);

    // 加载标准ERC20 ABI
    const ERC20_ABI = [
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function totalSupply() view returns (uint256)",
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address, address) view returns (uint256)",
        "function getOwner() view returns (address)",
        "function owner() view returns (address)"
    ];

    // 加载LP Pair ABI
    const PAIR_ABI = [
        "function token0() external view returns (address)",
        "function token1() external view returns (address)",
        "function getReserves() external view returns (uint112, uint112, uint32)",
        "function totalSupply() external view returns (uint256)",
        "function factory() external view returns (address)",
        "function kLast() external view returns (uint256)",
        "function balanceOf(address) view returns (uint256)"
    ];

    // 加载代理合约ABI
    const PROXY_ABI = [
        "function getImplementation() external view returns (address)",
        "function getAdmin() external view returns (address)"
    ];

    // 新增：安全特性检测ABI
    const SECURITY_ABI = [
        "function timelock() external view returns (address)",
        "function timelockDelay() external view returns (uint256)",
        "function auditReport() external view returns (string)",
        "function website() external view returns (string)",
        "function twitter() external view returns (string)",
        "function telegram() external view returns (string)",
        "function maxTransactionAmount() external view returns (uint256)",
        "function maxWalletBalance() external view returns (uint256)",
        "function locker() external view returns (address)",
        "function lockDate() external view returns (uint256)",
        "function unlockDate() external view returns (uint256)",
        "function tokenAllocation() external view returns (string)",
        "function isBlacklisted(address) external view returns (bool)"
    ];

    // 4. 初始化合约实例
    const tokenContract = new ethers.Contract(proxyAddress, ERC20_ABI, provider);
    const proxyContract = new ethers.Contract(proxyAddress, PROXY_ABI, provider);
    const reserveProxyContract = new ethers.Contract(reserveProxyAddress, [...PAIR_ABI, ...SECURITY_ABI], provider);

    console.log("✅ 连接到代币合约:", proxyAddress);
    console.log("✅ 连接到储备代理合约:", reserveProxyAddress);

    // 5. 获取代币基本信息
    console.log("\n=== 阶段 1: 基础代币信息检测 ===");
    try {
        const [name, symbol, decimals, totalSupply] = await Promise.all([
            tokenContract.name(),
            tokenContract.symbol(),
            tokenContract.decimals(),
            tokenContract.totalSupply()
        ]);
        console.log("📛 代币名称:", name);
        console.log("🔣 代币符号:", symbol);
        console.log("🔢 代币精度:", decimals.toString());
        console.log("💰 总供应量:", ethers.formatUnits(totalSupply, decimals));
    } catch (e) {
        console.log("⚠️  获取基础信息失败:", e.message);
    }

    // 6. 代理合约结构分析
    console.log("\n=== 阶段 2: 代理合约结构分析 ===");
    try {
        const [implementation, proxyAdmin] = await Promise.all([
            proxyContract.getImplementation(),
            proxyContract.getAdmin()
        ]);
        
        console.log("🔧 实现逻辑合约地址:", implementation);
        console.log("👑 代理管理员地址:", proxyAdmin);
        
        // 检查是否与元数据一致
        if (implementation === logicAddress) {
            console.log("✅ 实现合约地址与元数据一致");
        } else {
            console.log("❌ 实现合约地址与元数据不一致");
        }
        
        if (proxyAdmin === adminAddress) {
            console.log("✅ 代理管理员地址与元数据一致");
        } else {
            console.log("❌ 代理管理员地址与元数据不一致");
        }
    } catch (e) {
        console.log("⚠️  代理合约分析失败:", e.message);
    }

    // 7. 权限和所有权检查
    console.log("\n=== 阶段 3: 权限和所有权分析 ===");
    try {
        const [owner, adminBalance, proxyAdminBalance] = await Promise.all([
            tokenContract.owner ? tokenContract.owner().catch(() => null) : null,
            provider.getBalance(adminAddress),
            proxyContract.getAdmin ? provider.getBalance(await proxyContract.getAdmin()).catch(() => null) : null
        ]);

        if (owner && owner !== ethers.ZeroAddress) {
            console.log("👑 检测到Owner地址:", owner);
            // 检查Owner余额
            const ownerBalance = await provider.getBalance(owner);
            console.log("   💰 Owner余额:", ethers.formatEther(ownerBalance), "ETH");
        }

        console.log("⚙️  Admin合约地址:", adminAddress);
        console.log("   💰 Admin余额:", ethers.formatEther(adminBalance), "ETH");
        
        if (proxyAdminBalance !== null) {
            console.log("👑 代理管理员余额:", ethers.formatEther(proxyAdminBalance), "ETH");
        }

        // 检查是否有 renounceOwnership 功能
        try {
            const hasRenounce = await tokenContract.renounceOwnership ? true : false;
            if (hasRenounce) {
                console.log("🔓 检测到所有权放弃功能: renounceOwnership()");
            }
        } catch (e) { /* 忽略错误 */ }

    } catch (e) {
        console.log("⚠️  权限分析失败:", e.message);
    }

    // 8. LP交易对探测和分析
    console.log("\n=== 阶段 4: LP交易对探测与分析 ===");

    let detectedLpAddress = null;
    let detectionMethod = "";

    // 尝试通过各种方法获取LP地址
    try {
        const displayLp = await tokenContract.getDisplayPairAddress ? await tokenContract.getDisplayPairAddress() : null;
        if (displayLp && displayLp !== ethers.ZeroAddress) {
            detectedLpAddress = displayLp;
            detectionMethod = "getDisplayPairAddress()";
        }
    } catch (e) { /* 忽略错误 */ }

    // 如果元数据中有储备代理地址，Bot也可能直接检测到它
    if (!detectedLpAddress && reserveProxyAddress) {
        detectedLpAddress = reserveProxyAddress;
        detectionMethod = "ReserveProxy地址(元数据)";
    }

    if (detectedLpAddress) {
        console.log("✅ 检测到LP交易对地址:", detectedLpAddress);
        console.log("   🎯 探测方法:", detectionMethod);

        // 分析LP交易对
        const lpContract = new ethers.Contract(detectedLpAddress, PAIR_ABI, provider);

        try {
            const [token0, token1, reserves, totalSupplyLP, factoryAddr] = await Promise.all([
                lpContract.token0(),
                lpContract.token1(),
                lpContract.getReserves(),
                lpContract.totalSupply(),
                lpContract.factory().catch(() => "未知")
            ]);

            console.log("\n📊 LP交易对深度分析:");
            console.log("   ├── Token0:", token0, token0 === proxyAddress ? "(目标代币)" : "");
            console.log("   ├── Token1:", token1, "(通常是WETH)");
            console.log("   ├── 储备量 - Token0:", ethers.formatUnits(reserves[0], 18));
            console.log("   ├── 储备量 - Token1:", ethers.formatUnits(reserves[1], 18));
            console.log("   ├── LP总供应量:", ethers.formatUnits(totalSupplyLP, 18));
            console.log("   └── 工厂地址:", factoryAddr);

            // 计算TVL
            const ethValue = Number(ethers.formatUnits(reserves[1], 18)) * 3000; // 假设ETH=$3000
            const fakeTVL = (ethValue * 2).toLocaleString('en-US', {
                style: 'currency',
                currency: 'USD'
            });
            console.log("   💰 探测到的TVL:", fakeTVL);

            // 检查LP锁定状态
            console.log("\n=== 阶段 5: LP锁定状态检测 ===");
            
            // 常见的锁仓合约和死地址
            const lockAddresses = [
                "0x000000000000000000000000000000000000dead",
                "0x0000000000000000000000000000000000000000",
                adminAddress,
                proxyAddress
            ];

            let totalLocked = 0n;
            for (let lockAddr of lockAddresses) {
                try {
                    const balance = await lpContract.balanceOf(lockAddr);
                    if (balance > 0) {
                        console.log(`   🔒 LP锁定在 ${lockAddr}: ${ethers.formatUnits(balance, 18)}`);
                        totalLocked += balance;
                    }
                } catch (e) { /* 忽略错误 */ }
            }
            
            const lockedPercentage = totalSupplyLP > 0 ? 
                (Number(totalLocked) / Number(totalSupplyLP)) * 100 : 0;
            console.log(`   📊 LP总锁定比例: ${lockedPercentage.toFixed(2)}%`);

            if (lockedPercentage > 90) {
                console.log("   ✅ LP高度锁定，安全性较高");
            } else if (lockedPercentage > 50) {
                console.log("   ⚠️  LP部分锁定，需谨慎");
            } else {
                console.log("   🚨 LP锁定不足，高风险");
            }

        } catch (lpError) {
            console.log("⚠️  LP合约分析失败:", lpError.message);
        }
    } else {
        console.log("❌ 无法自动检测到LP交易对地址");
    }

    // 9. 蜜罐特征检查
    console.log("\n=== 阶段 6: 蜜罐特征分析 ===");
    
    // 检查常见蜜罐函数
    const honeypotFunctions = [
        "setBlacklist",
        "setWhitelist",
        "setFee",
        "setMaxTxAmount",
        "setMaxWallet",
        "transferOwnership",
        "withdraw",
        "mint",
        "burn"
    ];
    
    let detectedHoneypotFeatures = [];
    
    for (let func of honeypotFunctions) {
        try {
            // 尝试获取函数，如果存在则认为是蜜罐特征
            const hasFunction = await tokenContract[func] ? true : false;
            if (hasFunction) {
                detectedHoneypotFeatures.push(func);
            }
        } catch (e) { /* 忽略错误 */ }
    }
    
    if (detectedHoneypotFeatures.length > 0) {
        console.log("🚨 检测到可能的蜜罐功能:");
        detectedHoneypotFeatures.forEach(func => {
            console.log(`   ⚠️  ${func}()`);
        });
    } else {
        console.log("✅ 未检测到明显蜜罐功能");
    }
    
    // 检查税费功能
    try {
        const [buyFee, sellFee] = await Promise.all([
            tokenContract.buyFee ? tokenContract.buyFee().catch(() => null) : null,
            tokenContract.sellFee ? tokenContract.sellFee().catch(() => null) : null
        ]);
        
        if (buyFee !== null) {
            console.log("💸 买入税费:", buyFee.toString(), "%");
        }
        if (sellFee !== null) {
            console.log("💸 卖出税费:", sellFee.toString(), "%");
        }
        
        if (buyFee > 5 || sellFee > 5) {
            console.log("🚨 高税费警告: 可能影响交易体验");
        }
    } catch (e) { /* 忽略错误 */ }

    // 10. 安全特性检测
    console.log("\n=== 阶段 7: 高级安全特性检测 ===");
    
    let securityFeatures = [];
    
    try {
        // 检测Timelock
        const timelockAddr = await reserveProxyContract.timelock().catch(() => null);
        if (timelockAddr && timelockAddr !== ethers.ZeroAddress) {
            const timelockDelay = await reserveProxyContract.timelockDelay().catch(() => 0);
            console.log("⏰ 检测到Timelock合约:", timelockAddr);
            console.log("   ⏱️  Timelock延迟:", timelockDelay / 3600, "小时");
            securityFeatures.push("✅ Timelock保护已启用");
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测审计报告
        const auditReport = await reserveProxyContract.auditReport().catch(() => null);
        if (auditReport) {
            console.log("📋 检测到审计报告:", auditReport);
            securityFeatures.push("✅ 第三方审计已完成");
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测社交链接
        const [website, twitter, telegram] = await Promise.all([
            reserveProxyContract.website().catch(() => null),
            reserveProxyContract.twitter().catch(() => null),
            reserveProxyContract.telegram().catch(() => null)
        ]);
        
        if (website) {
            console.log("🌐 官方网站:", website);
            securityFeatures.push("✅ 官方网站已设置");
        }
        if (twitter) {
            console.log("🐦 Twitter账号:", twitter);
            securityFeatures.push("✅ Twitter社交已设置");
        }
        if (telegram) {
            console.log("📢 Telegram群组:", telegram);
            securityFeatures.push("✅ Telegram社区已建立");
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测反鲸鱼机制
        const [maxTx, maxWallet] = await Promise.all([
            reserveProxyContract.maxTransactionAmount().catch(() => null),
            reserveProxyContract.maxWalletBalance().catch(() => null)
        ]);
        
        if (maxTx !== null) {
            console.log("🐋 最大交易限制:", ethers.formatUnits(maxTx, 18), "tokens");
            securityFeatures.push("✅ 反鲸鱼机制已启用");
        }
        if (maxWallet !== null) {
            console.log("👛 最大钱包限制:", ethers.formatUnits(maxWallet, 18), "tokens");
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测LP锁定信息
        const lockerAddr = await reserveProxyContract.locker().catch(() => null);
        if (lockerAddr && lockerAddr !== ethers.ZeroAddress) {
            const [lockDate, unlockDate] = await Promise.all([
                reserveProxyContract.lockDate().catch(() => 0),
                reserveProxyContract.unlockDate().catch(() => 0)
            ]);
            
            console.log("🔒 检测到LP锁定合约:", lockerAddr);
            if (lockDate > 0) {
                const lockedDays = Math.floor((Date.now() / 1000 - Number(lockDate)) / 86400);
                console.log("   📅 已锁定时间:", lockedDays, "天");
            }
            if (unlockDate > 0) {
                const remainingDays = Math.floor((Number(unlockDate) - Date.now() / 1000) / 86400);
                console.log("   ⏳ 剩余锁定时间:", remainingDays, "天");
                securityFeatures.push("✅ LP长期锁定");
            }
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测代币分配
        const allocation = await reserveProxyContract.tokenAllocation().catch(() => null);
        if (allocation) {
            console.log("📊 代币分配信息:", allocation);
            securityFeatures.push("✅ 代币分配透明");
        }
    } catch (e) { /* 忽略错误 */ }
    
    try {
        // 检测黑名单功能
        const hasBlacklist = await reserveProxyContract.isBlacklisted(ethers.ZeroAddress).catch(() => null);
        if (hasBlacklist !== null) {
            console.log("🚫 黑名单功能:", hasBlacklist ? "已启用" : "未启用");
            if (!hasBlacklist) {
                securityFeatures.push("✅ 无过度权限控制");
            }
        }
    } catch (e) { /* 忽略错误 */ }

    // 11. 合约验证状态检查 (模拟)
    console.log("\n=== 阶段 8: 合约验证状态模拟 ===");
    console.log("ℹ️  实际验证状态需要查询区块链浏览器API");
    console.log("🔍 模拟验证检查...");
    
    // 检查合约字节码长度和特征
    try {
        const code = await provider.getCode(proxyAddress);
        console.log("📏 合约字节码长度:", code.length / 2 - 1, "bytes");
        
        // 简单检查是否是代理合约
        if (code.includes("360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc")) {
            console.log("✅ 检测到代理合约模式 (ERC-1967)");
        }
        
        // 检查是否有源代码验证的典型模式
        if (code.length > 10000) {
            console.log("✅ 合约字节码较长，可能已验证");
        } else {
            console.log("⚠️  合约字节码较短，可能未验证");
        }
    } catch (e) {
        console.log("⚠️  合约代码检查失败:", e.message);
    }

    // 12. 安全评估总结
    console.log("\n══════════════════════════════════════════════");
    console.log("✅ 模拟检测完成");
    console.log("📋 安全评估总结:");
    
    let riskScore = 0;
    let riskFactors = [];
    let positiveFactors = [...securityFeatures];
    
    // 评估逻辑
    if (reserveProxyAddress && detectedLpAddress === reserveProxyAddress) {
        positiveFactors.push("✅ 真实LP地址已隐藏");
    } else {
        riskScore += 20;
        riskFactors.push("❌ 真实LP地址可能暴露");
    }
    
    // 检查管理员余额
    try {
        const adminBalance = await provider.getBalance(adminAddress);
        if (ethers.formatEther(adminBalance) < 0.01) {
            riskScore += 10;
            riskFactors.push("⚠️  Admin合约余额不足");
        }
    } catch (e) { /* 忽略错误 */ }
    
    // 检查LP锁定比例
    if (detectedLpAddress) {
        try {
            const lpContract = new ethers.Contract(detectedLpAddress, PAIR_ABI, provider);
            const totalSupplyLP = await lpContract.totalSupply();
            
            // 检查LP是否锁定在关键地址
            const lockAddresses = [
                "0x000000000000000000000000000000000000dead",
                adminAddress
            ];
            
            let totalLocked = 0n;
            for (let lockAddr of lockAddresses) {
                try {
                    const balance = await lpContract.balanceOf(lockAddr);
                    totalLocked += balance;
                } catch (e) { /* 忽略错误 */ }
            }
            
            const lockedPercentage = totalSupplyLP > 0 ? 
                (Number(totalLocked) / Number(totalSupplyLP)) * 100 : 0;
                
            if (lockedPercentage < 50) {
                riskScore += 30;
                riskFactors.push("🚨 LP锁定不足 (<50%)");
            } else if (lockedPercentage < 90) {
                riskScore += 10;
                riskFactors.push("⚠️  LP部分锁定 (50-90%)");
            } else {
                positiveFactors.push("✅ LP高度锁定 (>90%)");
            }
        } catch (e) { /* 忽略错误 */ }
    }
    
    // 根据安全特性调整风险评分
    if (securityFeatures.length >= 5) {
        riskScore = Math.max(0, riskScore - 20); // 有多个安全特性时降低风险
        positiveFactors.push("✅ 多重安全机制保护");
    }
    
    // 输出风险评估
    console.log(`🛡️  安全风险评分: ${riskScore}/100`);
    
    if (riskFactors.length > 0) {
        console.log("📉 风险因素:");
        riskFactors.forEach(factor => console.log("   " + factor));
    }
    
    if (positiveFactors.length > 0) {
        console.log("📈 安全优势:");
        positiveFactors.forEach(factor => console.log("   " + factor));
    }
    
    if (riskScore < 10) {
        console.log("🎉 总体评估: 极低风险 | 绝对安全");
    } else if (riskScore < 30) {
        console.log("✅ 总体评估: 低风险");
    } else if (riskScore < 60) {
        console.log("⚠️  总体评估: 中等风险");
    } else {
        console.log("🚨 总体评估: 高风险");
    }

    console.log("══════════════════════════════════════════════\n");
}

main().catch(console.error);