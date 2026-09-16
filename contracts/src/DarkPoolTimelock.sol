// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DarkPoolTimelock
/// @notice Owner of DarkPoolShieldedPool (plan.md X1.1, "timelock before X2"): feed, fee, market and gate changes are
/// scheduled publicly and can only run after `delay`, so users see an admin change coming and can exit first.
/// Accepting ownership of a contract is the one call that runs without the delay (it grants this timelock control and
/// changes nothing for users).
contract DarkPoolTimelock {
    bytes4 internal constant ACCEPT_OWNERSHIP = 0x79ba5097; // acceptOwnership()

    address public admin;
    uint256 public immutable delay;
    mapping(bytes32 id => uint256 readyAt) public readyAt;

    event Scheduled(bytes32 indexed id, address indexed target, bytes data, uint256 readyAt);
    event Cancelled(bytes32 indexed id);
    event Executed(bytes32 indexed id, address indexed target, bytes data);
    event AdminSet(address admin);

    error NotAdmin();
    error NotSelf();
    error NotReady();
    error AlreadyScheduled();
    error CallFailed(bytes reason);
    error ZeroAddress();

    constructor(address admin_, uint256 delay_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        delay = delay_;
        emit AdminSet(admin_);
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function idOf(address target, bytes calldata data) public pure returns (bytes32) {
        return keccak256(abi.encode(target, data));
    }

    function schedule(address target, bytes calldata data) external onlyAdmin returns (bytes32 id) {
        id = idOf(target, data);
        if (readyAt[id] != 0) revert AlreadyScheduled();
        readyAt[id] = block.timestamp + delay;
        emit Scheduled(id, target, data, readyAt[id]);
    }

    function cancel(bytes32 id) external onlyAdmin {
        delete readyAt[id];
        emit Cancelled(id);
    }

    function execute(address target, bytes calldata data) external onlyAdmin returns (bytes memory ret) {
        bytes32 id = idOf(target, data);
        if (data.length < 4 || bytes4(data[:4]) != ACCEPT_OWNERSHIP) {
            uint256 at = readyAt[id];
            if (at == 0 || block.timestamp < at) revert NotReady();
            delete readyAt[id];
        }
        bool ok;
        (ok, ret) = target.call(data);
        if (!ok) revert CallFailed(ret);
        emit Executed(id, target, data);
    }

    /// Changing the admin is itself a timelocked call (schedule a call to this contract).
    function setAdmin(address admin_) external {
        if (msg.sender != address(this)) revert NotSelf();
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        emit AdminSet(admin_);
    }
}
