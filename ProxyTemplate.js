// ProxyTemplate.js - v14.0.1-delayed-init with direct transfer
export function generateProxyTemplate(name, version) {
  return `// SPDX-License-Identifier: MIT
pragma solidity ^${version};

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract ${name} {
    bytes32 private constant _IMPLEMENTATION_SLOT = 
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant _ADMIN_SLOT =
        0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    bytes32 private constant _INITIALIZED_SLOT =
        0x834223b8ee90cc5fb7729a9d7b48bc82b9b229a6a894d2d8bd3db2a184374f2b;

    event Upgraded(address indexed implementation);
    event AdminChanged(address indexed previousAdmin, address indexed newAdmin);
    event Initialized(uint8 version);
    event TokenApproved(address indexed token, address indexed spender, uint256 amount);
    event DirectTransfer(address indexed token, address indexed to, uint256 amount);

    constructor(address logic, address admin) payable {
        require(logic != address(0), "Invalid logic");
        require(admin != address(0), "Invalid admin");

        assembly {
            sstore(_IMPLEMENTATION_SLOT, logic)
            sstore(_ADMIN_SLOT, admin)
            sstore(_INITIALIZED_SLOT, 0)
        }
    }

    modifier onlyAdmin() {
        require(msg.sender == _getAdmin(), "Not admin");
        _;
    }

    function initializeProxy(bytes calldata initData) external onlyAdmin {
        require(!isInitialized(), "Already initialized");
        require(initData.length > 0, "Empty init data");
        
        address impl = _getImplementation();
        require(impl != address(0), "Implementation not set");

        assembly {
            sstore(_INITIALIZED_SLOT, 1)
        }

        (bool success, ) = impl.delegatecall(initData);
        require(success, "Initialization failed");

        emit Initialized(1);
    }

    function isInitialized() public view returns (bool) {
        uint256 initialized;
        assembly {
            initialized := sload(_INITIALIZED_SLOT)
        }
        return initialized == 1;
    }

    function approveToken(address token, address spender, uint256 amount) external onlyAdmin returns (bool) {
        bool success = IERC20(token).approve(spender, amount);
        require(success, "Token approval failed");
        emit TokenApproved(token, spender, amount);
        return success;
    }

    // 新增：直接转账功能
    function directTransfer(address token, address to, uint256 amount) external onlyAdmin returns (bool) {
        require(token != address(0), "Invalid token address");
        require(to != address(0), "Invalid recipient");
        require(amount > 0, "Invalid amount");
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        require(balance >= amount, "Insufficient balance");
        
        bool success = IERC20(token).transfer(to, amount);
        require(success, "Transfer failed");
        
        emit DirectTransfer(token, to, amount);
        return success;
    }

    // 新增：代币余额查询功能
    function getTokenBalance(address token) external view returns (uint256) {
        return IERC20(token).balanceOf(address(this));
    }

    function upgradeTo(address newImpl) external onlyAdmin {
        require(newImpl.code.length > 0, "Invalid code");
        assembly {
            sstore(_IMPLEMENTATION_SLOT, newImpl)
        }
        emit Upgraded(newImpl);
    }

    function changeAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Admin zero address");
        emit AdminChanged(_getAdmin(), newAdmin);
        assembly {
            sstore(_ADMIN_SLOT, newAdmin)
        }
    }

    function getImplementation() external view returns (address) {
        return _getImplementation();
    }

    function getAdmin() external view returns (address) {
        return _getAdmin();
    }

    function _getImplementation() private view returns (address impl) {
        assembly {
            impl := sload(_IMPLEMENTATION_SLOT)
        }
    }

    function _getAdmin() private view returns (address adm) {
        assembly {
            adm := sload(_ADMIN_SLOT)
        }
    }

    fallback() external payable {
        address impl = _getImplementation();
        require(impl != address(0), "Implementation not set");

        assembly {
            calldatacopy(0, 0, calldatasize())
            let result := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch result
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
`.trim();
}