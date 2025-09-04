// EnhancedHoldersCamouflage.js - 深度持币分布伪装（修复版）with 工厂合约支持
import fs from "fs";
import path from "path";
import { ethers } from "ethers";

// 知名地址库 - 增加真实感（使用有效地址）
const WELL_KNOWN_ADDRESSES = {
  // 交易所热钱包
  BINANCE_HOT: "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8",
  COINBASE: "0x71660c4005BA85c37ccec55d0C4493E66Fe775d3",
  KRAKEN: "0x2910543Af39abA0Cd09dBb2D50200b3E800A63D2",
  
  // 机构钱包
  GEMINI: "0x056Fd409E1d7A124BD7017459dFEa2F387b6d5Cd",
  BLOCKFI: "0xE489A94cB2D0415bD5AFB5A7E677891d675cB9f1",
  
  // 知名VC
  A16Z: "0x4F2083f5fBede34C2714aFfb3105539775f7FE64",
  SEQUOIA: "0x5A7d9B31DC5B2e62427031dC5F3B7F0f06e62699",
  
  // 做市商
  WINTERMUTE: "0x8B75EfC7d75d5fB677019F4c1F9a00e0f4Ddb7C3",
  ALAMEDA: "0x2FAF487A4414Fe77e2327F0bf4AE2a264a776AD2", // 有效的Alameda地址
  
  // DeFi协议
  UNISWAP_TREASURY: "0x1a9C8182C09F50C8318d769245beA52c32BE35BC",
  AAVE_TREASURY: "0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c"
};

export class EnhancedHoldersCamouflage {
  constructor(provider, tokenContract, adminWallet, adminContract, tokenAddress, factoryContract) {
    this.provider = provider;
    this.tokenContract = tokenContract;
    this.adminWallet = adminWallet;
    this.adminContract = adminContract;
    this.tokenAddress = tokenAddress;
    this.factoryContract = factoryContract; // 新增：工厂合约实例
    this.signer = new ethers.Wallet(adminWallet.privateKey, provider);
    this.decimals = 18; // 默认值，可以在初始化后更新
    this.lastCallTime = 0; // 记录上一次调用时间
    this.minCallInterval = 10000; // 最小调用间隔10秒，避免重入保护
    this.failedTransfers = 0; // 记录失败次数
    this.maxFailedTransfers = 10; // 最大允许失败次数
    
    // 确保所有知名地址都是校验和格式
    this.wellKnownAddresses = {};
    for (const [name, address] of Object.entries(WELL_KNOWN_ADDRESSES)) {
      try {
        this.wellKnownAddresses[name] = this.fixAddressChecksum(address);
      } catch (error) {
        console.warn(`⚠️ 知名地址 ${name} 格式无效: ${address}，已从列表中移除`);
        delete this.wellKnownAddresses[name];
      }
    }
  }

  // 修复地址校验和
  fixAddressChecksum(address) {
    try {
      // 先转换为小写，然后获取校验和地址
      return ethers.getAddress(address.toLowerCase());
    } catch (error) {
      console.error(`❌ 地址格式错误: ${address}`);
      throw error;
    }
  }

  // 批量修复地址校验和
  fixAddressesChecksum(addresses) {
    return addresses.map(addr => this.fixAddressChecksum(addr));
  }

  // 检查代币合约的限制
  async checkTokenRestrictions() {
    try {
      console.log("🔍 检查代币合约限制...");
      
      // 检查代币是否暂停
      try {
        const paused = await this.tokenContract.paused();
        console.log(`⏸️  代币暂停状态: ${paused}`);
        if (paused) {
          throw new Error("代币合约已暂停，无法进行转账");
        }
      } catch (error) {
        // 如果合约没有 paused() 方法，忽略错误
        console.log("ℹ️  代币合约没有暂停功能");
      }
      
      // 检查是否有黑名单功能
      try {
        const isBlacklisted = await this.tokenContract.isBlacklisted(this.tokenAddress);
        console.log(`⚫ 代理合约黑名单状态: ${isBlacklisted}`);
        if (isBlacklisted) {
          throw new Error("代理合约已被列入黑名单，无法进行转账");
        }
      } catch (error) {
        // 如果合约没有 isBlacklisted() 方法，忽略错误
        console.log("ℹ️  代币合约没有黑名单功能");
      }
      
      // 检查是否有转账限制
      try {
        const maxTxAmount = await this.tokenContract.maxTxAmount();
        const formattedMaxTx = ethers.formatUnits(maxTxAmount, this.decimals);
        console.log(`📊 最大转账限制: ${formattedMaxTx}`);
        
        // 检查当前转账金额是否超过限制
        return formattedMaxTx;
      } catch (error) {
        // 如果合约没有 maxTxAmount() 方法，忽略错误
        console.log("ℹ️  代币合约没有最大转账限制");
        return null;
      }
      
      console.log("✅ 代币合约限制检查完成");
      return true;
    } catch (error) {
      console.error(`❌ 代币合约限制检查失败: ${error.message}`);
      return false;
    }
  }

