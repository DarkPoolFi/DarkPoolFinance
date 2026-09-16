// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DarkPoolVault
/// @notice X0 custody for stock tokens (plan.md M3). No balances on chain: the off-chain ledger is the book.
/// Users deposit allowlisted tokens; the operator pays withdrawals out as the ledger instructs.
/// Each withdrawal carries a single-use ref, so a retried transaction can never pay twice.
contract DarkPoolVault {
    address public owner;
    address public pendingOwner;
    address public operator;
    bool public paused;

    mapping(address token => bool) public allowed;
    mapping(bytes32 ref => bool) public refUsed;

    bool private transient entered;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount, bytes32 indexed ref);
    event TokenAllowed(address indexed token, bool allowed);
    event OperatorSet(address indexed operator);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error NotOperator();
    error IsPaused();
    error TokenNotAllowed();
    error ZeroAmount();
    error ZeroAddress();
    error ZeroRef();
    error RefUsed();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, address operator_) {
        if (owner_ == address(0) || operator_ == address(0)) revert ZeroAddress();
        owner = owner_;
        operator = operator_;
        emit OwnershipTransferred(address(0), owner_);
        emit OperatorSet(operator_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert IsPaused();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    /// @notice Deposit an allowlisted token. The event carries the amount actually received.
    function deposit(address token, uint256 amount) external whenNotPaused nonReentrant {
        if (!allowed[token]) revert TokenNotAllowed();
        if (amount == 0) revert ZeroAmount();
        uint256 before = _balanceOf(token);
        _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
        uint256 received = _balanceOf(token) - before;
        if (received == 0) revert ZeroAmount();
        emit Deposited(msg.sender, token, received);
    }

    /// @notice Pay out as the ledger instructs. Any token (also returns mistaken transfers); ref is single use.
    function withdraw(address token, address to, uint256 amount, bytes32 ref) external whenNotPaused nonReentrant {
        if (msg.sender != operator) revert NotOperator();
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (ref == bytes32(0)) revert ZeroRef();
        if (refUsed[ref]) revert RefUsed();
        refUsed[ref] = true;
        _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        emit Withdrawn(to, token, amount, ref);
    }

    // --- owner ---------------------------------------------------------------

    function setAllowed(address token, bool isAllowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        allowed[token] = isAllowed;
        emit TokenAllowed(token, isAllowed);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
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

    // --- internal ------------------------------------------------------------

    /// Tolerates tokens that return nothing; rejects false returns and non-contracts.
    function _call(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && (ret.length < 32 || !abi.decode(ret, (bool))))) revert TransferFailed();
    }

    function _balanceOf(address token) private view returns (uint256) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x70a08231, address(this))); // balanceOf
        if (!ok || ret.length < 32) revert TransferFailed();
        return abi.decode(ret, (uint256));
    }
}
