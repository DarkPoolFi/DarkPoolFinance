// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IStakedToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title DarkPoolStaking
/// @notice X3 fee share (plan.md X3): token holders stake and earn the ETH the fee router sends, pro rata to their stake
/// at the moment it arrives. Rewards that arrive while nothing is staked wait for the next distribution. Staking and
/// unstaking are immediate; earned ETH is kept across both until claimed.
contract DarkPoolStaking {
    uint256 internal constant PRECISION = 1e18;

    IStakedToken public immutable token;
    uint256 public totalStaked;
    uint256 public accRewardPerToken; // wei per staked token unit, × PRECISION
    uint256 public undistributed; // wei that arrived while nothing was staked
    mapping(address staker => uint256) public staked;
    mapping(address staker => uint256) public rewardDebt; // staked × accRewardPerToken / PRECISION at the last update
    mapping(address staker => uint256) public earned; // settled and not yet claimed

    bool private transient entered;

    event Staked(address indexed staker, uint256 amount);
    event Unstaked(address indexed staker, uint256 amount);
    event RewardNotified(uint256 amount, uint256 accRewardPerToken);
    event Claimed(address indexed staker, uint256 amount);

    error ZeroAmount();
    error InsufficientStake();
    error TransferFailed();
    error Reentrancy();

    constructor(IStakedToken token_) {
        token = token_;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    /// @notice Distributes msg.value (plus anything waiting) to current stakers. Permissionless.
    function notifyReward() external payable nonReentrant {
        uint256 amount = msg.value + undistributed;
        if (amount == 0) return;
        if (totalStaked == 0) {
            undistributed = amount;
        } else {
            undistributed = 0;
            accRewardPerToken += amount * PRECISION / totalStaked;
        }
        emit RewardNotified(amount, accRewardPerToken);
    }

    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
        if (token.balanceOf(address(this)) - before != amount) revert TransferFailed();
        staked[msg.sender] += amount;
        totalStaked += amount;
        rewardDebt[msg.sender] = staked[msg.sender] * accRewardPerToken / PRECISION;
        emit Staked(msg.sender, amount);
    }

    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (staked[msg.sender] < amount) revert InsufficientStake();
        _settle(msg.sender);
        staked[msg.sender] -= amount;
        totalStaked -= amount;
        rewardDebt[msg.sender] = staked[msg.sender] * accRewardPerToken / PRECISION;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Unstaked(msg.sender, amount);
    }

    function claim() external nonReentrant returns (uint256 amount) {
        _settle(msg.sender);
        rewardDebt[msg.sender] = staked[msg.sender] * accRewardPerToken / PRECISION;
        amount = earned[msg.sender];
        earned[msg.sender] = 0;
        if (amount != 0) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert TransferFailed();
        }
        emit Claimed(msg.sender, amount);
    }

    function claimable(address staker) external view returns (uint256) {
        return earned[staker] + staked[staker] * accRewardPerToken / PRECISION - rewardDebt[staker];
    }

    function _settle(address staker) private {
        earned[staker] += staked[staker] * accRewardPerToken / PRECISION - rewardDebt[staker];
    }
}