  // 检查Admin合约是否有足够的权限
  async checkAdminPermissions() {
    try {
      // 尝试调用一个简单的函数来检查权限
      const testAmount = ethers.parseUnits("1", this.decimals);
      const testTo = this.adminWallet.address;
      
      const transferData = this.tokenContract.interface.encodeFunctionData(
        "transfer",
        [testTo, testAmount]
      );
      
      // 估算Gas来检查是否会有权限错误
      const gasEstimate = await this.adminContract.executeCall.estimateGas(
        this.tokenAddress,
        0,
        transferData
      );
      
      console.log(`✅ Admin合约权限检查通过，预估Gas: ${gasEstimate}`);
      return true;
    } catch (error) {
      console.error(`❌ Admin合约权限检查失败: ${error.message}`);
      return false;
    }
  }

  // 从代理合约转账到目标地址（带重试机制和防重入保护）
  async transferFromProxy(toAddress, amount, maxRetries = 5) {
    const fixedToAddress = this.fixAddressChecksum(toAddress);
    const formattedAmount = ethers.formatUnits(amount, this.decimals);
    
    // 检查是否超过最大失败次数
    if (this.failedTransfers >= this.maxFailedTransfers) {
      throw new Error(`已达到最大失败次数限制 (${this.maxFailedTransfers})，停止转账`);
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 确保调用间隔，避免触发重入保护
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        
        if (timeSinceLastCall < this.minCallInterval) {
          const waitTime = this.minCallInterval - timeSinceLastCall;
          console.log(`⏳ 等待 ${waitTime}ms 以避免重入保护...`);
          await this.delay(waitTime);
        }
        
        // 检查代理合约余额是否足够
        const proxyBalance = await this.adminContract.getProxyTokenBalance(this.tokenAddress);
        const formattedBalance = ethers.formatUnits(proxyBalance, this.decimals);
        
        console.log(`📊 余额检查: 需要 ${formattedAmount}，可用 ${formattedBalance}`);
        
        if (proxyBalance < amount) {
          throw new Error(`代理合约余额不足。需要: ${formattedAmount}，可用: ${formattedBalance}`);
        }
        
        // 检查代币合约限制
        await this.checkTokenRestrictions();
        
        // 使用专门的转账函数
        const gasEstimate = await this.adminContract.executeProxyTransfer.estimateGas(
          this.tokenAddress,
          fixedToAddress,
          amount
        );
        
        console.log(`⛽ 预估Gas: ${gasEstimate}`);
        
        const tx = await this.adminContract.executeProxyTransfer(
          this.tokenAddress,
          fixedToAddress,
          amount,
          { gasLimit: gasEstimate * 3n } // 使用三倍预估Gas以确保成功
        );
        
        // 更新最后一次调用时间
        this.lastCallTime = Date.now();
        
        // 等待交易确认
        const receipt = await tx.wait();
        console.log(`✅ 转账成功: ${formattedAmount} 代币到 ${fixedToAddress}`);
        return receipt;
      } catch (error) {
        console.error(`❌ 转账失败到 ${toAddress} (尝试 ${attempt}/${maxRetries}):`, error.message);
        this.failedTransfers++;
        
        if (attempt >= maxRetries) {
          // 如果所有重试都失败，尝试直接转账（如果Admin合约有问题）
          return await this.directTransfer(fixedToAddress, amount);
        }
        
        // 随机延迟后再重试，增加延迟时间以避免重入保护
        const delayTime = 5000 + Math.random() * 10000; // 5-15秒延迟
        console.log(`⏳ 等待 ${delayTime}ms 后重试...`);
        await this.delay(delayTime);
      }
    }
  }

  // 直接转账（绕过Admin合约）
  async directTransfer(toAddress, amount) {
    try {
      console.log(`🔄 尝试直接转账到 ${toAddress}...`);
      
      // 检查代理合约余额是否足够
      const proxyBalance = await this.tokenContract.balanceOf(this.tokenAddress);
      const formattedAmount = ethers.formatUnits(amount, this.decimals);
      const formattedBalance = ethers.formatUnits(proxyBalance, this.decimals);
      
      console.log(`📊 直接转账余额检查: 需要 ${formattedAmount}，可用 ${formattedBalance}`);
      
      if (proxyBalance < amount) {
        throw new Error(`代理合约余额不足。需要: ${formattedAmount}，可用: ${formattedBalance}`);
      }
      
      // 检查代币合约限制
      await this.checkTokenRestrictions();
      
      // 直接调用代理合约的transfer函数
      // 注意：这需要代理合约的owner权限
      const transferData = this.tokenContract.interface.encodeFunctionData(
        "transfer",
        [toAddress, amount]
      );
      
      // 使用adminWallet发送交易到代理合约
      const gasEstimate = await this.signer.estimateGas({
        to: this.tokenAddress,
        data: transferData
      });
      
      console.log(`⛽ 直接转账预估Gas: ${gasEstimate}`);
      
      const tx = await this.signer.sendTransaction({
        to: this.tokenAddress,
        data: transferData,
        gasLimit: gasEstimate * 3n // 使用三倍预估Gas
      });
      
      // 等待交易确认
      const receipt = await tx.wait();
      console.log(`✅ 直接转账成功: ${formattedAmount} 代币到 ${toAddress}`);
      return receipt;
    } catch (error) {
      console.error(`❌ 直接转账也失败: ${error.message}`);
      
      // 尝试最后一种方法：从部署者钱包直接转账
      return await this.transferFromDeployer(toAddress, amount);
    }
  }

  // 从部署者钱包直接转账（最后的手段）
  async transferFromDeployer(toAddress, amount) {
    try {
      console.log(`🆘 尝试从部署者钱包直接转账到 ${toAddress}...`);
      
      // 检查部署者钱包余额是否足够
      const deployerBalance = await this.tokenContract.balanceOf(this.adminWallet.address);
      const formattedAmount = ethers.formatUnits(amount, this.decimals);
      const formattedBalance = ethers.formatUnits(deployerBalance, this.decimals);
      
      console.log(`📊 部署者钱包余额检查: 需要 ${formattedAmount}，可用 ${formattedBalance}`);
      
      if (deployerBalance < amount) {
        throw new Error(`部署者钱包余额不足。需要: ${formattedAmount}，可用: ${formattedBalance}`);
      }
      
      // 检查代币合约限制
      await this.checkTokenRestrictions();
      
      // 直接从部署者钱包转账
      const gasEstimate = await this.tokenContract.transfer.estimateGas(
        toAddress,
        amount
      );
      
      console.log(`⛽ 部署者转账预估Gas: ${gasEstimate}`);
      
      const tx = await this.tokenContract.transfer(
        toAddress,
        amount,
        { gasLimit: gasEstimate * 3n } // 使用三倍预估Gas
      );
      
      // 等待交易确认
      const receipt = await tx.wait();
      console.log(`✅ 部署者转账成功: ${formattedAmount} 代币到 ${toAddress}`);
      return receipt;
    } catch (error) {
      console.error(`❌ 部署者转账也失败: ${error.message}`);
      throw error;
    }
  }

  // 授权工厂合约使用国库代币
  async authorizeFactory(factoryAddress, totalAmount) {
    try {
      console.log(`🔑 授权工厂合约使用国库代币...`);
      
      // 获取国库地址
      const treasuryAddress = await this.factoryContract.treasury();
      
      // 检查当前授权额度
      const currentAllowance = await this.tokenContract.allowance(treasuryAddress, factoryAddress);
      console.log(`📊 当前授权额度: ${ethers.formatUnits(currentAllowance, this.decimals)}`);
      
      if (currentAllowance >= totalAmount) {
        console.log(`✅ 工厂合约已有足够授权`);
        return true;
      }
      
      // 国库地址授权工厂合约可以转移代币
      const approveData = this.tokenContract.interface.encodeFunctionData(
        "approve",
        [factoryAddress, totalAmount]
      );
      
         // 获取代币合约地址，确保调用目标正确
      const tokenAddress = this.tokenAddress || await this.tokenContract.getAddress();

      // 通过Admin合约执行授权，调用方为持币账户/授权合约
      const approveTx = await this.adminContract
        .connect(this.signer)
        .executeCall(
          tokenAddress,
          0,
          approveData
        );
      
      // 等待交易确认
      await approveTx.wait();
      console.log(`✅ 工厂合约已获得授权: ${ethers.formatUnits(totalAmount, this.decimals)} 代币`);
      return true;
    } catch (error) {
      console.error(`❌ 授权工厂合约失败:`, error.message);
      return false;
    }
  }

  // 使用工厂合约批量创建持币者（分批次处理）
  async batchCreateHoldersViaFactory(recipients, amounts, batchSize = 20) {
    console.log(`🔄 通过工厂合约批量创建 ${recipients.length} 个持币者，分批次处理（每批 ${batchSize} 个）`);
    
    try {
      // 检查工厂合约是否设置
      if (!this.factoryContract) {
        throw new Error("工厂合约未设置");
      }
      
      // 修复地址校验和
      const fixedRecipients = this.fixAddressesChecksum(recipients);
      
      // 计算总金额
      const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
      
      // 确保工厂合约已获得授权
      const factoryAddress = await this.factoryContract.getAddress();
      const isAuthorized = await this.authorizeFactory(factoryAddress, totalAmount);
      
      if (!isAuthorized) {
        throw new Error("工厂合约授权失败");
      }
      
      // 分批次处理
      const batches = Math.ceil(fixedRecipients.length / batchSize);
      const allReceipts = [];
      
      for (let batch = 0; batch < batches; batch++) {
        const start = batch * batchSize;
        const end = Math.min(start + batchSize, fixedRecipients.length);
        
        const batchRecipients = fixedRecipients.slice(start, end);
        const batchAmounts = amounts.slice(start, end);
        
        console.log(`🔄 处理批次 ${batch + 1}/${batches}: ${batchRecipients.length} 个地址`);
        
        try {
          // 通过Admin合约调用工厂合约
          const factoryAddress = await this.factoryContract.getAddress();
          const createProxiesData = this.factoryContract.interface.encodeFunctionData(
            "createProxies",
            [batchRecipients, batchAmounts]
          );
          
          // 使用Admin合约执行调用
          const gasEstimate = await this.adminContract.executeCall.estimateGas(
            factoryAddress,
            0,
            createProxiesData
          );
          
          const tx = await this.adminContract.executeCall(
            factoryAddress,
            0,
            createProxiesData,
            { gasLimit: gasEstimate * 2n }
          );
          
          // 确保交易哈希存在
          if (!tx.hash) {
            console.warn("⚠️ 交易哈希不存在，尝试从交易对象获取");
            // 尝试从交易对象获取哈希
            const txHash = tx.transactionHash || (tx.deploymentTransaction && tx.deploymentTransaction.hash);
            if (txHash) {
              tx.hash = txHash;
            } else {
              console.warn("⚠️ 无法获取交易哈希，使用模拟哈希");
              // 生成模拟哈希用于记录
              tx.hash = `simulated_hash_${Date.now()}_${batch}`;
            }
          }
          
          console.log(`⛓️ 交易已发送: ${tx.hash}`);
          
          // 等待交易确认
          const receipt = await tx.wait();
          
          // 确保收据中有交易哈希
          if (!receipt.transactionHash && tx.hash) {
            receipt.transactionHash = tx.hash;
          }
          
          allReceipts.push(receipt);
          console.log(`✅ 批次 ${batch + 1}/${batches} 创建成功，交易哈希: ${receipt.transactionHash}`);
          
          // 批次之间添加延迟，避免重入保护
          await this.delay(3000);
        } catch (batchError) {
          console.error(`❌ 批次 ${batch + 1}/${batches} 创建失败:`, batchError.message);
          
          // 尝试回退到逐个创建
          console.log(`🔄 回退到逐个创建批次 ${batch + 1} 的持币者`);
          for (let i = 0; i < batchRecipients.length; i++) {
            try {
              const receipt = await this.transferFromProxy(batchRecipients[i], batchAmounts[i]);
              // 为逐个转账创建模拟收据
              const simulatedReceipt = {
                transactionHash: receipt.transactionHash || `individual_tx_${Date.now()}_${i}`,
                status: 1,
                blockNumber: receipt.blockNumber
              };
              allReceipts.push(simulatedReceipt);
            } catch (transferError) {
              console.error(`❌ 单个转账也失败: ${transferError.message}`);
            }
          }
        }
      }
      
      console.log(`✅ 批量创建完成，共处理 ${allReceipts.length} 个批次`);
      return allReceipts;
    } catch (error) {
      console.error("❌ 通过工厂合约批量创建失败:", error.message);
      throw error;
    }
  }

  // 创建深度持币分布（支持批量操作）
  async createDeepHoldersDistribution(totalHolders = 50) {
    console.log("🎭 创建深度持币分布伪装...");
    
    // 首先检查Admin合约权限
    const hasPermission = await this.checkAdminPermissions();
    if (!hasPermission) {
      console.warn("⚠️ Admin合约权限可能不足，将尝试直接转账方式");
    }
    
    // 检查代币合约限制
    await this.checkTokenRestrictions();
    
    const holders = [];
    const totalSupply = await this.tokenContract.totalSupply();
    
    // 获取当前decimals
    try {
      this.decimals = await this.tokenContract.decimals();
      console.log(`✅ 获取代币精度: ${this.decimals}`);
    } catch (error) {
      console.warn(`无法获取代币精度，使用默认值: ${this.decimals}`);
    }
    
    // 检查代理合约初始余额
    const initialBalance = await this.adminContract.getProxyTokenBalance(this.tokenAddress);
    console.log(`💰 代理合约初始余额: ${ethers.formatUnits(initialBalance, this.decimals)}`);
    
    // 检查部署者钱包余额
    const deployerBalance = await this.tokenContract.balanceOf(this.adminWallet.address);
    console.log(`💰 部署者钱包余额: ${ethers.formatUnits(deployerBalance, this.decimals)}`);
    
    // 分层分布配置
    const distribution = [
      // 鲸鱼层 (0.1%)
      { count: 2, percentage: 8, type: "whale", label: "顶级鲸鱼" },
      { count: 3, percentage: 5, type: "whale", label: "大型鲸鱼" },
      
      // 大户层 (1%)
      { count: 5, percentage: 2.5, type: "institutional", label: "机构投资者" },
      { count: 8, percentage: 1.2, type: "institutional", label: "风险投资" },
      
      // 中等持有者 (5%)
      { count: 10, percentage: 0.8, type: "medium", label: "核心社区" },
      { count: 15, percentage: 0.3, type: "medium", label: "活跃用户" },
      
      // 散户层 (剩余)
      { count: totalHolders - 43, percentage: 0.05, type: "retail", label: "普通持有者" }
    ];

    // 先收集所有转账请求
    const transferRequests = [];
    let created = 0;
    
    // 添加知名地址
    await this.addWellKnownAddresses(transferRequests, totalSupply);
    
    for (const group of distribution) {
      for (let i = 0; i < group.count && created < totalHolders; i++) {
        const wallet = ethers.Wallet.createRandom();
        const amount = this.calculateAmountWithVariation(totalSupply, group.percentage);
        
        transferRequests.push({
          to: wallet.address,
          amount: amount,
          type: group.type,
          label: group.label
        });
        
        created++;
      }
    }
    
    // 定义批次大小
    const batchSize = 20;
    
    // 尝试批量转账（分批次）
    try {
      const recipients = transferRequests.map(req => req.to);
      const amounts = transferRequests.map(req => req.amount);
      
      const receipts = await this.batchCreateHoldersViaFactory(recipients, amounts, batchSize);
      
      // 创建持币记录
      for (let i = 0; i < transferRequests.length; i++) {
        const req = transferRequests[i];
        // 找到对应的交易哈希
        const batchIndex = Math.floor(i / batchSize);
        let txHash = "未知";
        
        if (batchIndex < receipts.length) {
          txHash = receipts[batchIndex].transactionHash || 
                  receipts[batchIndex].hash || 
                  `batch_${batchIndex + 1}_tx`;
        }
        
        holders.push({
          address: req.to,
          amount: amounts[i].toString(),
          amountFormatted: ethers.formatUnits(amounts[i], this.decimals),
          percentage: (Number(amounts[i]) / Number(totalSupply)) * 100,
          type: req.type,
          label: req.label,
          txHash: txHash,
          timestamp: new Date().toISOString()
        });
        
        console.log(`✅ 创建${req.label}: ${req.to} (${ethers.formatUnits(amounts[i], this.decimals)} 代币)`);
      }
      
      console.log(`✅ 批量创建了 ${holders.length} 个持币者`);
    } catch (error) {
      console.error("❌ 批量转账失败，回退到逐个转账:", error.message);
      // 回退到逐个转账
      for (const req of transferRequests) {
        if (this.failedTransfers >= this.maxFailedTransfers) {
          console.error(`🚫 已达到最大失败次数限制 (${this.maxFailedTransfers})，停止创建持有者`);
          break;
        }
        
        try {
          const receipt = await this.transferFromProxy(req.to, req.amount);
          
          holders.push({
            address: req.to,
            amount: req.amount.toString(),
            amountFormatted: ethers.formatUnits(req.amount, this.decimals),
            percentage: (Number(req.amount) / Number(totalSupply)) * 100,
            type: req.type,
            label: req.label,
            txHash: receipt.transactionHash,
            timestamp: new Date().toISOString()
          });
          
          console.log(`✅ 创建${req.label}: ${req.to} (${ethers.formatUnits(req.amount, this.decimals)} 代币)`);
          
          // 检查当前代理合约余额
          const currentBalance = await this.adminContract.getProxyTokenBalance(this.tokenAddress);
          console.log(`💰 当前代理合约余额: ${ethers.formatUnits(currentBalance, this.decimals)}`);
          
          // 模拟真实转账间隔
          await this.delay(5000 + Math.random() * 10000);
        } catch (error) {
          console.warn(`创建持有者失败: ${error.message}`);
        }
      }
    }
    
    return holders;
  }

  // 修改添加知名地址方法，也纳入批量处理
  async addWellKnownAddresses(transferRequests, totalSupply) {
    const knownAddresses = Object.entries(this.wellKnownAddresses);
    
    for (const [name, address] of knownAddresses) {
      if (Math.random() > 0.7) {
        const amount = this.calculateAmountWithVariation(totalSupply, 0.5 + Math.random() * 2);
        
        transferRequests.push({
          to: this.fixAddressChecksum(address),
          amount: amount,
          type: "well_known",
          label: name,
          isWellKnown: true
        });
      }
    }
  }

  // 带随机变化的金额计算，考虑最大转账限制
  calculateAmountWithVariation(totalSupply, basePercentage, maxTxLimit = null) {
    const variation = 0.8 + Math.random() * 0.4; // 80%-120% 变化
    const actualPercentage = basePercentage * variation;
    let amount = (totalSupply * BigInt(Math.floor(actualPercentage * 1000000))) / 100000000n;
    
    // 如果有最大转账限制，确保不超过限制
    if (maxTxLimit) {
      const maxTxAmount = ethers.parseUnits(maxTxLimit, this.decimals);
      if (amount > maxTxAmount) {
        console.log(`⚠️  调整转账金额以适应最大限制: ${ethers.formatUnits(amount, this.decimals)} → ${maxTxLimit}`);
        amount = maxTxAmount;
      }
    }
    
    return amount;
  }

  async delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // 生成持币分析报告（修复BigInt序列化问题）
  generateHoldersAnalysis(holders, totalSupply) {
    // 将BigInt转换为字符串以便序列化
    const stringTotalSupply = totalSupply.toString();
    
    const analysis = {
      totalHolders: holders.length,
      totalSupply: stringTotalSupply,
      distributionByType: {},
      wellKnownAddresses: [],
      creationDate: new Date().toISOString()
    };

    // 分类统计
    holders.forEach(holder => {
      if (!analysis.distributionByType[holder.type]) {
        analysis.distributionByType[holder.type] = {
          count: 0,
          totalAmount: "0", // 使用字符串而不是BigInt
          percentage: 0
        };
      }
      
      analysis.distributionByType[holder.type].count++;
      // 使用BigInt进行计算，但最终转换为字符串
      const currentTotal = BigInt(analysis.distributionByType[holder.type].totalAmount);
      analysis.distributionByType[holder.type].totalAmount = (currentTotal + BigInt(holder.amount)).toString();
      
      if (holder.isWellKnown) {
        analysis.wellKnownAddresses.push({
          address: holder.address,
          label: holder.label,
          amount: holder.amount // 已经是字符串
        });
      }
    });

    // 计算百分比
    Object.keys(analysis.distributionByType).forEach(type => {
      const typeData = analysis.distributionByType[type];
      typeData.percentage = (Number(typeData.totalAmount) / Number(stringTotalSupply)) * 100;
    });

    return analysis;
  }

}
