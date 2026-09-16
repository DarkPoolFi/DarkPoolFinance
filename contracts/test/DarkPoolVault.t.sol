// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DarkPoolVault} from "../src/DarkPoolVault.sol";

contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) public virtual returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public virtual returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal virtual {
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Burns 1% on every transfer.
contract FeeToken is MockToken {
    function _move(address from, address to, uint256 amount) internal override {
        balanceOf[from] -= amount;
        balanceOf[to] += amount - amount / 100;
    }
}

/// USDT-style: no return values.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// Returns false instead of reverting.
contract FalseToken is MockToken {
    function transfer(address, uint256) public pure override returns (bool) {
        return false;
    }
}

/// Re-enters the vault once from inside transferFrom and records how the inner call failed.
contract ReentrantToken is MockToken {
    DarkPoolVault public vault;
    bytes public innerError;
    bool private reentered;

    function setVault(DarkPoolVault v) external {
        vault = v;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (!reentered) {
            reentered = true;
            try vault.deposit(address(this), 1) {} catch (bytes memory err) {
                innerError = err;
            }
        }
        return super.transferFrom(from, to, amount);
    }
}

contract DarkPoolVaultTest is Test {
    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount, bytes32 indexed ref);

    DarkPoolVault vault;
    MockToken token;
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        vault = new DarkPoolVault(owner, operator);
        token = new MockToken();
        vm.prank(owner);
        vault.setAllowed(address(token), true);
        token.mint(alice, 1_000e18);
        vm.prank(alice);
        token.approve(address(vault), type(uint256).max);
    }

    function _deposit(address user, uint256 amount) internal {
        vm.prank(user);
        vault.deposit(address(token), amount);
    }

    // --- deposits --------------------------------------------------------------

    function test_deposit_emits_and_holds() public {
        vm.expectEmit(address(vault));
        emit Deposited(alice, address(token), 5e18);
        _deposit(alice, 5e18);
        assertEq(token.balanceOf(address(vault)), 5e18);
        assertEq(token.balanceOf(alice), 995e18);
    }

    function test_deposit_rejects_unlisted_token() public {
        MockToken other = new MockToken();
        vm.prank(alice);
        vm.expectRevert(DarkPoolVault.TokenNotAllowed.selector);
        vault.deposit(address(other), 1);
    }

    function test_deposit_rejects_zero() public {
        vm.prank(alice);
        vm.expectRevert(DarkPoolVault.ZeroAmount.selector);
        vault.deposit(address(token), 0);
    }

    function test_deposit_without_allowance_reverts() public {
        token.mint(bob, 1e18);
        vm.prank(bob);
        vm.expectRevert(DarkPoolVault.TransferFailed.selector);
        vault.deposit(address(token), 1e18);
    }

    function test_fee_on_transfer_emits_received_amount() public {
        FeeToken fee = new FeeToken();
        vm.prank(owner);
        vault.setAllowed(address(fee), true);
        fee.mint(alice, 100e18);
        vm.startPrank(alice);
        fee.approve(address(vault), type(uint256).max);
        vm.expectEmit(address(vault));
        emit Deposited(alice, address(fee), 99e18);
        vault.deposit(address(fee), 100e18);
        vm.stopPrank();
    }

    function test_no_return_token_supported() public {
        NoReturnToken nr = new NoReturnToken();
        vm.prank(owner);
        vault.setAllowed(address(nr), true);
        nr.mint(alice, 10e18);
        vm.startPrank(alice);
        nr.approve(address(vault), type(uint256).max);
        vault.deposit(address(nr), 10e18);
        vm.stopPrank();
        vm.prank(operator);
        vault.withdraw(address(nr), bob, 4e18, "w1");
        assertEq(nr.balanceOf(bob), 4e18);
        assertEq(nr.balanceOf(address(vault)), 6e18);
    }

    function test_reentrancy_blocked() public {
        ReentrantToken re = new ReentrantToken();
        re.setVault(vault);
        vm.prank(owner);
        vault.setAllowed(address(re), true);
        re.mint(alice, 10e18);
        vm.startPrank(alice);
        re.approve(address(vault), type(uint256).max);
        vault.deposit(address(re), 1e18);
        vm.stopPrank();
        assertEq(re.innerError(), abi.encodeWithSelector(DarkPoolVault.Reentrancy.selector), "re-entry rejected by the guard");
        assertEq(re.balanceOf(address(vault)), 1e18, "only the outer deposit landed");
    }

    // --- withdrawals -----------------------------------------------------------

    function test_withdraw_exact_amount() public {
        _deposit(alice, 10e18);
        vm.expectEmit(address(vault));
        emit Withdrawn(bob, address(token), 3e18, "w1");
        vm.prank(operator);
        vault.withdraw(address(token), bob, 3e18, "w1");
        assertEq(token.balanceOf(address(vault)), 7e18);
        assertEq(token.balanceOf(bob), 3e18);
        assertTrue(vault.refUsed("w1"));
    }

    function testFuzz_withdraw_decreases_balance_by_exactly_amount(uint256 deposited, uint256 amount) public {
        deposited = bound(deposited, 1, 1_000e18);
        amount = bound(amount, 1, deposited);
        _deposit(alice, deposited);
        uint256 before = token.balanceOf(address(vault));
        vm.prank(operator);
        vault.withdraw(address(token), bob, amount, keccak256(abi.encode(deposited, amount)));
        assertEq(before - token.balanceOf(address(vault)), amount);
        assertEq(token.balanceOf(bob), amount);
    }

    function test_withdraw_only_operator() public {
        _deposit(alice, 10e18);
        for (uint256 i; i < 3; i++) {
            address caller = [alice, owner, bob][i];
            vm.prank(caller);
            vm.expectRevert(DarkPoolVault.NotOperator.selector);
            vault.withdraw(address(token), caller, 1e18, "w1");
        }
    }

    function test_ref_is_single_use_and_required() public {
        _deposit(alice, 10e18);
        vm.startPrank(operator);
        vault.withdraw(address(token), bob, 1e18, "w1");
        vm.expectRevert(DarkPoolVault.RefUsed.selector);
        vault.withdraw(address(token), bob, 1e18, "w1");
        vm.expectRevert(DarkPoolVault.ZeroRef.selector);
        vault.withdraw(address(token), bob, 1e18, bytes32(0));
        vm.stopPrank();
        assertEq(token.balanceOf(bob), 1e18, "retry with the same ref paid nothing");
    }

    function test_withdraw_rejects_zero_amount_zero_to_and_overdraw() public {
        _deposit(alice, 1e18);
        vm.startPrank(operator);
        vm.expectRevert(DarkPoolVault.ZeroAmount.selector);
        vault.withdraw(address(token), bob, 0, "a");
        vm.expectRevert(DarkPoolVault.ZeroAddress.selector);
        vault.withdraw(address(token), address(0), 1, "b");
        vm.expectRevert(DarkPoolVault.TransferFailed.selector);
        vault.withdraw(address(token), bob, 2e18, "c");
        vm.stopPrank();
        assertFalse(vault.refUsed("c"), "a failed withdrawal does not burn its ref");
    }

    function test_false_returning_token_reverts() public {
        FalseToken ft = new FalseToken();
        ft.mint(address(vault), 1e18);
        vm.prank(operator);
        vm.expectRevert(DarkPoolVault.TransferFailed.selector);
        vault.withdraw(address(ft), bob, 1e18, "w1");
    }

    function test_non_contract_token_reverts() public {
        vm.prank(operator);
        vm.expectRevert(DarkPoolVault.TransferFailed.selector);
        vault.withdraw(makeAddr("eoa"), bob, 1, "w1");
    }

    function test_operator_can_return_unlisted_token_sent_by_mistake() public {
        MockToken stray = new MockToken();
        stray.mint(address(vault), 5e18);
        vm.prank(operator);
        vault.withdraw(address(stray), alice, 5e18, "rescue");
        assertEq(stray.balanceOf(alice), 5e18);
    }

    // --- admin -----------------------------------------------------------------

    function test_pause_blocks_deposits_and_withdrawals() public {
        _deposit(alice, 2e18);
        vm.prank(owner);
        vault.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(DarkPoolVault.IsPaused.selector);
        vault.deposit(address(token), 1e18);
        vm.prank(operator);
        vm.expectRevert(DarkPoolVault.IsPaused.selector);
        vault.withdraw(address(token), bob, 1e18, "w1");
        vm.prank(owner);
        vault.setPaused(false);
        vm.prank(operator);
        vault.withdraw(address(token), bob, 1e18, "w1");
    }

    function test_admin_functions_only_owner() public {
        vm.startPrank(operator);
        vm.expectRevert(DarkPoolVault.NotOwner.selector);
        vault.setAllowed(address(token), false);
        vm.expectRevert(DarkPoolVault.NotOwner.selector);
        vault.setOperator(operator);
        vm.expectRevert(DarkPoolVault.NotOwner.selector);
        vault.setPaused(true);
        vm.expectRevert(DarkPoolVault.NotOwner.selector);
        vault.transferOwnership(operator);
        vm.stopPrank();
    }

    function test_two_step_ownership() public {
        vm.prank(owner);
        vault.transferOwnership(bob);
        assertEq(vault.owner(), owner, "nothing changes until accepted");
        vm.prank(alice);
        vm.expectRevert(DarkPoolVault.NotPendingOwner.selector);
        vault.acceptOwnership();
        vm.prank(bob);
        vault.acceptOwnership();
        assertEq(vault.owner(), bob);
        assertEq(vault.pendingOwner(), address(0));
        vm.prank(owner);
        vm.expectRevert(DarkPoolVault.NotOwner.selector);
        vault.setPaused(true);
    }

    function test_rotating_operator_revokes_the_old_one() public {
        _deposit(alice, 2e18);
        vm.prank(owner);
        vault.setOperator(bob);
        vm.prank(operator);
        vm.expectRevert(DarkPoolVault.NotOperator.selector);
        vault.withdraw(address(token), operator, 1e18, "w1");
        vm.prank(bob);
        vault.withdraw(address(token), alice, 1e18, "w1");
    }

    function test_delisting_blocks_deposits_not_withdrawals() public {
        _deposit(alice, 2e18);
        vm.prank(owner);
        vault.setAllowed(address(token), false);
        vm.prank(alice);
        vm.expectRevert(DarkPoolVault.TokenNotAllowed.selector);
        vault.deposit(address(token), 1e18);
        vm.prank(operator);
        vault.withdraw(address(token), alice, 2e18, "w1");
    }

    function test_rejects_plain_eth() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(vault).call{value: 1}("");
        assertFalse(ok);
    }

    function test_constructor_rejects_zero_addresses() public {
        vm.expectRevert(DarkPoolVault.ZeroAddress.selector);
        new DarkPoolVault(address(0), operator);
        vm.expectRevert(DarkPoolVault.ZeroAddress.selector);
        new DarkPoolVault(owner, address(0));
    }
}
