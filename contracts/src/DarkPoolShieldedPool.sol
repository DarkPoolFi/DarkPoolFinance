// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// The bb-generated UltraHonk verifiers (contracts/src/verifiers) all expose this.
interface IProofVerifier {
    function verify(bytes calldata proof, bytes32[] calldata publicInputs) external returns (bool);
}

/// DarkPoolScreeningGate
interface IScreeningGate {
    function allowed(address account) external view returns (bool);
    function associationRequired() external view returns (bool);
    function isAssociationRoot(bytes32 root) external view returns (bool);
}

/// DarkPoolBackstopVault
interface IBackstopVault {
    function offer(address asset, uint256 unit) external view returns (uint256 qty, uint256 ethMicro, uint16 spreadBps);
    function exchange(address asset, uint256 tokensSold, uint256 tokensBought, uint256 ethOut) external payable;
}

interface IChainlinkFeed {
    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @title DarkPoolShieldedPool
/// @notice X1 custody and venue (plan.md X1.1): balances are notes, not ledger rows, and every state change is backed
/// by a proof checked against a bb-generated verifier.
///   deposit      — DepositProof: the queued commitment holds exactly the asset and amount the pool received.
///   advanceTree  — TreeUpdateProof: the next queued commitments were appended to the root. No Poseidon runs on chain,
///                  so notes become spendable once their batch is appended (anyone may advance).
///   transact     — TransactProof: up to two unspent notes become two new notes, releasing an amount to a recipient
///                  and a fee to a relayer (withdrawals, merging, splitting, private transfers).
///   placeOrder   — OrderValidityProof: a note is locked into an order for an asset's current window; a relayed
///                  order pays its relayer in ETH from a second note.
///   seal         — pins the window's Chainlink rounds at its end (permissionless, no price is ever supplied).
///   settleWindow — BatchCrossProof: the crossing rules applied to exactly the window's orders at the sealed prices
///                  produce the fill notes, rolled orders / released locks and fee note, and the backstop leg the
///                  pool exchanges with DarkPoolBackstopVault at the offer pinned at seal (plan.md X2).
/// Deposits can be paused and markets closed to new orders; withdrawals and settlement cannot be stopped.
contract DarkPoolShieldedPool {
    struct Verifiers {
        IProofVerifier deposit;
        IProofVerifier tree;
        IProofVerifier transact;
        IProofVerifier order;
        IProofVerifier batch;
        IProofVerifier reclaim;
    }

    struct Transaction {
        bytes32 root;
        bytes32 aspRoot; // association-set root the input label is proven in; 0 = none
        bytes32[2] nullifiers; // a dummy input still has a (unique) nullifier
        bytes32[2] outputs;
        address asset;
        uint256 released; // paid to `to`
        uint256 fee; // paid to `relayer`
        address to;
        address relayer;
    }

    struct Placement {
        bytes32 root;
        bytes32 nullifier;
        bytes32 feeNullifier; // 0 unless relayed
        bytes32 change;
        bytes32 feeChange; // 0 unless relayed
        bytes32 commitment;
        address relayer;
        uint256 fee; // wei, from the fee note
    }

    struct Settlement {
        bytes32[64] fills;
        bytes32[64] residuals;
        bool[64] rolls;
        bytes32 feeNote;
        uint256 bsSold; // token micro-units the vault sold to buyers
        uint256 bsEthIn; // buyers' micro-ETH to the vault
        uint256 bsBought; // token micro-units the vault bought from sellers
        uint256 bsEthOut; // the vault's micro-ETH to sellers
    }

    struct Market {
        address feed; // Chainlink USD feed, 8 decimals
        uint88 unit; // token base units per micro-unit, fixed once set
        bool listed; // accepts new orders
    }

    struct Window {
        bool isSealed;
        bool isSettled;
        bool live;
        uint64 refUsd; // micro-USD per token
        uint64 ethUsd; // micro-USD per ETH
        uint16 feeBps;
        bool abandoned; // unsettled past SETTLE_DEADLINE: owners reclaim their locks, settlement is closed
        uint64 bsQty; // backstop offer pinned at seal: token micro-units
        uint64 bsEth; // micro-ETH
        uint16 bsSpread;
    }

    uint256 internal constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant BATCH = 16; // circuits/tree_update M
    uint256 internal constant ORDERS = 64; // circuits/batch_cross N
    uint256 internal constant CAPACITY = 1 << 20; // circuits/lib DEPTH
    /// circuits/lib zeros()[DEPTH]
    bytes32 public constant EMPTY_ROOT = 0x01da7c268b18dfc969f3ae497fff3fef7909905d6bd3d40b212d1d1544e1be88;
    address public constant ETH = address(0);
    uint256 public constant WINDOW = 300; // dark_config window_seconds
    uint256 public constant MAX_STALENESS = 90000; // dark_config max_staleness_seconds: 24h heartbeat + 1h
    uint16 public constant MAX_FEE_BPS = 100;
    uint256 public constant SETTLE_DEADLINE = 1 hours; // after a window's end; past it the window can be abandoned
    uint256 public constant MAX_DEPOSIT_FEE = 0.001 ether;
    uint256 internal constant MICRO_ETH = 1e12;

    IProofVerifier public immutable depositVerifier;
    IProofVerifier public immutable treeVerifier;
    IProofVerifier public immutable transactVerifier;
    IProofVerifier public immutable orderVerifier;
    IProofVerifier public immutable batchVerifier;
    IProofVerifier public immutable reclaimVerifier;

    address public owner;
    address public pendingOwner;
    bool public depositsPaused;
    IScreeningGate public gate; // deposit screening; 0 = none
    IBackstopVault public backstop; // X2 vault filling leftover interest; 0 = none
    mapping(address asset => bool) public allowed;
    // Deposit labels (association sets): keccak(chain, pool, depositor, nonce) mod p, so a depositor can prove before
    // sending which label their note will carry.
    mapping(address depositor => uint256) public depositNonce;
    uint256 public depositFee; // wei on top of every deposit, to feeRecipient (pays for appending it to the tree)
    address public feeRecipient;

    bytes32[] public commitments; // every queued commitment, in leaf order
    uint256 public treeSize; // how many of them are in the tree
    bytes32 public root;
    // The tree is append-only, so every past root stays valid; nullifiers are what stop a second spend.
    mapping(bytes32 root => bool) public knownRoot;
    mapping(bytes32 nullifier => bool) public spent;

    // ponytail: owner-set feeds and fee are trusted admin powers; put them behind a timelock before X2.
    IChainlinkFeed public ethUsdFeed;
    bytes32 public feeOwner; // owner key of the fee notes
    uint16 public feeBps;
    mapping(address asset => Market) public markets;
    mapping(address asset => mapping(uint256 epoch => Window)) public windows;
    mapping(address asset => mapping(uint256 epoch => bytes32[])) internal windowOrders;
    // Orders in windows not yet settled. Capped at ORDERS per asset, so a settlement's rolled orders always fit.
    // ponytail: 16 live orders per asset; the N = 64 circuit raises it.
    mapping(address asset => uint256) public openOrders;

    bool private transient entered;

    event Committed(uint256 indexed index, bytes32 commitment);
    event Deposited(address indexed from, address indexed asset, uint256 amount, bytes32 commitment, uint256 label);
    event DepositFeeSet(address recipient, uint256 fee);
    event TreeAdvanced(bytes32 root, uint256 size);
    event Transacted(
        bytes32 indexed nullifier0, bytes32 indexed nullifier1, address indexed asset, address to, uint256 released, address relayer, uint256 fee, bytes memo
    );
    event OrderResting(address indexed asset, uint256 indexed epoch, bytes32 commitment, bytes sealedOrder);
    event OrderFeePaid(address indexed relayer, uint256 fee); // ETH leaving the pool for a relayed order (solvency)
    event WindowSealed(address indexed asset, uint256 indexed epoch, uint256 refUsd, uint256 ethUsd, bool live);
    event WindowSettled(address indexed asset, uint256 indexed epoch, bytes notes);
    event BackstopSettled(address indexed asset, uint256 indexed epoch, uint256 sold, uint256 ethIn, uint256 bought, uint256 ethOut);
    event BackstopSet(address backstop);
    event WindowAbandoned(address indexed asset, uint256 indexed epoch);
    event OrderReclaimed(address indexed asset, uint256 indexed epoch, uint256 slot);
    event AssetAllowed(address indexed asset, bool allowed);
    event MarketSet(address indexed asset, address feed, uint256 unit, bool listed);
    event EthUsdFeedSet(address feed);
    event FeeSet(bytes32 feeOwner, uint16 feeBps);
    event DepositsPausedSet(bool paused);
    event GateSet(address gate);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotPendingOwner();
    error IsPaused();
    error Blocked();
    error AssetNotAllowed();
    error MarketNotListed();
    error BadMarket();
    error BadFee();
    error BadAmount();
    error BadCount();
    error ZeroAddress();
    error NotInField();
    error InvalidProof();
    error UnknownRoot();
    error NoteSpent();
    error TreeFull();
    error VenueFull();
    error WindowOpen();
    error AlreadySealed();
    error NotSealed();
    error AlreadySettled();
    error BadRound();
    error UnknownAssociationRoot();
    error AssociationRequired();
    error TooEarly();
    error AlreadyAbandoned();
    error NotAbandoned();
    error TransferFailed();
    error Reentrancy();

    constructor(address owner_, Verifiers memory v, IChainlinkFeed ethUsdFeed_, bytes32 feeOwner_, uint16 feeBps_) {
        if (
            owner_ == address(0) || address(v.deposit) == address(0) || address(v.tree) == address(0)
                || address(v.transact) == address(0) || address(v.order) == address(0) || address(v.batch) == address(0)
                || address(v.reclaim) == address(0)
                || address(ethUsdFeed_) == address(0)
        ) revert ZeroAddress();
        owner = owner_;
        depositVerifier = v.deposit;
        treeVerifier = v.tree;
        transactVerifier = v.transact;
        orderVerifier = v.order;
        batchVerifier = v.batch;
        reclaimVerifier = v.reclaim;
        root = EMPTY_ROOT;
        knownRoot[EMPTY_ROOT] = true;
        allowed[ETH] = true;
        ethUsdFeed = ethUsdFeed_;
        _setFee(feeOwner_, feeBps_);
        emit OwnershipTransferred(address(0), owner_);
        emit AssetAllowed(ETH, true);
        emit EthUsdFeedSet(address(ethUsdFeed_));
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

    // --- notes ---------------------------------------------------------------

    /// @notice Deposit ETH (asset 0, msg.value) or an allowlisted token into a new note, plus `depositFee` in ETH. The
    /// note must carry `depositLabel(msg.sender)`, the label the association set refers to.
    function deposit(address asset, uint256 amount, bytes32 commitment, bytes calldata proof) external payable nonReentrant {
        if (depositsPaused) revert IsPaused();
        if (address(gate) != address(0) && !gate.allowed(msg.sender)) revert Blocked();
        if (!allowed[asset]) revert AssetNotAllowed();
        if (amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (msg.value != (asset == ETH ? amount : 0) + depositFee) revert BadAmount();

        uint256 label = depositLabel(msg.sender);
        depositNonce[msg.sender]++;
        bytes32[] memory inputs = new bytes32[](4);
        inputs[0] = commitment;
        inputs[1] = bytes32(uint256(uint160(asset)));
        inputs[2] = bytes32(amount);
        inputs[3] = bytes32(label);
        _verify(depositVerifier, proof, inputs);

        if (asset != ETH) {
            uint256 before = _balanceOf(asset);
            _call(asset, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount)); // transferFrom
            if (_balanceOf(asset) - before != amount) revert BadAmount(); // the note must hold exactly what arrived
        }
        if (depositFee != 0) _pay(ETH, feeRecipient, depositFee);
        _queue(commitment);
        emit Deposited(msg.sender, asset, amount, commitment, label);
    }

    /// The label the next deposit from `depositor` carries. 0 and 1 are never labels (1 is the settlement fee label).
    function depositLabel(address depositor) public view returns (uint256 label) {
        label = uint256(keccak256(abi.encode(block.chainid, address(this), depositor, depositNonce[depositor]))) % FIELD;
        if (label < 2) label += 2;
    }

    /// @notice Append the next `count` queued commitments. Permissionless.
    function advanceTree(uint256 count, bytes32 newRoot, bytes calldata proof) external {
        uint256 size = treeSize;
        if (count == 0 || count > BATCH || size + count > commitments.length) revert BadCount();

        bytes32[] memory inputs = new bytes32[](BATCH + 4);
        inputs[0] = root;
        inputs[1] = bytes32(size);
        for (uint256 i; i < count; i++) {
            inputs[2 + i] = commitments[size + i];
        }
        inputs[BATCH + 2] = bytes32(count);
        inputs[BATCH + 3] = newRoot;
        _verify(treeVerifier, proof, inputs);

        root = newRoot;
        knownRoot[newRoot] = true;
        treeSize = size + count;
        emit TreeAdvanced(newRoot, size + count);
    }

    /// @notice Spend up to two notes into two new notes, releasing `released` to `to` and `fee` to `relayer`. Anyone may
    /// submit the proof; it only ever pays where it was made to pay. `memo` carries the outputs sealed to their owners.
    function transact(Transaction calldata t, bytes calldata proof, bytes calldata memo) external nonReentrant {
        if (!knownRoot[t.root]) revert UnknownRoot();
        if (t.nullifiers[0] == t.nullifiers[1] || spent[t.nullifiers[0]] || spent[t.nullifiers[1]]) revert NoteSpent();
        if (t.released > type(uint128).max || t.fee > type(uint128).max) revert BadAmount();
        if ((t.released != 0 && t.to == address(0)) || (t.fee != 0 && t.relayer == address(0))) revert ZeroAddress();
        if (t.aspRoot != 0 && (address(gate) == address(0) || !gate.isAssociationRoot(t.aspRoot))) revert UnknownAssociationRoot();
        if (t.released != 0 && t.aspRoot == 0 && address(gate) != address(0) && gate.associationRequired()) revert AssociationRequired();

        bytes32[] memory inputs = new bytes32[](10);
        inputs[0] = t.root;
        inputs[1] = t.aspRoot;
        inputs[2] = t.nullifiers[0];
        inputs[3] = t.nullifiers[1];
        inputs[4] = t.outputs[0];
        inputs[5] = t.outputs[1];
        inputs[6] = bytes32(uint256(uint160(t.asset)));
        inputs[7] = bytes32(t.released);
        inputs[8] = bytes32(t.fee);
        inputs[9] = context(t.to, t.relayer, t.fee);
        _verify(transactVerifier, proof, inputs);

        spent[t.nullifiers[0]] = true;
        spent[t.nullifiers[1]] = true;
        _queue(t.outputs[0]);
        _queue(t.outputs[1]);
        if (t.released != 0) _pay(t.asset, t.to, t.released);
        if (t.fee != 0) _pay(t.asset, t.relayer, t.fee);
        emit Transacted(t.nullifiers[0], t.nullifiers[1], t.asset, t.to, t.released, t.relayer, t.fee, memo);
    }

    /// Binds a transaction or relayed order proof to this chain, this pool, its recipient, relayer and fee.
    function context(address to, address relayer, uint256 fee) public view returns (bytes32) {
        return bytes32(uint256(keccak256(abi.encode(block.chainid, address(this), to, relayer, fee))) % FIELD);
    }

    function commitmentCount() external view returns (uint256) {
        return commitments.length;
    }

    // --- venue ---------------------------------------------------------------

    /// @notice Lock part of a note into an order in `asset`'s current window. The pool only sees the order commitment;
    /// the order itself travels encrypted to the sealing key in `sealedOrder`. A relayed order (fee > 0) pays its
    /// relayer in ETH from a separate note, so the fee reveals nothing about the side.
    function placeOrder(address asset, Placement calldata p, bytes calldata proof, bytes calldata sealedOrder) external nonReentrant {
        Market memory m = markets[asset];
        if (!m.listed) revert MarketNotListed();
        if (!knownRoot[p.root]) revert UnknownRoot();
        if (spent[p.nullifier]) revert NoteSpent();
        if (p.fee > type(uint128).max) revert BadAmount();
        if (p.fee != 0) {
            if (p.relayer == address(0)) revert ZeroAddress();
            if (p.feeNullifier == p.nullifier || spent[p.feeNullifier]) revert NoteSpent();
        } else if (p.feeNullifier != 0 || p.feeChange != 0) {
            revert BadFee();
        }
        if (p.commitment == 0) revert BadCount(); // 0 marks an empty slot
        if (openOrders[asset] >= ORDERS) revert VenueFull();
        _verify(orderVerifier, proof, _placementInputs(asset, m.unit, p));

        spent[p.nullifier] = true;
        _queue(p.change);
        if (p.fee != 0) {
            spent[p.feeNullifier] = true;
            _queue(p.feeChange);
            _pay(ETH, p.relayer, p.fee);
            emit OrderFeePaid(p.relayer, p.fee);
        }
        _rest(asset, block.timestamp / WINDOW, p.commitment, sealedOrder);
    }

    /// order_validity public inputs, in circuit order.
    function _placementInputs(address asset, uint256 unit, Placement calldata p) private view returns (bytes32[] memory inputs) {
        inputs = new bytes32[](10);
        inputs[0] = p.root;
        inputs[1] = p.nullifier;
        inputs[2] = p.feeNullifier;
        inputs[3] = p.change;
        inputs[4] = p.feeChange;
        inputs[5] = bytes32(uint256(uint160(asset)));
        inputs[6] = bytes32(unit);
        inputs[7] = p.commitment;
        inputs[8] = bytes32(p.fee);
        inputs[9] = context(address(0), p.relayer, p.fee);
    }

    /// @notice Pin a closed window's references: `assetRound` / `ethRound` must be each feed's latest round at the
    /// window's end. Permissionless — the caller only picks rounds, which are checked.
    function seal(address asset, uint256 epoch, uint80 assetRound, uint80 ethRound) external {
        Window storage w = windows[asset][epoch];
        uint256 end = (epoch + 1) * WINDOW;
        if (block.timestamp < end) revert WindowOpen();
        if (w.isSealed) revert AlreadySealed();
        if (w.abandoned) revert AlreadyAbandoned(); // re-sealing must never reopen settlement of reclaimed orders
        if (windowOrders[asset][epoch].length == 0) revert BadCount();

        (uint256 refUsd, bool refOk) = _priceAt(IChainlinkFeed(markets[asset].feed), assetRound, end);
        (uint256 ethUsd, bool ethOk) = _priceAt(ethUsdFeed, ethRound, end);
        bool live = refOk && ethOk && inSession(end) && !_oraclePaused(asset);
        Window memory closed = Window({
            isSealed: true,
            isSettled: false,
            live: live,
            refUsd: uint64(refUsd),
            ethUsd: uint64(ethUsd),
            feeBps: feeBps,
            abandoned: false,
            bsQty: 0,
            bsEth: 0,
            bsSpread: 0
        });
        if (live) (closed.bsQty, closed.bsEth, closed.bsSpread) = _offer(asset);
        windows[asset][epoch] = closed;
        emit WindowSealed(asset, epoch, refUsd, ethUsd, live);
    }

    /// @notice Settle a sealed window. Permissionless; `notes` carries the outputs encrypted to their owners.
    function settleWindow(address asset, uint256 epoch, Settlement calldata s, bytes calldata proof, bytes calldata notes) external nonReentrant {
        Window storage w = windows[asset][epoch];
        if (!w.isSealed) revert NotSealed();
        if (w.isSettled) revert AlreadySettled();
        if (w.abandoned) revert AlreadyAbandoned();
        bytes32[] storage list = windowOrders[asset][epoch];
        uint256 n = list.length;
        _verify(batchVerifier, proof, _settlementInputs(asset, w, list, s));

        w.isSettled = true;
        openOrders[asset] -= n;
        uint256 current = block.timestamp / WINDOW;
        for (uint256 i; i < n; i++) {
            _queue(s.fills[i]);
            if (s.rolls[i]) _rest(asset, current, s.residuals[i], "");
            else _queue(s.residuals[i]);
        }
        _queue(s.feeNote);
        if (s.bsSold != 0 || s.bsBought != 0 || s.bsEthIn != 0 || s.bsEthOut != 0) _settleBackstop(asset, epoch, s);
        emit WindowSettled(asset, epoch, notes);
    }

    /// The vault leg of a settlement: buyers' ETH and sellers' tokens go to the vault, the tokens it sold and the ETH it
    /// paid come back to the pool. The token balance must move by exactly the settled amounts.
    function _settleBackstop(address asset, uint256 epoch, Settlement calldata s) private {
        uint256 unit = markets[asset].unit;
        uint256 before = _balanceOf(asset);
        if (s.bsBought != 0) _call(asset, abi.encodeWithSelector(0x095ea7b3, address(backstop), s.bsBought * unit)); // approve
        backstop.exchange{value: s.bsEthIn * MICRO_ETH}(asset, s.bsSold * unit, s.bsBought * unit, s.bsEthOut * MICRO_ETH);
        if (_balanceOf(asset) + s.bsBought * unit != before + s.bsSold * unit) revert TransferFailed();
        emit BackstopSettled(asset, epoch, s.bsSold * unit, s.bsEthIn * MICRO_ETH, s.bsBought * unit, s.bsEthOut * MICRO_ETH); // base units, as Deposited
    }

    /// Plain ETH only from the backstop vault's settlement leg.
    receive() external payable {
        if (msg.sender != address(backstop)) revert BadAmount();
    }

    /// @notice Close a window nobody settled within SETTLE_DEADLINE of its end. Its orders become reclaimable by their
    /// owners and it can never be settled. Permissionless, so the operator cannot hold locks hostage.
    function abandon(address asset, uint256 epoch) external {
        Window storage w = windows[asset][epoch];
        uint256 n = windowOrders[asset][epoch].length;
        if (n == 0) revert BadCount();
        if (block.timestamp < (epoch + 1) * WINDOW + SETTLE_DEADLINE) revert TooEarly();
        if (w.isSettled) revert AlreadySettled();
        if (w.abandoned) revert AlreadyAbandoned();
        w.abandoned = true;
        openOrders[asset] -= n;
        emit WindowAbandoned(asset, epoch);
    }

    /// @notice Take the lock of the order in `slot` of an abandoned window back as a note (ReclaimProof).
    /// ponytail: no relayer, so the sender's address is linked to the reclaimed order; route through /api/relay later.
    function reclaim(address asset, uint256 epoch, uint256 slot, bytes32 orderNullifier, bytes32 refund, bytes calldata proof) external {
        if (!windows[asset][epoch].abandoned) revert NotAbandoned();
        if (spent[orderNullifier]) revert NoteSpent();

        bytes32[] memory inputs = new bytes32[](5);
        inputs[0] = bytes32(uint256(uint160(asset)));
        inputs[1] = bytes32(uint256(markets[asset].unit));
        inputs[2] = windowOrders[asset][epoch][slot];
        inputs[3] = orderNullifier;
        inputs[4] = refund;
        _verify(reclaimVerifier, proof, inputs);

        spent[orderNullifier] = true;
        _queue(refund);
        emit OrderReclaimed(asset, epoch, slot);
    }

    function windowOrderList(address asset, uint256 epoch) external view returns (bytes32[] memory) {
        return windowOrders[asset][epoch];
    }

    /// Robinhood 24/5 equities session, Sunday 20:00 → Friday 20:00 America/New_York (prices.ts equitiesOpen).
    /// US DST runs from the second Sunday of March 02:00 to the first Sunday of November 02:00 local.
    /// ponytail: market holidays are not modelled, as in X0; the staleness limit is the backstop.
    function inSession(uint256 t) public pure returns (bool) {
        uint256 year = _year(t / 1 days);
        uint256 dstStart = _nthSunday(year, 3, 2) * 1 days + 7 hours; // 02:00 EST
        uint256 dstEnd = _nthSunday(year, 11, 1) * 1 days + 6 hours; // 02:00 EDT
        uint256 local = t - (t >= dstStart && t < dstEnd ? 4 hours : 5 hours);
        uint256 weekday = (local / 1 days + 4) % 7; // 0 = Sunday; 1970-01-01 was a Thursday
        uint256 hour = (local % 1 days) / 1 hours;
        if (weekday == 6) return false;
        if (weekday == 0) return hour >= 20;
        if (weekday == 5) return hour < 20;
        return true;
    }

    // --- owner ---------------------------------------------------------------

    function setAllowed(address asset, bool isAllowed) external onlyOwner {
        allowed[asset] = isAllowed;
        emit AssetAllowed(asset, isAllowed);
    }

    /// A market's unit can never change: open orders and notes are denominated in it.
    function setMarket(address asset, address feed, uint88 unit, bool listed) external onlyOwner {
        uint88 current = markets[asset].unit;
        if (asset == ETH || feed == address(0) || unit == 0 || (current != 0 && current != unit)) revert BadMarket();
        markets[asset] = Market({feed: feed, unit: unit, listed: listed});
        emit MarketSet(asset, feed, unit, listed);
    }

    function setEthUsdFeed(IChainlinkFeed feed) external onlyOwner {
        if (address(feed) == address(0)) revert ZeroAddress();
        ethUsdFeed = feed;
        emit EthUsdFeedSet(address(feed));
    }

    function setFee(bytes32 feeOwner_, uint16 feeBps_) external onlyOwner {
        _setFee(feeOwner_, feeBps_);
    }

    function setDepositsPaused(bool paused_) external onlyOwner {
        depositsPaused = paused_;
        emit DepositsPausedSet(paused_);
    }

    function setDepositFee(address recipient, uint256 fee) external onlyOwner {
        if (fee > MAX_DEPOSIT_FEE) revert BadFee();
        if (fee != 0 && recipient == address(0)) revert ZeroAddress();
        feeRecipient = recipient;
        depositFee = fee;
        emit DepositFeeSet(recipient, fee);
    }

    function setBackstop(IBackstopVault backstop_) external onlyOwner {
        backstop = backstop_;
        emit BackstopSet(address(backstop_));
    }

    function setGate(IScreeningGate gate_) external onlyOwner {
        gate = gate_;
        emit GateSet(address(gate_));
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

    /// Inputs must be canonical field elements, or one nullifier could be spent twice as x and x + p. The bb verifier
    /// also rejects them (ValueGeFieldOrder); checked here so the pool does not depend on that.
    function _verify(IProofVerifier verifier, bytes calldata proof, bytes32[] memory inputs) private {
        for (uint256 i; i < inputs.length; i++) {
            if (uint256(inputs[i]) >= FIELD) revert NotInField();
        }
        if (!verifier.verify(proof, inputs)) revert InvalidProof();
    }

    /// batch_cross public inputs, in circuit order.
    function _settlementInputs(address asset, Window storage w, bytes32[] storage list, Settlement calldata s)
        private
        view
        returns (bytes32[] memory inputs)
    {
        inputs = new bytes32[](15 + 4 * ORDERS);
        inputs[0] = bytes32(uint256(uint160(asset)));
        inputs[1] = bytes32(uint256(markets[asset].unit));
        inputs[2] = bytes32(uint256(w.refUsd));
        inputs[3] = bytes32(uint256(w.ethUsd));
        inputs[4] = bytes32(uint256(w.live ? 1 : 0));
        inputs[5] = bytes32(uint256(w.feeBps));
        inputs[6] = bytes32(uint256(w.bsQty));
        inputs[7] = bytes32(uint256(w.bsEth));
        inputs[8] = bytes32(uint256(w.bsSpread));
        for (uint256 i; i < ORDERS; i++) {
            if (i < list.length) inputs[9 + i] = list[i];
            inputs[9 + ORDERS + i] = s.fills[i];
            inputs[9 + 2 * ORDERS + i] = s.residuals[i];
            inputs[9 + 3 * ORDERS + i] = bytes32(uint256(s.rolls[i] ? 1 : 0));
        }
        inputs[9 + 4 * ORDERS] = feeOwner;
        inputs[10 + 4 * ORDERS] = s.feeNote;
        inputs[11 + 4 * ORDERS] = bytes32(s.bsSold);
        inputs[12 + 4 * ORDERS] = bytes32(s.bsEthIn);
        inputs[13 + 4 * ORDERS] = bytes32(s.bsBought);
        inputs[14 + 4 * ORDERS] = bytes32(s.bsEthOut);
    }

    function _queue(bytes32 commitment) private {
        uint256 index = commitments.length;
        if (index == CAPACITY) revert TreeFull();
        commitments.push(commitment);
        emit Committed(index, commitment);
    }

    function _rest(address asset, uint256 epoch, bytes32 commitment, bytes memory sealedOrder) private {
        windowOrders[asset][epoch].push(commitment);
        openOrders[asset]++;
        emit OrderResting(asset, epoch, commitment, sealedOrder);
    }

    function _setFee(bytes32 feeOwner_, uint16 feeBps_) private {
        if (uint256(feeOwner_) >= FIELD || feeBps_ > MAX_FEE_BPS) revert BadFee();
        feeOwner = feeOwner_;
        feeBps = feeBps_;
        emit FeeSet(feeOwner_, feeBps_);
    }

    /// `round` must be the feed's latest round at `end`: updated by then, and followed (if at all) only after it.
    /// ponytail: a feed phase switch right at a window end makes that window unsealable (round + 1 does not exist).
    function _priceAt(IChainlinkFeed feed, uint80 round, uint256 end) private view returns (uint256 usd, bool ok) {
        (, int256 answer,, uint256 updatedAt,) = feed.getRoundData(round);
        if (updatedAt == 0 || updatedAt > end) revert BadRound();
        (uint80 latest,,,,) = feed.latestRoundData();
        if (latest != round) {
            (,,, uint256 nextAt,) = feed.getRoundData(round + 1);
            if (nextAt <= end) revert BadRound();
        }
        ok = answer > 0 && end - updatedAt <= MAX_STALENESS && uint256(answer) / 100 <= type(uint64).max;
        if (ok) usd = uint256(answer) / 100; // 8 → 6 decimals
    }

    /// The vault's offer for this window, or none when there is no vault, it fails, or the market has no unit.
    function _offer(address asset) private view returns (uint64 qty, uint64 eth, uint16 spread) {
        if (address(backstop) == address(0) || markets[asset].unit == 0) return (0, 0, 0);
        try backstop.offer(asset, markets[asset].unit) returns (uint256 q, uint256 e, uint16 sp) {
            if (q > type(uint64).max || e > type(uint64).max || sp > 200) return (0, 0, 0);
            return (uint64(q), uint64(e), sp);
        } catch {
            return (0, 0, 0);
        }
    }

    /// Unknown or failing token → treated as paused.
    function _oraclePaused(address token) private view returns (bool) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("oraclePaused()"));
        return !ok || ret.length < 32 || abi.decode(ret, (bool));
    }

    /// Days since 1970-01-01 of the n-th Sunday of `month`.
    function _nthSunday(uint256 year, uint256 month, uint256 n) private pure returns (uint256) {
        uint256 first = _days(year, month, 1);
        return first + (7 - (first + 4) % 7) % 7 + (n - 1) * 7;
    }

    // days_from_civil / civil_from_days (H. Hinnant), for dates from 1970.
    function _days(uint256 y, uint256 m, uint256 d) private pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5 + d - 1;
        return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
    }

    function _year(uint256 z) private pure returns (uint256) {
        z += 719468;
        uint256 era = z / 146097;
        uint256 doe = z - era * 146097;
        uint256 yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        return yoe + era * 400 + (mp >= 10 ? 1 : 0);
    }

    function _pay(address asset, address to, uint256 amount) private {
        if (asset == ETH) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(asset, abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer
        }
    }

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
