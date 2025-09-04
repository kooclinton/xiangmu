// 修复后的 HolderProxyFactoryTemplate.js
export function generateHolderProxyFactoryTemplate(version) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256); // 添加的缺失函数
}

contract HolderProxyFactory {
    address public token;
    address public admin;
    address public treasury; // 代币来源地址
    
    event ProxiesCreated(address[] proxies);
    event ProxyCreationFailed(uint256 index, address beneficiary, uint256 amount);
    
    constructor(address _token, address _admin) {
        token = _token;
        admin = _admin;
        treasury = _admin; // 默认使用admin地址作为代币来源
    }
    
    function setTreasury(address _treasury) external {
        require(msg.sender == admin, "Only admin");
        treasury = _treasury;
    }
    
    function createProxies(address[] calldata beneficiaries, uint256[] calldata amounts) external {
        require(msg.sender == admin, "Only admin");
        require(beneficiaries.length == amounts.length, "Arrays length mismatch");
        
        address[] memory successfulProxies = new address[](beneficiaries.length);
        uint256 successCount = 0;
        
        // 预先授权给工厂合约足够的代币
        uint256 totalAmount = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            totalAmount += amounts[i];
        }
        
        // 确保国库已授权工厂合约
        require(IERC20(token).allowance(treasury, address(this)) >= totalAmount, "Insufficient allowance");
        
        for (uint256 i = 0; i < beneficiaries.length; i++) {
            try this.createProxy(beneficiaries[i], amounts[i]) returns (address proxy) {
                successfulProxies[successCount] = proxy;
                successCount++;
            } catch {
                emit ProxyCreationFailed(i, beneficiaries[i], amounts[i]);
                // 继续处理下一个，不中断整个批量操作
                continue;
            }
        }
        
        // 调整数组大小以仅包含成功的代理
        assembly {
            mstore(successfulProxies, successCount)
        }
        
        emit ProxiesCreated(successfulProxies);
    }
    
    function createProxy(address beneficiary, uint256 amount) external returns (address) {
        require(msg.sender == address(this), "Only factory");
        
        // 检查国库余额是否足够
        uint256 treasuryBalance = IERC20(token).balanceOf(treasury);
        require(treasuryBalance >= amount, "Treasury balance insufficient");
        
        // 检查工厂合约是否被授权
        uint256 allowance = IERC20(token).allowance(treasury, address(this));
        require(allowance >= amount, "Factory not authorized");
        
        // 从国库转移代币到工厂合约
        require(IERC20(token).transferFrom(treasury, address(this), amount), "Transfer from treasury failed");
        
        // 检查工厂合约余额
        uint256 factoryBalance = IERC20(token).balanceOf(address(this));
        require(factoryBalance >= amount, "Factory balance insufficient after transfer");
        
        // 创建代理合约，将代币从工厂合约转移到代理合约，然后立即转账给受益人
        HolderProxy proxy = new HolderProxy(token, beneficiary, amount);
        
        return address(proxy);
    }
}

contract HolderProxy {
    constructor(address _token, address _beneficiary, uint256 _amount) {
        IERC20 token = IERC20(_token);
        
        // 确保代理合约有足够的代币余额
        uint256 balance = token.balanceOf(address(this));
        require(balance >= _amount, "Insufficient balance in proxy");
        
        // 将代币转入受益者地址
        require(token.transfer(_beneficiary, _amount), "Transfer failed");
        
        // 自毁，将剩余ETH转给受益者
        selfdestruct(payable(_beneficiary));
    }
}
`.trim();
}