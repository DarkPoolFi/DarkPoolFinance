// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DarkPoolFeeRouter, IStakingRewards} from "../src/DarkPoolFeeRouter.sol";
import {DarkPoolStaking, IStakedToken} from "../src/DarkPoolStaking.sol";
import {DarkPoolToken} from "../src/DarkPoolToken.sol";

/// Claims again from inside the ETH transfer.
contract Reclaimer {
    DarkPoolStaking public staking;
    uint256 public reentered;

    constructor(DarkPoolStaking staking_) {
        staking = staking_;
    }

    function stakeAll(DarkPoolToken token) external {
        token.approve(address(staking), type(uint256).max);
        staking.stake(token.balanceOf(address(this)));
    }

    function claim() external {
        staking.claim();
    }

    receive() external payable {
        if (reentered++ == 0) staking.claim();
    }
}

contract DarkPoolTokenomicsTest is Test {
    address constant TREASURY = address(0x7EA5);
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    uint256 constant SUPPLY = 1_000_000_000 ether;

    DarkPoolToken token;
    DarkPoolStaking staking;
    DarkPoolFeeRouter router;

    function setUp() public {
        token = new DarkPoolToken("DarkpoolFi", "DPFI", TREASURY, SUPPLY);
        staking = new DarkPoolStaking(IStakedToken(address(token)));
        router = new DarkPoolFeeRouter(address(this), TREASURY);
        vm.startPrank(TREASURY);
        token.transfer(ALICE, 100 ether);
        token.transfer(BOB, 300 ether);
        vm.stopPrank();
        for (uint256 i; i < 2; i++) {
            address who = [ALICE, BOB][i];
            vm.prank(who);
            token.approve(address(staking), type(uint256).max);
        }
        vm.deal(address(this), 100 ether);
    }

    // --- token -------------------------------------------------------------------

    function test_token_has_a_fixed_supply_at_the_treasury() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(TREASURY) + token.balanceOf(ALICE) + token.balanceOf(BOB), SUPPLY);
        assertEq(token.decimals(), 18);
        assertEq(token.symbol(), "DPFI");
    }

    function test_token_transfers_and_allowances() public {
        vm.prank(ALICE);
        token.approve(address(this), 40 ether);
        token.transferFrom(ALICE, BOB, 30 ether);
        assertEq(token.balanceOf(BOB), 330 ether);
        assertEq(token.allowance(ALICE, address(this)), 10 ether);
        vm.expectRevert(DarkPoolToken.InsufficientAllowance.selector);
        token.transferFrom(ALICE, BOB, 11 ether);

        vm.prank(ALICE);
        vm.expectRevert(DarkPoolToken.InsufficientBalance.selector);
        token.transfer(BOB, 71 ether);
        vm.prank(ALICE);
        vm.expectRevert(DarkPoolToken.ZeroAddress.selector);
        token.transfer(address(0), 1);

        // an unlimited allowance is not spent down (staking relies on it only through transferFrom)
        assertEq(token.allowance(ALICE, address(staking)), type(uint256).max);
        vm.prank(ALICE);
        staking.stake(10 ether);
        assertEq(token.allowance(ALICE, address(staking)), type(uint256).max);
    }

    // --- staking -----------------------------------------------------------------

    function test_rewards_split_pro_rata_to_stake_at_arrival() public {
        vm.prank(ALICE);
        staking.stake(100 ether);
        vm.prank(BOB);
        staking.stake(300 ether);
        staking.notifyReward{value: 4 ether}();
        assertEq(staking.claimable(ALICE), 1 ether);
        assertEq(staking.claimable(BOB), 3 ether);

        // a later stake does not share earlier rewards
        vm.prank(TREASURY);
        token.transfer(address(0xCA7), 400 ether);
        vm.startPrank(address(0xCA7));
        token.approve(address(staking), 400 ether);
        staking.stake(400 ether);
        vm.stopPrank();
        assertEq(staking.claimable(address(0xCA7)), 0);
        staking.notifyReward{value: 8 ether}();
        assertEq(staking.claimable(address(0xCA7)), 4 ether);
        assertEq(staking.claimable(ALICE), 2 ether);

        uint256 before = BOB.balance;
        vm.prank(BOB);
        assertEq(staking.claim(), 6 ether);
        assertEq(BOB.balance - before, 6 ether);
        assertEq(staking.claimable(BOB), 0);
    }

    function test_unstaking_keeps_what_was_earned() public {
        vm.prank(ALICE);
        staking.stake(100 ether);
        staking.notifyReward{value: 1 ether}();
        vm.prank(ALICE);
        staking.unstake(100 ether);
        assertEq(token.balanceOf(ALICE), 100 ether);
        staking.notifyReward{value: 1 ether}(); // nobody staked: waits
        assertEq(staking.claimable(ALICE), 1 ether);
        assertEq(staking.undistributed(), 1 ether);

        vm.prank(BOB);
        staking.stake(300 ether);
        staking.notifyReward{value: 2 ether}();
        assertEq(staking.claimable(BOB), 3 ether, "the waiting ether goes to the next stakers");
        assertEq(staking.undistributed(), 0);
        vm.prank(ALICE);
        assertEq(staking.claim(), 1 ether);
    }

    function test_staking_guards() public {
        vm.prank(ALICE);
        vm.expectRevert(DarkPoolStaking.ZeroAmount.selector);
        staking.stake(0);
        vm.prank(ALICE);
        staking.stake(10 ether);
        vm.prank(ALICE);
        vm.expectRevert(DarkPoolStaking.InsufficientStake.selector);
        staking.unstake(11 ether);
        vm.prank(ALICE);
        vm.expectRevert(DarkPoolStaking.ZeroAmount.selector);
        staking.unstake(0);
    }

    function test_claim_cannot_be_reentered() public {
        Reclaimer r = new Reclaimer(staking);
        vm.prank(TREASURY);
        token.transfer(address(r), 100 ether);
        r.stakeAll(token);
        staking.notifyReward{value: 1 ether}();
        vm.expectRevert(DarkPoolStaking.TransferFailed.selector); // the inner claim reverts, so the payment fails
        r.claim();
        assertEq(staking.claimable(address(r)), 1 ether, "nothing was paid twice");
    }

    function test_topping_up_a_stake_keeps_earned_rewards() public {
        vm.prank(ALICE);
        staking.stake(50 ether);
        staking.notifyReward{value: 1 ether}();
        vm.prank(ALICE);
        staking.stake(50 ether);
        assertEq(staking.claimable(ALICE), 1 ether, "rewards earned before the top-up stay");
        staking.notifyReward{value: 1 ether}();
        assertEq(staking.claimable(ALICE), 2 ether);
    }

    function test_staking_refuses_a_token_that_skims() public {
        SkimmingToken skim = new SkimmingToken();
        DarkPoolStaking skimStaking = new DarkPoolStaking(IStakedToken(address(skim)));
        skim.mint(ALICE, 100 ether);
        vm.startPrank(ALICE);
        skim.approve(address(skimStaking), 100 ether);
        vm.expectRevert(DarkPoolStaking.TransferFailed.selector);
        skimStaking.stake(100 ether);
        vm.stopPrank();
    }

    // --- fee router --------------------------------------------------------------

    function test_router_sends_everything_to_the_treasury_while_the_switch_is_off() public {
        (bool ok,) = address(router).call{value: 1 ether}("");
        assertTrue(ok);
        vm.prank(address(0xCAFE)); // anyone may distribute
        (uint256 toStakers, uint256 toTreasury) = router.distribute();
        assertEq(toStakers, 0);
        assertEq(toTreasury, 1 ether);
        assertEq(TREASURY.balance, 1 ether);
    }

    function test_router_fee_switch_shares_fees_with_stakers() public {
        vm.prank(ALICE);
        staking.stake(100 ether);
        router.setFeeSwitch(IStakingRewards(address(staking)), 2000);
        (bool ok,) = address(router).call{value: 5 ether}("");
        assertTrue(ok);
        router.distribute();
        assertEq(address(staking).balance, 1 ether);
        assertEq(TREASURY.balance, 4 ether);
        assertEq(staking.claimable(ALICE), 1 ether);
        (uint256 s, uint256 t) = router.distribute();
        assertEq(s + t, 0, "nothing left to split");
    }

    function test_router_guards() public {
        vm.expectRevert(DarkPoolFeeRouter.TooHigh.selector);
        router.setFeeSwitch(IStakingRewards(address(staking)), 5001);
        vm.expectRevert(DarkPoolFeeRouter.ZeroAddress.selector);
        router.setFeeSwitch(IStakingRewards(address(0)), 1);
        router.setFeeSwitch(IStakingRewards(address(0)), 0); // off
        vm.expectRevert(DarkPoolFeeRouter.ZeroAddress.selector);
        router.setTreasury(address(0));
        vm.startPrank(address(0xCAFE));
        vm.expectRevert(DarkPoolFeeRouter.NotOwner.selector);
        router.setFeeSwitch(IStakingRewards(address(staking)), 100);
        vm.expectRevert(DarkPoolFeeRouter.NotOwner.selector);
        router.setTreasury(address(0xCAFE));
        vm.stopPrank();
        router.transferOwnership(address(0xCAFE));
        vm.prank(address(0xBAD));
        vm.expectRevert(DarkPoolFeeRouter.NotPendingOwner.selector);
        router.acceptOwnership();
        vm.prank(address(0xCAFE));
        router.acceptOwnership();
        assertEq(router.owner(), address(0xCAFE));
    }
}

/// Keeps 1% of every transferFrom.
contract SkimmingToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
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
        balanceOf[to] += amount * 99 / 100;
        return true;
    }
}
