// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {StdStorage, Test, stdStorage} from "forge-std/Test.sol";
import {DarkPoolShieldedPool, IBackstopVault, IChainlinkFeed, IProofVerifier, IScreeningGate} from "../src/DarkPoolShieldedPool.sol";
import {DarkPoolBackstopVault, IChainlinkPrice, ISwapRouter02, IWETH9} from "../src/DarkPoolBackstopVault.sol";
import {DarkPoolScreeningGate, ISanctionsList} from "../src/DarkPoolScreeningGate.sol";
import {DarkPoolTimelock} from "../src/DarkPoolTimelock.sol";
import {DarkPoolDisclosureRegistry} from "../src/DarkPoolDisclosureRegistry.sol";

contract MockSanctions {
    mapping(address => bool) public isSanctioned;

    function set(address account) external {
        isSanctioned[account] = true;
    }
}

/// Chainlink aggregator stand-in: rounds pushed in order, missing rounds revert like the proxies do.
contract MockFeed {
    struct Round {
        int256 answer;
        uint256 updatedAt;
    }

    mapping(uint80 => Round) internal rounds;
    uint80 public latest;

    function push(int256 answer, uint256 updatedAt) external returns (uint80) {
        rounds[++latest] = Round(answer, updatedAt);
        return latest;
    }

    function getRoundData(uint80 id) public view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = rounds[id];
        require(r.updatedAt != 0, "No data present");
        return (id, r.answer, r.updatedAt, r.updatedAt, id);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return getRoundData(latest);
    }
}

