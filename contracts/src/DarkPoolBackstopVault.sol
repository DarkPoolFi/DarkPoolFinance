// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IChainlinkPrice {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
    function approve(address spender, uint256 amount) external returns (bool);
}

/// Uniswap SwapRouter02 (no deadline field).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title DarkPoolBackstopVault
/// @notice X2 backstop (plan.md X2): liquidity providers put ETH and one stock token into a per-asset book; after a
/// window's uniform cross the pool fills leftover interest against it at ref ± spreadBps (cross.ts rule 7).
///   deposit   — adds ETH and/or tokens, minting shares at the Chainlink value of what was added against the book's value.
///   withdraw  — burns shares for the same fraction of the book's ETH and tokens (no price involved).
///   offer     — what the pool may use in a window: capped inventory and the published spread.
///   exchange  — pool only: the settled backstop leg (tokens sold to buyers, ETH in; tokens bought from sellers, ETH out).
///   rebalance — rebalancer only: swaps inventory on Uniswap v3 with a minimum output from Chainlink less maxSlippageBps
///               and at most maxRebalanceBps of the book's value per call, so a leaked rebalancer key cannot dump it.
/// Only the vault ever trades on the AMM, never user orders.
contract DarkPoolBackstopVault {
    struct Book {
        address token;
        address feed; // token/USD, 8 decimals
        uint16 spreadBps;
        uint24 poolFee; // Uniswap v3 fee tier for WETH/token; 0 = no rebalancing
        bool enabled;
        uint256 eth; // wei
        uint256 tokens; // base units
        uint256 shares;
        uint256 maxSellTokens; // per window
        uint256 maxBuyEth; // per window
    }

    uint256 public constant MAX_SPREAD_BPS = 200;
    uint256 public constant MAX_STALENESS = 90000; // as the pool
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MICRO_ETH = 1e12;

    ISwapRouter02 public immutable router;
    IWETH9 public immutable weth;
    IChainlinkPrice public immutable ethUsdFeed;

    address public owner;
    address public pendingOwner;
    address public pool; // settles backstop legs; set once
    address public rebalancer;
    uint16 public maxSlippageBps = 100;
    uint16 public maxRebalanceBps = 1000;
    mapping(address asset => Book) public books;
    mapping(address asset => mapping(address lp => uint256)) public sharesOf;

    bool private transient entered;

    event BookSet(address indexed asset, address feed, uint16 spreadBps, uint24 poolFee, bool enabled, uint256 maxSellTokens, uint256 maxBuyEth);
    event Deposited(address indexed asset, address indexed lp, uint256 eth, uint256 tokens, uint256 shares);
    event Withdrawn(address indexed asset, address indexed lp, uint256 eth, uint256 tokens, uint256 shares);
    event Exchanged(address indexed asset, uint256 tokensSold, uint256 ethIn, uint256 tokensBought, uint256 ethOut);
    event Rebalanced(address indexed asset, bool tokensForEth, uint256 amountIn, uint256 amountOut);
    event PoolSet(address pool);
    event RebalancerSet(address rebalancer, uint16 maxSlippageBps, uint16 maxRebalanceBps);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error NotPool();
    error NotRebalancer();
    error PoolAlreadySet();
    error BadBook();
    error BookDisabled();
    error BadPrice();
    error BadAmount();
    error NoShares();
    error Insufficient();
    error TooLarge();
    error ZeroAddress();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, ISwapRouter02 router_, IWETH9 weth_, IChainlinkPrice ethUsdFeed_) {
        if (owner_ == address(0) || address(weth_) == address(0) || address(ethUsdFeed_) == address(0)) revert ZeroAddress();
        owner = owner_;
        router = router_;
        weth = weth_;
        ethUsdFeed = ethUsdFeed_;
        emit OwnershipTransferred(address(0), owner_);
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

    receive() external payable {
        if (msg.sender != address(weth)) revert BadAmount(); // only unwrapping sends plain ETH
    }

    // --- liquidity providers ---------------------------------------------------

    /// @notice Add ETH (msg.value) and/or `tokens` of the asset. Shares are minted at the Chainlink value of the
    /// contribution relative to the book's value, so the price of a share does not move with the deposit.
    function deposit(address asset, uint256 tokens) external payable nonReentrant returns (uint256 minted) {
        Book storage b = books[asset];
        if (!b.enabled) revert BookDisabled();
        if (msg.value == 0 && tokens == 0) revert BadAmount();
        (uint256 tokenUsd, uint256 ethUsd) = _prices(b);
        uint256 added = msg.value + _tokensToWei(tokens, tokenUsd, ethUsd);
        if (b.shares == 0) {
            minted = added;
        } else {
            uint256 value = b.eth + _tokensToWei(b.tokens, tokenUsd, ethUsd);
            minted = added * b.shares / value;
        }
        if (minted == 0) revert BadAmount();
        if (tokens != 0) {
            uint256 before = _balanceOf(b.token);
            _call(b.token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), tokens));
            if (_balanceOf(b.token) - before != tokens) revert BadAmount();
        }
        b.eth += msg.value;
        b.tokens += tokens;
        b.shares += minted;
        sharesOf[asset][msg.sender] += minted;
        emit Deposited(asset, msg.sender, msg.value, tokens, minted);
    }

    /// @notice Burn `shares` for the same fraction of the book's ETH and tokens. Works while a book is disabled.
    function withdraw(address asset, uint256 shares) external nonReentrant returns (uint256 eth, uint256 tokens) {
        Book storage b = books[asset];
        if (shares == 0 || sharesOf[asset][msg.sender] < shares) revert NoShares();
        eth = b.eth * shares / b.shares;
        tokens = b.tokens * shares / b.shares;
        sharesOf[asset][msg.sender] -= shares;
        b.shares -= shares;
        b.eth -= eth;
        b.tokens -= tokens;
        if (tokens != 0) _call(b.token, abi.encodeWithSelector(0xa9059cbb, msg.sender, tokens));
        if (eth != 0) _sendEth(msg.sender, eth);
        emit Withdrawn(asset, msg.sender, eth, tokens, shares);
    }

    // --- venue -------------------------------------------------------------------

    /// @notice This window's backstop for `asset` in venue units: token micro-units the vault may sell, micro-ETH it
    /// may spend, and the spread. Zero inventory when the book is disabled.
    function offer(address asset, uint256 unit) external view returns (uint256 qty, uint256 ethMicro, uint16 spreadBps) {
        Book storage b = books[asset];
        if (!b.enabled || unit == 0) return (0, 0, b.spreadBps);
        qty = _min(b.tokens, b.maxSellTokens) / unit;
        ethMicro = _min(b.eth, b.maxBuyEth) / MICRO_ETH;
        spreadBps = b.spreadBps;
    }

    /// @notice Pool only: the backstop leg of a settled window. The pool pays `msg.value` (the buyers' ETH) and has
    /// approved `tokensBought`; the vault pays `tokensSold` and `ethOut` to the pool.
    function exchange(address asset, uint256 tokensSold, uint256 tokensBought, uint256 ethOut) external payable nonReentrant {
        if (msg.sender != pool) revert NotPool();
        Book storage b = books[asset];
        if (tokensSold > b.tokens || ethOut > b.eth + msg.value) revert Insufficient();
        if (tokensBought != 0) {
            uint256 before = _balanceOf(b.token);
            _call(b.token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), tokensBought));
            if (_balanceOf(b.token) - before != tokensBought) revert BadAmount();
        }
        b.tokens = b.tokens - tokensSold + tokensBought;
        b.eth = b.eth + msg.value - ethOut;
        if (tokensSold != 0) _call(b.token, abi.encodeWithSelector(0xa9059cbb, msg.sender, tokensSold));
        if (ethOut != 0) _sendEth(msg.sender, ethOut);
        emit Exchanged(asset, tokensSold, msg.value, tokensBought, ethOut);
    }

    // --- rebalancing -----------------------------------------------------------

    /// @notice Rebalancer only: swap `amountIn` of the book's tokens for ETH (`tokensForEth`) or ETH for tokens on the
    /// book's Uniswap v3 WETH pool, receiving at least the Chainlink value less maxSlippageBps.
    function rebalance(address asset, bool tokensForEth, uint256 amountIn) external nonReentrant returns (uint256 amountOut) {
        if (msg.sender != rebalancer) revert NotRebalancer();
        Book storage b = books[asset];
        if (!b.enabled || b.poolFee == 0) revert BookDisabled();
        if (amountIn == 0 || amountIn > (tokensForEth ? b.tokens : b.eth)) revert Insufficient();
        (uint256 tokenUsd, uint256 ethUsd) = _prices(b);
        uint256 inWei = tokensForEth ? _tokensToWei(amountIn, tokenUsd, ethUsd) : amountIn;
        uint256 value = b.eth + _tokensToWei(b.tokens, tokenUsd, ethUsd);
        if (inWei * BPS > value * maxRebalanceBps) revert TooLarge();
        uint256 fair = tokensForEth ? inWei : _weiToTokens(amountIn, tokenUsd, ethUsd);
        uint256 minOut = fair * (BPS - maxSlippageBps) / BPS;

        address tokenIn = tokensForEth ? b.token : address(weth);
        address tokenOut = tokensForEth ? address(weth) : b.token;
        if (!tokensForEth) weth.deposit{value: amountIn}();
        _call(tokenIn, abi.encodeWithSelector(0x095ea7b3, address(router), amountIn)); // approve
        amountOut = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: b.poolFee,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        if (amountOut < minOut) revert BadPrice();
        if (tokensForEth) {
            weth.withdraw(amountOut);
            b.tokens -= amountIn;
            b.eth += amountOut;
        } else {
            b.eth -= amountIn;
            b.tokens += amountOut;
        }
        emit Rebalanced(asset, tokensForEth, amountIn, amountOut);
    }

    /// Book value in wei at Chainlink prices (for share pricing off chain and the LP API).
    function bookValue(address asset) external view returns (uint256) {
        Book storage b = books[asset];
        (uint256 tokenUsd, uint256 ethUsd) = _prices(b);
        return b.eth + _tokensToWei(b.tokens, tokenUsd, ethUsd);
    }

    // --- owner -------------------------------------------------------------------

    function setBook(address asset, address feed, uint16 spreadBps, uint24 poolFee, bool enabled, uint256 maxSellTokens, uint256 maxBuyEth)
        external
        onlyOwner
    {
        Book storage b = books[asset];
        if (asset == address(0) || feed == address(0) || spreadBps > MAX_SPREAD_BPS) revert BadBook();
        if (b.token != address(0) && b.token != asset) revert BadBook();
        b.token = asset;
        b.feed = feed;
        b.spreadBps = spreadBps;
        b.poolFee = poolFee;
        b.enabled = enabled;
        b.maxSellTokens = maxSellTokens;
        b.maxBuyEth = maxBuyEth;
        emit BookSet(asset, feed, spreadBps, poolFee, enabled, maxSellTokens, maxBuyEth);
    }

    function setPool(address pool_) external onlyOwner {
        if (pool != address(0)) revert PoolAlreadySet();
        if (pool_ == address(0)) revert ZeroAddress();
        pool = pool_;
        emit PoolSet(pool_);
    }

    function setRebalancer(address rebalancer_, uint16 maxSlippageBps_, uint16 maxRebalanceBps_) external onlyOwner {
        if (maxSlippageBps_ > 500 || maxRebalanceBps_ > 5000) revert BadBook();
        rebalancer = rebalancer_;
        maxSlippageBps = maxSlippageBps_;
        maxRebalanceBps = maxRebalanceBps_;
        emit RebalancerSet(rebalancer_, maxSlippageBps_, maxRebalanceBps_);
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

    // --- internal ----------------------------------------------------------------

    function _prices(Book storage b) private view returns (uint256 tokenUsd, uint256 ethUsd) {
        tokenUsd = _price(IChainlinkPrice(b.feed));
        ethUsd = _price(ethUsdFeed);
    }

    function _price(IChainlinkPrice feed) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = feed.latestRoundData();
        if (answer <= 0 || updatedAt == 0 || block.timestamp - updatedAt > MAX_STALENESS) revert BadPrice();
        return uint256(answer);
    }

    /// Both feeds have 8 decimals and the tokens 18, like ETH, so the ratio converts directly.
    function _tokensToWei(uint256 tokens, uint256 tokenUsd, uint256 ethUsd) private pure returns (uint256) {
        return tokens * tokenUsd / ethUsd;
    }

    function _weiToTokens(uint256 amount, uint256 tokenUsd, uint256 ethUsd) private pure returns (uint256) {
        return amount * ethUsd / tokenUsd;
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// Tolerates tokens that return nothing; rejects false returns and non-contracts.
    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this)));
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
