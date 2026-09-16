// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {DarkPoolVault} from "../src/DarkPoolVault.sol";

/// RUN_FORK=true forge test --match-contract Fork
/// Real Robinhood Stock Token (AAPL) on a Robinhood Chain mainnet fork.
contract DarkPoolVaultForkTest is Test {
    address constant AAPL = 0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9;

    function test_fork_real_stock_token_round_trip() public {
        if (!vm.envOr("RUN_FORK", false)) vm.skip(true);
        vm.createSelectFork("robinhood");

        address owner = makeAddr("owner");
        address operator = makeAddr("operator");
        address alice = makeAddr("alice");
        DarkPoolVault vault = new DarkPoolVault(owner, operator);
        vm.prank(owner);
        vault.setAllowed(AAPL, true);

        address holder = vm.envOr("FORK_HOLDER", address(0));
        if (holder != address(0)) {
            vm.prank(holder);
            IERC20(AAPL).transfer(alice, 3e18);
        } else {
            deal(AAPL, alice, 3e18);
        }
        assertEq(IERC20(AAPL).balanceOf(alice), 3e18);

        vm.startPrank(alice);
        IERC20(AAPL).approve(address(vault), 3e18);
        vault.deposit(AAPL, 2e18);
        vm.stopPrank();
        assertEq(IERC20(AAPL).balanceOf(address(vault)), 2e18, "vault received exactly the deposit");

        vm.prank(operator);
        vault.withdraw(AAPL, alice, 1.5e18, "fork-w1");
        assertEq(IERC20(AAPL).balanceOf(address(vault)), 0.5e18, "withdrawal is exact");
        assertEq(IERC20(AAPL).balanceOf(alice), 2.5e18);
    }
}