/// Stock-token stand-in with Robinhood's oraclePaused().
contract MockStock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public oraclePaused;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// DarkPoolShieldedPool against the real bb-generated verifiers. Proof tests need `bun circuits/tests/pool.fixture.ts`
/// and `bun circuits/tests/venue.fixture.ts` and are skipped without them.
contract DarkPoolShieldedPoolTest is Test {
    using stdStorage for StdStorage;

    address constant POOL = address(0xD4A11); // the fixtures bind proofs to this address
    address constant TOKEN = address(0xAA91); // mock AAPL, the venue fixture's asset
    address constant TO = address(0xA11C);
    address constant RELAYER = address(0xBEEF);
    address constant DEPOSITOR = address(0xD0D0); // the fixture labels are this address’s deposit nonces 0, 1, 2
    uint256 constant FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    string constant DIR = "../circuits/target/fixtures/";

    DarkPoolShieldedPool pool;
    string notes; // pool.json
    string venue; // venue.json
    MockFeed aaplFeed;
    MockFeed ethFeed;

    function setUp() public {
        DarkPoolShieldedPool.Verifiers memory v = DarkPoolShieldedPool.Verifiers({
            deposit: IProofVerifier(deployCode("DepositVerifier.sol:HonkVerifier")),
            tree: IProofVerifier(deployCode("TreeUpdateVerifier.sol:HonkVerifier")),
            transact: IProofVerifier(deployCode("TransactVerifier.sol:HonkVerifier")),
            order: IProofVerifier(deployCode("OrderValidityVerifier.sol:HonkVerifier")),
            batch: IProofVerifier(deployCode("BatchCrossVerifier.sol:HonkVerifier")),
            reclaim: IProofVerifier(deployCode("ReclaimVerifier.sol:HonkVerifier"))
        });
        deployCodeTo(
            "DarkPoolShieldedPool.sol:DarkPoolShieldedPool", abi.encode(address(this), v, address(0xFEED), bytes32(uint256(1)), uint16(5)), POOL
        );
        pool = DarkPoolShieldedPool(payable(POOL)); // payable: the pool takes the vault ETH leg
        vm.deal(address(this), 1 ether);
        vm.deal(DEPOSITOR, 1 ether);
    }

    function _proof(string memory name) internal view returns (bytes memory) {
        return vm.readFileBinary(string.concat(DIR, name, "/proof"));
    }

    // --- notes ---------------------------------------------------------------

    modifier noteFixtures() {
        string memory path = string.concat(DIR, "pool.json");
        if (!vm.exists(path)) vm.skip(true);
        notes = vm.readFile(path);
        _;
    }

    function _nb(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(notes, key);
    }

    function _nu(string memory key) internal view returns (uint256) {
        return uint256(vm.parseJsonBytes32(notes, key));
    }

    function _deposits() internal {
        for (uint256 i; i < 3; i++) {
            string memory d = string.concat(".deposits[", vm.toString(i), "]");
            uint256 amount = _nu(string.concat(d, ".amount"));
            bytes32 commitment = _nb(string.concat(d, ".commitment"));
            uint256 label = _nu(string.concat(d, ".label"));
            assertEq(pool.depositLabel(DEPOSITOR), label);
            vm.expectEmit(POOL);
            emit DarkPoolShieldedPool.Deposited(DEPOSITOR, address(0), amount, commitment, label);
            vm.prank(DEPOSITOR);
            pool.deposit{value: amount}(address(0), amount, commitment, _proof(string.concat("deposit_", vm.toString(i))));
        }
    }

    function _depositsAndAdvance() internal {
        _deposits();
        pool.advanceTree(3, _nb(".root"), _proof("advance"));
    }

    /// A screening gate with the fixture's association root posted by its poster.
    function _gate() internal returns (DarkPoolScreeningGate gate) {
        gate = new DarkPoolScreeningGate(address(this), address(0x9057));
        pool.setGate(IScreeningGate(address(gate)));
        vm.prank(address(0x9057));
        gate.postAssociationRoot(_nb(".aspRoot"));
    }

    function _transaction(string memory key, uint256 released, uint256 fee, address to, address relayer)
        internal
        view
        returns (DarkPoolShieldedPool.Transaction memory t)
    {
        t.root = _nb(string.concat(".", key, ".root"));
        t.nullifiers[0] = _nb(string.concat(".", key, ".nullifier0"));
        t.nullifiers[1] = _nb(string.concat(".", key, ".nullifier1"));
        t.outputs[0] = _nb(string.concat(".", key, ".output0"));
        t.outputs[1] = _nb(string.concat(".", key, ".output1"));
        t.asset = address(0);
        t.released = released;
        t.fee = fee;
        t.to = to;
        t.relayer = relayer;
    }

    function _withdrawal() internal view returns (DarkPoolShieldedPool.Transaction memory t) {
        t = _transaction("withdrawal", _nu(".released"), _nu(".fee"), TO, RELAYER);
        t.aspRoot = _nb(".aspRoot");
    }

    function _merge() internal view returns (DarkPoolShieldedPool.Transaction memory) {
        return _transaction("merge", 0, 0, address(0), address(0));
    }

    function test_deposit_advance_withdraw() public noteFixtures {
        uint256 g = gasleft();
        _deposits();
        emit log_named_uint("3 deposits gas", g - gasleft());
        assertEq(pool.commitmentCount(), 3);

        g = gasleft();
        pool.advanceTree(3, _nb(".root"), _proof("advance"));
        emit log_named_uint("advanceTree gas", g - gasleft());
        assertEq(pool.root(), _nb(".root"));
        assertEq(pool.treeSize(), 3);

        _gate().setAssociationRequired(true);
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        uint256 held = POOL.balance;
        vm.prank(address(0xCAFE)); // anyone may submit it
        g = gasleft();
        pool.transact(t, _proof("transact_withdraw"), hex"00");
        emit log_named_uint("transact (withdraw) gas", g - gasleft());
        assertEq(TO.balance, t.released);
        assertEq(RELAYER.balance, t.fee);
        assertEq(POOL.balance, held - t.released - t.fee); // exactly what left the notes
        assertTrue(pool.spent(t.nullifiers[0]));
        assertTrue(pool.spent(t.nullifiers[1]));
        assertEq(pool.commitments(3), t.outputs[0]);
        assertEq(pool.commitments(4), t.outputs[1]);
    }

    function test_merges_two_notes() public noteFixtures {
        _depositsAndAdvance();
        _gate().setAssociationRequired(true); // a merge releases nothing, so it needs no association proof
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");
        pool.advanceTree(2, _nb(".root2"), _proof("advance2"));
        DarkPoolShieldedPool.Transaction memory t = _merge();
        uint256 held = POOL.balance;
        pool.transact(t, _proof("transact_merge"), "");
        assertEq(POOL.balance, held, "a merge moves no ETH");
        assertTrue(pool.spent(t.nullifiers[0]) && pool.spent(t.nullifiers[1]));
        assertEq(pool.commitments(5), t.outputs[0]);
    }

    function test_rejects_a_second_spend() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");
        vm.expectRevert(DarkPoolShieldedPool.NoteSpent.selector);
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");
    }

    function test_withdrawal_needs_a_posted_association_root() public noteFixtures {
        _depositsAndAdvance();
        vm.expectRevert(DarkPoolShieldedPool.UnknownAssociationRoot.selector); // no gate
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");

        DarkPoolScreeningGate gate = new DarkPoolScreeningGate(address(this), address(this));
        pool.setGate(IScreeningGate(address(gate)));
        vm.expectRevert(DarkPoolShieldedPool.UnknownAssociationRoot.selector); // not posted
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");

        // a root falls out after ROOT_HISTORY newer ones
        gate.postAssociationRoot(_nb(".aspRoot"));
        for (uint256 i = 1; i <= gate.ROOT_HISTORY(); i++) {
            assertTrue(gate.isAssociationRoot(_nb(".aspRoot")));
            gate.postAssociationRoot(bytes32(i));
        }
        assertEq(gate.latestAssociationRoot(), bytes32(gate.ROOT_HISTORY()));
        assertFalse(gate.isAssociationRoot(_nb(".aspRoot")));
        vm.expectRevert(DarkPoolShieldedPool.UnknownAssociationRoot.selector);
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");

        gate.postAssociationRoot(_nb(".aspRoot"));
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.aspRoot = bytes32(uint256(2)); // still in the history, but not the root the proof used
        assertTrue(gate.isAssociationRoot(t.aspRoot));
        vm.expectRevert();
        pool.transact(t, _proof("transact_withdraw"), "");
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");
    }

    function test_required_association_blocks_unproven_withdrawals() public noteFixtures {
        _depositsAndAdvance();
        DarkPoolScreeningGate gate = _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.aspRoot = 0;
        gate.setAssociationRequired(true);
        vm.expectRevert(DarkPoolShieldedPool.AssociationRequired.selector);
        pool.transact(t, _proof("transact_withdraw"), "");
        gate.setAssociationRequired(false);
        vm.expectRevert(); // the proof was made against the root, not 0
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_gate_association_root_guards() public {
        DarkPoolScreeningGate gate = new DarkPoolScreeningGate(address(this), address(0x9057));
        assertEq(gate.latestAssociationRoot(), bytes32(0));
        assertFalse(gate.isAssociationRoot(0));
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolScreeningGate.NotPoster.selector);
        gate.postAssociationRoot(bytes32(uint256(5)));
        vm.expectRevert(DarkPoolScreeningGate.BadRoot.selector);
        gate.postAssociationRoot(0);
        vm.expectRevert(DarkPoolScreeningGate.BadRoot.selector);
        gate.postAssociationRoot(bytes32(FIELD));
        gate.postAssociationRoot(bytes32(FIELD - 1)); // the owner may post too
        assertTrue(gate.isAssociationRoot(bytes32(FIELD - 1)));
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolScreeningGate.NotOwner.selector);
        gate.setAssociationRequired(true);
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolScreeningGate.NotOwner.selector);
        gate.setPoster(address(0xCAFE));
    }

    function test_rejects_one_nullifier_twice() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.nullifiers[1] = t.nullifiers[0];
        vm.expectRevert(DarkPoolShieldedPool.NoteSpent.selector);
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_rejects_the_nullifier_under_another_encoding() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.nullifiers[0] = bytes32(uint256(t.nullifiers[0]) + FIELD);
        vm.expectRevert(DarkPoolShieldedPool.NotInField.selector);
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_rejects_a_redirected_withdrawal() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.to = address(0xBAD);
        vm.expectRevert();
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_rejects_a_raised_relayer_fee() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.fee = t.fee * 2;
        vm.expectRevert();
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_rejects_a_larger_release() public noteFixtures {
        _depositsAndAdvance();
        _gate();
        DarkPoolShieldedPool.Transaction memory t = _withdrawal();
        t.released = t.released + 1;
        vm.expectRevert();
        pool.transact(t, _proof("transact_withdraw"), "");
    }

    function test_rejects_a_root_not_yet_appended() public noteFixtures {
        _deposits();
        _gate();
        vm.expectRevert(DarkPoolShieldedPool.UnknownRoot.selector);
        pool.transact(_withdrawal(), _proof("transact_withdraw"), "");
    }

    function test_rejects_an_inflated_deposit() public noteFixtures {
        uint256 amount = _nu(".deposits[0].amount") + 1;
        vm.prank(DEPOSITOR);
        vm.expectRevert();
        pool.deposit{value: amount}(address(0), amount, _nb(".deposits[0].commitment"), _proof("deposit_0"));
    }

    function test_rejects_a_deposit_under_another_label() public noteFixtures {
        uint256 amount = _nu(".deposits[0].amount");
        vm.expectRevert(); // another depositor's first label
        pool.deposit{value: amount}(address(0), amount, _nb(".deposits[0].commitment"), _proof("deposit_0"));
        vm.startPrank(DEPOSITOR);
        pool.deposit{value: amount}(address(0), amount, _nb(".deposits[0].commitment"), _proof("deposit_0"));
        vm.expectRevert(); // the same proof again: the nonce moved on
        pool.deposit{value: amount}(address(0), amount, _nb(".deposits[0].commitment"), _proof("deposit_0"));
        vm.stopPrank();
    }

    function test_deposit_fee_goes_to_its_recipient() public noteFixtures {
        address recipient = address(0xFEE5);
        uint256 fee = 2e14;
        pool.setDepositFee(recipient, fee);
        assertEq(pool.depositFee(), fee);
        uint256 amount = _nu(".deposits[0].amount");
        bytes32 commitment = _nb(".deposits[0].commitment");
        vm.startPrank(DEPOSITOR);
        vm.expectRevert(DarkPoolShieldedPool.BadAmount.selector);
        pool.deposit{value: amount}(address(0), amount, commitment, _proof("deposit_0"));
        vm.expectRevert(DarkPoolShieldedPool.BadAmount.selector);
        pool.deposit{value: amount + fee + 1}(address(0), amount, commitment, _proof("deposit_0"));
        pool.deposit{value: amount + fee}(address(0), amount, commitment, _proof("deposit_0"));
        vm.stopPrank();
        assertEq(recipient.balance, fee);
        assertEq(POOL.balance, amount, "the note holds the amount, not the fee");
    }

    function test_deposit_fee_guards() public {
        uint256 tooHigh = pool.MAX_DEPOSIT_FEE() + 1;
        vm.expectRevert(DarkPoolShieldedPool.BadFee.selector);
        pool.setDepositFee(address(0xFEE5), tooHigh);
        vm.expectRevert(DarkPoolShieldedPool.ZeroAddress.selector);
        pool.setDepositFee(address(0), 1);
        pool.setDepositFee(address(0), 0);
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolShieldedPool.NotOwner.selector);
        pool.setDepositFee(address(0xCAFE), 1);
    }

    function test_deposit_labels_are_per_depositor_nonce() public {
        uint256 a = pool.depositLabel(DEPOSITOR);
        assertEq(a, uint256(keccak256(abi.encode(block.chainid, POOL, DEPOSITOR, uint256(0)))) % FIELD);
        assertTrue(a != pool.depositLabel(address(0xCAFE)));
        stdstore.target(POOL).sig("depositNonce(address)").with_key(DEPOSITOR).checked_write(uint256(1));
        assertEq(pool.depositLabel(DEPOSITOR), uint256(keccak256(abi.encode(block.chainid, POOL, DEPOSITOR, uint256(1)))) % FIELD);
    }

    // --- admin -----------------------------------------------------------------

    function test_timelock_owns_the_pool() public {
        DarkPoolTimelock lock = new DarkPoolTimelock(address(this), 2 days);
        pool.transferOwnership(address(lock));
        lock.execute(POOL, abi.encodeWithSignature("acceptOwnership()")); // no delay for taking ownership
        assertEq(pool.owner(), address(lock));
        vm.expectRevert(DarkPoolShieldedPool.NotOwner.selector);
        pool.setFee(bytes32(uint256(7)), 9);

        bytes memory call = abi.encodeCall(DarkPoolShieldedPool.setFee, (bytes32(uint256(7)), 9));
        vm.expectRevert(DarkPoolTimelock.NotReady.selector); // not scheduled
        lock.execute(POOL, call);
        lock.schedule(POOL, call);
        vm.expectRevert(DarkPoolTimelock.AlreadyScheduled.selector);
        lock.schedule(POOL, call);
        vm.warp(block.timestamp + 2 days - 1);
        vm.expectRevert(DarkPoolTimelock.NotReady.selector);
        lock.execute(POOL, call);
        vm.warp(block.timestamp + 1);
        lock.execute(POOL, call);
        assertEq(pool.feeBps(), 9);
        vm.expectRevert(DarkPoolTimelock.NotReady.selector); // once per schedule
        lock.execute(POOL, call);

        lock.schedule(POOL, call);
        lock.cancel(lock.idOf(POOL, call));
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(DarkPoolTimelock.NotReady.selector);
        lock.execute(POOL, call);

        bytes memory failing = abi.encodeCall(DarkPoolShieldedPool.setFee, (bytes32(uint256(7)), 101));
        lock.schedule(POOL, failing);
        vm.warp(block.timestamp + 2 days);
        vm.expectRevert(abi.encodeWithSelector(DarkPoolTimelock.CallFailed.selector, abi.encodeWithSelector(DarkPoolShieldedPool.BadFee.selector)));
        lock.execute(POOL, failing);
    }

    function test_timelock_admin_guards() public {
        DarkPoolTimelock lock = new DarkPoolTimelock(address(this), 1 days);
        vm.startPrank(address(0xCAFE));
        vm.expectRevert(DarkPoolTimelock.NotAdmin.selector);
        lock.schedule(POOL, "");
        vm.expectRevert(DarkPoolTimelock.NotAdmin.selector);
        lock.execute(POOL, abi.encodeWithSignature("acceptOwnership()"));
        vm.expectRevert(DarkPoolTimelock.NotAdmin.selector);
        lock.cancel(0);
        vm.stopPrank();
        vm.expectRevert(DarkPoolTimelock.NotSelf.selector);
        lock.setAdmin(address(0xCAFE));

        bytes memory call = abi.encodeCall(DarkPoolTimelock.setAdmin, (address(0xCAFE)));
        lock.schedule(address(lock), call);
        vm.warp(block.timestamp + 1 days);
        lock.execute(address(lock), call);
        assertEq(lock.admin(), address(0xCAFE));
        vm.expectRevert(DarkPoolTimelock.NotAdmin.selector);
        lock.schedule(POOL, "");
    }

    function test_disclosure_registry_publishes_grants() public {
        DarkPoolDisclosureRegistry registry = new DarkPoolDisclosureRegistry();
        vm.expectEmit(address(registry));
        emit DarkPoolDisclosureRegistry.Disclosed(bytes32(uint256(0xa0d17)), address(this), hex"c1");
        registry.disclose(bytes32(uint256(0xa0d17)), hex"c1");
        vm.expectRevert(DarkPoolDisclosureRegistry.EmptyGrant.selector);
        registry.disclose(bytes32(uint256(0xa0d17)), "");
    }

    function test_rejects_a_wrong_tree_root() public noteFixtures {
        _deposits();
        vm.expectRevert();
        pool.advanceTree(3, bytes32(uint256(_nb(".root")) ^ 1), _proof("advance"));
    }

    function test_session_matches_x0() public {
        string memory path = string.concat(DIR, "session.json");
        if (!vm.exists(path)) vm.skip(true);
        string memory j = vm.readFile(path);
        uint256[] memory times = vm.parseJsonUintArray(j, ".times");
        bool[] memory open = vm.parseJsonBoolArray(j, ".open");
        assertEq(times.length, open.length);
        for (uint256 i; i < times.length; i++) {
            assertEq(pool.inSession(times[i]), open[i], vm.toString(times[i]));
        }
    }

    function test_screening_gate_blocks_deposits() public {
        DarkPoolScreeningGate gate = new DarkPoolScreeningGate(address(this), address(0));
        pool.setGate(IScreeningGate(address(gate)));
        address[] memory who = new address[](1);
        who[0] = address(this);

        gate.setBlocked(who, true);
        vm.expectRevert(DarkPoolShieldedPool.Blocked.selector);
        pool.deposit{value: 1}(address(0), 1, bytes32(0), "");

        gate.setBlocked(who, false);
        assertTrue(gate.allowed(address(this)));
        MockSanctions list = new MockSanctions();
        list.set(address(this));
        gate.setSanctions(ISanctionsList(address(list)));
        assertFalse(gate.allowed(address(this)));
        vm.expectRevert(DarkPoolShieldedPool.Blocked.selector);
        pool.deposit{value: 1}(address(0), 1, bytes32(0), "");

        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolScreeningGate.NotOwner.selector);
        gate.setBlocked(who, true);
    }

    function test_advance_needs_queued_commitments() public {
        vm.expectRevert(DarkPoolShieldedPool.BadCount.selector);
        pool.advanceTree(1, bytes32(0), "");
    }

    function test_deposit_guards() public {
        vm.expectRevert(DarkPoolShieldedPool.BadAmount.selector);
        pool.deposit{value: 1}(address(0), 2, bytes32(0), "");

        vm.expectRevert(DarkPoolShieldedPool.AssetNotAllowed.selector);
        pool.deposit(address(0x70CE), 1, bytes32(0), "");

        pool.setDepositsPaused(true);
        vm.expectRevert(DarkPoolShieldedPool.IsPaused.selector);
        pool.deposit{value: 1}(address(0), 1, bytes32(0), "");

        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolShieldedPool.NotOwner.selector);
        pool.setAllowed(address(0x70CE), true);
    }

    // --- venue ---------------------------------------------------------------

    modifier venueFixtures() {
        string memory path = string.concat(DIR, "venue.json");
        if (!vm.exists(path)) vm.skip(true);
        venue = vm.readFile(path);
        _;
    }

    function _b(string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(venue, key);
    }

    function _u(string memory key) internal view returns (uint256) {
        return uint256(vm.parseJsonBytes32(venue, key));
    }

    function _placement(string memory side) internal view returns (DarkPoolShieldedPool.Placement memory) {
        string memory k = string.concat(".", side, ".");
        return DarkPoolShieldedPool.Placement({
            root: _b(string.concat(k, "root")),
            nullifier: _b(string.concat(k, "spent")),
            feeNullifier: _b(string.concat(k, "feeSpent")),
            change: _b(string.concat(k, "change")),
            feeChange: _b(string.concat(k, "feeChange")),
            commitment: _b(string.concat(k, "commitment")),
            relayer: vm.parseJsonAddress(venue, string.concat(k, "relayer")),
            fee: _u(string.concat(k, "fee"))
        });
    }

    /// Market, feeds and fee owner as the fixture expects; the three notes deposited and appended.
    function _prepare() internal {
        MockStock stock = MockStock(TOKEN);
        deployCodeTo("DarkPoolShieldedPool.t.sol:MockStock", TOKEN);
        aaplFeed = new MockFeed();
        ethFeed = new MockFeed();
        pool.setEthUsdFeed(IChainlinkFeed(address(ethFeed)));
        pool.setMarket(TOKEN, address(aaplFeed), 1e12, true);
        pool.setAllowed(TOKEN, true);
        pool.setFee(_b(".feeOwner"), 5);
        vm.warp(_u(".open"));

        for (uint256 i; i < 3; i++) {
            string memory d = string.concat(".deposits[", vm.toString(i), "]");
            address asset = address(uint160(_u(string.concat(d, ".asset"))));
            uint256 amount = _u(string.concat(d, ".amount"));
            if (asset != address(0)) {
                stock.mint(DEPOSITOR, amount);
                vm.prank(DEPOSITOR);
                stock.approve(POOL, amount);
            }
            vm.prank(DEPOSITOR);
            pool.deposit{value: asset == address(0) ? amount : 0}(asset, amount, _b(string.concat(d, ".commitment")), _proof(string.concat("venue_deposit_", vm.toString(i))));
        }
        pool.advanceTree(3, _b(".root1"), _proof("venue_advance1"));
    }

    /// ... and both orders placed: the buy self-submitted, the sell relayed.
    function _placeOrders() internal returns (uint256 epoch) {
        _prepare();
        uint256 g = gasleft();
        pool.placeOrder(TOKEN, _placement("buy"), _proof("venue_order_0"), hex"b0");
        emit log_named_uint("placeOrder gas", g - gasleft());
        vm.expectEmit(POOL);
        emit DarkPoolShieldedPool.OrderFeePaid(RELAYER, _u(".sell.fee")); // solvency reads fees leaving the pool from this
        vm.prank(RELAYER);
        g = gasleft();
        pool.placeOrder(TOKEN, _placement("sell"), _proof("venue_order_1"), hex"5e");
        emit log_named_uint("placeOrder (relayed) gas", g - gasleft());
        epoch = _u(".epoch");
    }

    function _seal(uint256 epoch) internal {
        uint256 end = (epoch + 1) * pool.WINDOW();
        uint80 aRound = aaplFeed.push(int256(_u(".refAnswer")), end - 600);
        uint80 eRound = ethFeed.push(int256(_u(".ethAnswer")), end - 3600);
        vm.expectRevert(DarkPoolShieldedPool.WindowOpen.selector);
        pool.seal(TOKEN, epoch, aRound, eRound);

        vm.warp(end + 5);
        aaplFeed.push(int256(_u(".refAnswer")) * 2, end + 1); // after the end: aRound stays the window's round
        pool.seal(TOKEN, epoch, aRound, eRound);
    }

    function _settlement() internal view returns (DarkPoolShieldedPool.Settlement memory s) {
        bytes32[] memory fills = vm.parseJsonBytes32Array(venue, ".fills");
        bytes32[] memory residuals = vm.parseJsonBytes32Array(venue, ".residuals");
        bool[] memory rolls = vm.parseJsonBoolArray(venue, ".rolls");
        for (uint256 i; i < 64; i++) {
            s.fills[i] = fills[i];
            s.residuals[i] = residuals[i];
            if (i < rolls.length) s.rolls[i] = rolls[i];
        }
        s.feeNote = _b(".feeNote");
    }

    function test_venue_place_seal_settle_withdraw() public venueFixtures {
        uint256 epoch = _placeOrders();
        assertEq(pool.windowOrderList(TOKEN, epoch).length, 2);
        assertEq(pool.openOrders(TOKEN), 2);
        assertEq(pool.commitmentCount(), 6); // three notes, two changes, one fee change
        assertEq(RELAYER.balance, _u(".sell.fee"), "the relayer is paid from the seller's fee note");

        _seal(epoch);
        (bool isSealed,, bool live, uint64 refUsd, uint64 ethUsd, uint16 bps,,,,) = pool.windows(TOKEN, epoch);
        assertTrue(isSealed);
        assertTrue(live);
        assertEq(refUsd, 200e6);
        assertEq(ethUsd, 4000e6);
        assertEq(bps, 5);

        DarkPoolShieldedPool.Settlement memory s = _settlement();
        uint256 g = gasleft();
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle"), "");
        emit log_named_uint("settleWindow gas", g - gasleft());
        assertEq(pool.openOrders(TOKEN), 1); // the buy's remainder rests again
        bytes32[] memory resting = pool.windowOrderList(TOKEN, block.timestamp / pool.WINDOW());
        assertEq(resting.length, 1);
        assertEq(resting[0], s.residuals[0]);
        assertEq(pool.commitmentCount(), 3 + _u(".advance2Count"));

        vm.expectRevert(DarkPoolShieldedPool.AlreadySettled.selector);
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle"), "");
        vm.warp((epoch + 1) * pool.WINDOW() + pool.SETTLE_DEADLINE());
        vm.expectRevert(DarkPoolShieldedPool.AlreadySettled.selector);
        pool.abandon(TOKEN, epoch);

        pool.advanceTree(_u(".advance2Count"), _b(".root2"), _proof("venue_advance2"));
        DarkPoolShieldedPool.Transaction memory t;
        t.root = _b(".root2");
        t.nullifiers[0] = _b(".withdrawal.nullifier0");
        t.nullifiers[1] = _b(".withdrawal.nullifier1");
        t.outputs[0] = _b(".withdrawal.output0");
        t.outputs[1] = _b(".withdrawal.output1");
        t.released = _u(".payout");
        t.to = TO;
        pool.transact(t, _proof("venue_withdraw"), "");
        assertEq(TO.balance, _u(".payout")); // the seller's 2 AAPL at $200, less 5 bps, in ETH
    }

    function test_venue_rejects_a_tampered_settlement() public venueFixtures {
        uint256 epoch = _placeOrders();
        _seal(epoch);
        DarkPoolShieldedPool.Settlement memory s = _settlement();
        s.rolls[0] = false; // file the buy's rolled remainder as a note
        vm.expectRevert();
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle"), "");
    }

    function test_relayed_order_fee_is_bound_to_its_relayer() public venueFixtures {
        _prepare();
        DarkPoolShieldedPool.Placement memory p = _placement("sell");
        p.relayer = address(0xBAD);
        vm.expectRevert();
        pool.placeOrder(TOKEN, p, _proof("venue_order_1"), "");

        p = _placement("sell");
        p.fee = p.fee + 1;
        vm.expectRevert();
        pool.placeOrder(TOKEN, p, _proof("venue_order_1"), "");

        DarkPoolShieldedPool.Placement memory b = _placement("buy");
        b.feeChange = bytes32(uint256(1)); // a self-submitted order carries no fee note
        vm.expectRevert(DarkPoolShieldedPool.BadFee.selector);
        pool.placeOrder(TOKEN, b, _proof("venue_order_0"), "");
    }

    function test_relayed_order_spends_its_fee_note() public venueFixtures {
        _prepare();
        pool.placeOrder(TOKEN, _placement("sell"), _proof("venue_order_1"), "");
        DarkPoolShieldedPool.Placement memory b = _placement("buy");
        b.fee = 1;
        b.relayer = RELAYER;
        b.feeNullifier = _b(".sell.feeSpent"); // the fee note the sell already paid with
        vm.expectRevert(DarkPoolShieldedPool.NoteSpent.selector);
        pool.placeOrder(TOKEN, b, _proof("venue_order_0"), "");
    }

    function test_abandoned_window_is_reclaimed_by_its_owners() public venueFixtures {
        uint256 epoch = _placeOrders();
        _seal(epoch);
        vm.expectRevert(DarkPoolShieldedPool.NotAbandoned.selector);
        pool.reclaim(TOKEN, epoch, 0, _b(".reclaim0.spent"), _b(".reclaim0.refund"), _proof("venue_reclaim_0"));

        uint256 deadline = (epoch + 1) * pool.WINDOW() + pool.SETTLE_DEADLINE();
        vm.warp(deadline - 1);
        vm.expectRevert(DarkPoolShieldedPool.TooEarly.selector);
        pool.abandon(TOKEN, epoch);
        vm.warp(deadline);
        pool.abandon(TOKEN, epoch);
        assertEq(pool.openOrders(TOKEN), 0);
        vm.expectRevert(DarkPoolShieldedPool.AlreadyAbandoned.selector); // the open-order count is released only once
        pool.abandon(TOKEN, epoch);

        DarkPoolShieldedPool.Settlement memory s = _settlement();
        vm.expectRevert(DarkPoolShieldedPool.AlreadyAbandoned.selector);
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle"), "");

        uint256 g = gasleft();
        pool.reclaim(TOKEN, epoch, 0, _b(".reclaim0.spent"), _b(".reclaim0.refund"), _proof("venue_reclaim_0"));
        emit log_named_uint("reclaim gas", g - gasleft());
        assertEq(pool.commitments(pool.commitmentCount() - 1), _b(".reclaim0.refund"));

        vm.expectRevert(DarkPoolShieldedPool.NoteSpent.selector);
        pool.reclaim(TOKEN, epoch, 0, _b(".reclaim0.spent"), _b(".reclaim0.refund"), _proof("venue_reclaim_0"));
        vm.expectRevert(); // the sell's proof does not open the buy's slot
        pool.reclaim(TOKEN, epoch, 0, _b(".reclaim1.spent"), _b(".reclaim1.refund"), _proof("venue_reclaim_1"));

        pool.reclaim(TOKEN, epoch, 1, _b(".reclaim1.spent"), _b(".reclaim1.refund"), _proof("venue_reclaim_1"));
        assertEq(pool.commitments(pool.commitmentCount() - 1), _b(".reclaim1.refund"));
    }

    function test_abandoned_window_cannot_be_sealed() public venueFixtures {
        uint256 epoch = _placeOrders();
        uint256 end = (epoch + 1) * pool.WINDOW();
        uint80 aRound = aaplFeed.push(int256(_u(".refAnswer")), end - 600);
        uint80 eRound = ethFeed.push(int256(_u(".ethAnswer")), end - 600);
        vm.warp(end + pool.SETTLE_DEADLINE());
        pool.abandon(TOKEN, epoch);
        vm.expectRevert(DarkPoolShieldedPool.AlreadyAbandoned.selector);
        pool.seal(TOKEN, epoch, aRound, eRound);
    }

    function test_place_order_stops_at_the_venue_cap() public venueFixtures {
        _prepare();
        stdstore.target(POOL).sig("openOrders(address)").with_key(TOKEN).checked_write(uint256(64));
        vm.expectRevert(DarkPoolShieldedPool.VenueFull.selector);
        pool.placeOrder(TOKEN, _placement("buy"), _proof("venue_order_0"), "");
    }

    function test_seal_rejects_a_superseded_round() public venueFixtures {
        uint256 epoch = _placeOrders();
        uint256 end = (epoch + 1) * pool.WINDOW();
        uint80 old = aaplFeed.push(int256(_u(".refAnswer")), end - 600);
        aaplFeed.push(int256(_u(".refAnswer")) + 1, end - 10); // the round actually current at the end
        uint80 eRound = ethFeed.push(int256(_u(".ethAnswer")), end - 600);
        vm.warp(end + 5);
        vm.expectRevert(DarkPoolShieldedPool.BadRound.selector);
        pool.seal(TOKEN, epoch, old, eRound);
    }

    function test_seal_marks_stale_or_paused_references_not_live() public venueFixtures {
        uint256 epoch = _placeOrders();
        uint256 end = (epoch + 1) * pool.WINDOW();
        uint80 aRound = aaplFeed.push(int256(_u(".refAnswer")), end - pool.MAX_STALENESS() - 1);
        uint80 eRound = ethFeed.push(int256(_u(".ethAnswer")), end - 600);
        vm.warp(end + 5);
        uint256 snap = vm.snapshotState();
        pool.seal(TOKEN, epoch, aRound, eRound);
        (,, bool live,,,,,,,) = pool.windows(TOKEN, epoch);
        assertFalse(live); // stale

        vm.revertToState(snap);
        uint80 freshRound = aaplFeed.push(int256(_u(".refAnswer")), end - 600);
        MockStock(TOKEN).setOraclePaused(true);
        pool.seal(TOKEN, epoch, freshRound, eRound);
        (,, live,,,,,,,) = pool.windows(TOKEN, epoch);
        assertFalse(live); // paused
    }

    // --- backstop (X2) ---------------------------------------------------------

    function _backstopSettlement() internal view returns (DarkPoolShieldedPool.Settlement memory s) {
        bytes32[] memory fills = vm.parseJsonBytes32Array(venue, ".backstop.fills");
        bytes32[] memory residuals = vm.parseJsonBytes32Array(venue, ".backstop.residuals");
        bool[] memory rolls = vm.parseJsonBoolArray(venue, ".backstop.rolls");
        for (uint256 i; i < 64; i++) {
            s.fills[i] = fills[i];
            s.residuals[i] = residuals[i];
            if (i < rolls.length) s.rolls[i] = rolls[i];
        }
        s.feeNote = _b(".backstop.feeNote");
        s.bsSold = _u(".backstop.sold");
        s.bsEthIn = _u(".backstop.ethIn");
        s.bsBought = _u(".backstop.bought");
        s.bsEthOut = _u(".backstop.ethOut");
    }

    /// A backstop vault holding 5 AAPL and 1 ETH at 50 bps (the fixture offer), attached to the pool.
    function _vault() internal returns (DarkPoolBackstopVault vault) {
        vault = new DarkPoolBackstopVault(address(this), ISwapRouter02(address(0)), IWETH9(address(0xEEE)), IChainlinkPrice(address(ethFeed)));
        vault.setBook(TOKEN, address(aaplFeed), 50, 0, true, 5 ether, 1 ether);
        vault.setPool(POOL);
        aaplFeed.push(int256(_u(".refAnswer")), block.timestamp);
        ethFeed.push(int256(_u(".ethAnswer")), block.timestamp);
        MockStock(TOKEN).mint(address(this), 5 ether);
        MockStock(TOKEN).approve(address(vault), 5 ether);
        vm.deal(address(this), 2 ether);
        vault.deposit{value: 1 ether}(TOKEN, 5 ether);
        pool.setBackstop(IBackstopVault(address(vault)));
    }

    function test_venue_settles_a_backstop_leg() public venueFixtures {
        uint256 epoch = _placeOrders();
        DarkPoolBackstopVault vault = _vault();
        _seal(epoch);
        (,,,,,,, uint64 bsQty, uint64 bsEth, uint16 bsSpread) = pool.windows(TOKEN, epoch);
        assertEq(bsQty, _u(".backstop.offer.qty"), "offer pinned at seal");
        assertEq(bsEth, _u(".backstop.offer.eth"));
        assertEq(bsSpread, _u(".backstop.offer.spreadBps"));

        DarkPoolShieldedPool.Settlement memory s = _backstopSettlement();
        assertEq(s.bsSold, 1e6, "the buy remainder, 1 AAPL, comes from the vault");
        uint256 poolEth = POOL.balance;
        uint256 poolAapl = MockStock(TOKEN).balanceOf(POOL);
        vm.expectEmit(POOL);
        emit DarkPoolShieldedPool.BackstopSettled(TOKEN, epoch, s.bsSold * 1e12, s.bsEthIn * 1e12, s.bsBought * 1e12, s.bsEthOut * 1e12);
        uint256 g = gasleft();
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle_bs"), "");
        emit log_named_uint("settleWindow with backstop gas", g - gasleft());
        assertEq(MockStock(TOKEN).balanceOf(POOL), poolAapl + 1 ether);
        assertEq(POOL.balance, poolEth - s.bsEthIn * 1e12);
        (,,,,, uint256 vEth, uint256 vTokens,,,) = vault.books(TOKEN);
        assertEq(vTokens, 4 ether);
        assertEq(vEth, 1 ether + s.bsEthIn * 1e12);
        assertEq(pool.openOrders(TOKEN), 0, "the buy filled completely, nothing rolls");
    }

    function test_backstop_leg_must_match_the_proof() public venueFixtures {
        uint256 epoch = _placeOrders();
        _vault();
        _seal(epoch);
        DarkPoolShieldedPool.Settlement memory s = _backstopSettlement();
        s.bsEthIn -= 1;
        vm.expectRevert();
        pool.settleWindow(TOKEN, epoch, s, _proof("venue_settle_bs"), "");
    }

    function test_backstop_offer_is_pinned_at_seal() public venueFixtures {
        uint256 epoch = _placeOrders();
        _seal(epoch); // no vault at seal: the window offers nothing
        _vault(); // attaching one afterwards changes nothing for this window
        vm.expectRevert();
        pool.settleWindow(TOKEN, epoch, _backstopSettlement(), _proof("venue_settle_bs"), "");
    }

    function test_pool_takes_plain_eth_only_from_the_vault() public {
        (bool ok,) = POOL.call{value: 1}("");
        assertFalse(ok);
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolShieldedPool.NotOwner.selector);
        pool.setBackstop(IBackstopVault(address(0xCAFE)));
    }

    /// Seals the venue window with a stand-in vault offering `qty` at `spread`; returns the quantity the pool pinned.
    function _sealWithOffer(uint256 epoch, bool live, uint256 qty, uint16 spread) internal returns (uint64 pinned) {
        MockBackstop mock = new MockBackstop();
        mock.setOffer(qty, 1e6, spread);
        pool.setBackstop(IBackstopVault(address(mock)));
        uint256 end = (epoch + 1) * pool.WINDOW();
        uint80 aRound = aaplFeed.push(int256(_u(".refAnswer")), live ? end - 600 : end - pool.MAX_STALENESS() - 1);
        uint80 eRound = ethFeed.push(int256(_u(".ethAnswer")), end - 600);
        vm.warp(end + 5);
        pool.seal(TOKEN, epoch, aRound, eRound);
        (,,,,,,, pinned,,) = pool.windows(TOKEN, epoch);
    }

    function test_backstop_offer_only_for_live_windows_and_within_bounds() public venueFixtures {
        uint256 epoch = _placeOrders();
        uint256 snap = vm.snapshotState();
        assertEq(_sealWithOffer(epoch, true, 5e6, 50), 5e6, "a live window pins the offer");
        vm.revertToState(snap);
        assertEq(_sealWithOffer(epoch, false, 5e6, 50), 0, "a window that is not live pins none");
        vm.revertToState(snap);
        assertEq(_sealWithOffer(epoch, true, uint256(type(uint64).max) + 5, 50), 0, "an offer that does not fit is ignored, not truncated");
        vm.revertToState(snap);
        assertEq(_sealWithOffer(epoch, true, 5e6, 201), 0, "a spread above the cap is ignored");
    }

    function test_backstop_vault_must_deliver_what_it_sold() public venueFixtures {
        uint256 epoch = _placeOrders();
        MockBackstop mock = new MockBackstop();
        mock.setOffer(_u(".backstop.offer.qty"), _u(".backstop.offer.eth"), uint16(_u(".backstop.offer.spreadBps")));
        MockStock(TOKEN).mint(address(mock), 5 ether);
        mock.setShort(1);
        pool.setBackstop(IBackstopVault(address(mock)));
        _seal(epoch);
        vm.expectRevert(DarkPoolShieldedPool.TransferFailed.selector);
        pool.settleWindow(TOKEN, epoch, _backstopSettlement(), _proof("venue_settle_bs"), "");
        mock.setShort(0);
        pool.settleWindow(TOKEN, epoch, _backstopSettlement(), _proof("venue_settle_bs"), "");
        assertEq(MockStock(TOKEN).balanceOf(address(mock)), 4 ether);
    }
}

/// A backstop vault stand-in: offers what it is told and can deliver fewer tokens than it sold.
contract MockBackstop {
    uint256 public qty;
    uint256 public eth;
    uint16 public spread;
    uint256 public shortBy;

    function setOffer(uint256 qty_, uint256 eth_, uint16 spread_) external {
        (qty, eth, spread) = (qty_, eth_, spread_);
    }

    function setShort(uint256 shortBy_) external {
        shortBy = shortBy_;
    }

    function offer(address, uint256) external view returns (uint256, uint256, uint16) {
        return (qty, eth, spread);
    }

    function exchange(address asset, uint256 tokensSold, uint256 tokensBought, uint256 ethOut) external payable {
        if (tokensBought != 0) MockStock(asset).transferFrom(msg.sender, address(this), tokensBought);
        MockStock(asset).transfer(msg.sender, tokensSold - shortBy);
        if (ethOut != 0) {
            (bool ok,) = msg.sender.call{value: ethOut}("");
            require(ok, "eth");
        }
    }
}
