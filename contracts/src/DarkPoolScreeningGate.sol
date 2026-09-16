// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Chainalysis-style sanctions oracle.
interface ISanctionsList {
    function isSanctioned(address account) external view returns (bool);
}

/// @title DarkPoolScreeningGate
/// @notice Screening for DarkPoolShieldedPool (plan.md X1.1).
///   Deposits: the owner keeps a blocklist (Robinhood Chain has no on-chain sanctions oracle; `setSanctions` plugs one
///   in if it appears, and both apply).
///   Withdrawals: an association set. The poster publishes the root of the approved deposit labels (every deposit whose
///   depositor is not blocked, plus settlement fees); a withdrawal proves its label is in a recent root without
///   revealing which deposit it is. Only the last ROOT_HISTORY roots count, so a label removed from the set stops
///   working after that many updates.
contract DarkPoolScreeningGate {
    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 public constant ROOT_HISTORY = 8;

    address public owner;
    address public pendingOwner;
    address public poster; // publishes association roots (the pool operator)
    ISanctionsList public sanctions; // 0 = none
    bool public associationRequired; // withdrawals releasing funds must prove an association root
    mapping(address account => bool) public blocked;
    bytes32[ROOT_HISTORY] public associationRoots;
    uint256 public rootCount;

    event Blocked(address indexed account, bool blocked);
    event SanctionsSet(address sanctions);
    event PosterSet(address poster);
    event AssociationRequiredSet(bool required);
    event AssociationRootPosted(bytes32 root, uint256 count);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error NotPoster();
    error BadRoot();
    error ZeroAddress();

    constructor(address owner_, address poster_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        poster = poster_;
        emit OwnershipTransferred(address(0), owner_);
        emit PosterSet(poster_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Whether `account` may deposit.
    function allowed(address account) external view returns (bool) {
        if (blocked[account]) return false;
        return address(sanctions) == address(0) || !sanctions.isSanctioned(account);
    }

    /// @notice Whether `root` is one of the last ROOT_HISTORY association roots.
    function isAssociationRoot(bytes32 root) external view returns (bool) {
        if (root == 0) return false;
        for (uint256 i; i < ROOT_HISTORY; i++) {
            if (associationRoots[i] == root) return true;
        }
        return false;
    }

    function latestAssociationRoot() external view returns (bytes32) {
        return rootCount == 0 ? bytes32(0) : associationRoots[(rootCount - 1) % ROOT_HISTORY];
    }

    function postAssociationRoot(bytes32 root) external {
        if (msg.sender != poster && msg.sender != owner) revert NotPoster();
        if (root == 0 || uint256(root) >= FIELD) revert BadRoot();
        associationRoots[rootCount % ROOT_HISTORY] = root;
        rootCount++;
        emit AssociationRootPosted(root, rootCount);
    }

    function setBlocked(address[] calldata accounts, bool isBlocked) external onlyOwner {
        for (uint256 i; i < accounts.length; i++) {
            blocked[accounts[i]] = isBlocked;
            emit Blocked(accounts[i], isBlocked);
        }
    }

    function setSanctions(ISanctionsList sanctions_) external onlyOwner {
        sanctions = sanctions_;
        emit SanctionsSet(address(sanctions_));
    }

    function setPoster(address poster_) external onlyOwner {
        poster = poster_;
        emit PosterSet(poster_);
    }

    function setAssociationRequired(bool required) external onlyOwner {
        associationRequired = required;
        emit AssociationRequiredSet(required);
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
