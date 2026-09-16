// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IStakingRewards {
    function notifyReward() external payable;
}

/// @title DarkPoolFeeRouter
/// @notice X3 fee switch (plan.md X3): the settlement fee sweep pays venue fees here instead of straight to the pool
/// operator. `distribute` sends feeSwitchBps of the balance to stakers and the rest to the treasury (the operator, which
/// pays for tree batches, seals and settlements). The switch is off until the owner (the timelock) turns it on.
contract DarkPoolFeeRouter {
    uint16 public constant MAX_FEE_SWITCH_BPS = 5000;

    address public owner;
    address public pendingOwner;
    address public treasury;
    IStakingRewards public staking; // 0 while the switch is off
    uint16 public feeSwitchBps;

    bool private transient entered;

    event Distributed(uint256 toStakers, uint256 toTreasury);
    event FeeSwitchSet(address staking, uint16 feeSwitchBps);
    event TreasurySet(address treasury);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error TooHigh();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, address treasury_) {
        if (owner_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        owner = owner_;
        treasury = treasury_;
        emit OwnershipTransferred(address(0), owner_);
        emit TreasurySet(treasury_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    receive() external payable {}

    /// @notice Splits the router's whole balance between stakers and the treasury. Permissionless.
    function distribute() external nonReentrant returns (uint256 toStakers, uint256 toTreasury) {
        uint256 balance = address(this).balance;
        if (balance == 0) return (0, 0);
        toStakers = address(staking) == address(0) ? 0 : balance * feeSwitchBps / 10_000;
        toTreasury = balance - toStakers;
        if (toStakers != 0) staking.notifyReward{value: toStakers}();
        if (toTreasury != 0) {
            (bool ok,) = treasury.call{value: toTreasury}("");
            if (!ok) revert TransferFailed();
        }
        emit Distributed(toStakers, toTreasury);
    }

    function setFeeSwitch(IStakingRewards staking_, uint16 feeSwitchBps_) external onlyOwner {
        if (feeSwitchBps_ > MAX_FEE_SWITCH_BPS) revert TooHigh();
        if (feeSwitchBps_ != 0 && address(staking_) == address(0)) revert ZeroAddress();
        staking = staking_;
        feeSwitchBps = feeSwitchBps_;
        emit FeeSwitchSet(address(staking_), feeSwitchBps_);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
