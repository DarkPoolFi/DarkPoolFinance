// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DarkPoolBackstopVault, IChainlinkPrice, ISwapRouter02, IWETH9} from "../src/DarkPoolBackstopVault.sol";
import {MockFeed, MockStock} from "./DarkPoolShieldedPool.t.sol";

contract MockWETH is MockStock {
    function deposit() external payable {
        balanceOf[msg.sender] += msg.value;
    }

    function withdraw(uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        require(ok, "send");
    }
}

/// SwapRouter02 stand-in: pays `rateBps` of the Chainlink-fair output from its own balance and honours amountOutMinimum.
contract MockRouter {
    MockWETH public weth;
    address public token;
    uint256 public tokenUsd; // 8 decimals
    uint256 public ethUsd;
    uint256 public rateBps = 10_000;

    constructor(MockWETH weth_, address token_, uint256 tokenUsd_, uint256 ethUsd_) {
        weth = weth_;
        token = token_;
        tokenUsd = tokenUsd_;
        ethUsd = ethUsd_;
    }

    function setRate(uint256 bps) external {
        rateBps = bps;
    }

    function exactInputSingle(ISwapRouter02.ExactInputSingleParams calldata p) external returns (uint256 out) {
        MockStock(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        uint256 fair = p.tokenIn == token ? p.amountIn * tokenUsd / ethUsd : p.amountIn * ethUsd / tokenUsd;
        out = fair * rateBps / 10_000;
        require(out >= p.amountOutMinimum, "Too little received");
        MockStock(p.tokenOut).transfer(p.recipient, out);
    }
}

contract DarkPoolBackstopVaultTest is Test {
    address constant POOL = address(0xD4A11);
    address constant LP1 = address(0x1111);
    address constant LP2 = address(0x2222);
    address constant REBALANCER = address(0x4EBA);
    uint256 constant AAPL_USD = 200e8;
    uint256 constant ETH_USD = 4000e8; // 1 AAPL = 0.05 ETH

    DarkPoolBackstopVault vault;
    MockStock aapl;
    MockWETH weth;
    MockFeed aaplFeed;
    MockFeed ethFeed;
    MockRouter router;

    function setUp() public {
        vm.warp(1_800_000_000);
        aapl = new MockStock();
        weth = new MockWETH();
        aaplFeed = new MockFeed();
        ethFeed = new MockFeed();
        aaplFeed.push(int256(AAPL_USD), block.timestamp);
        ethFeed.push(int256(ETH_USD), block.timestamp);
        router = new MockRouter(weth, address(aapl), AAPL_USD, ETH_USD);
        vault = new DarkPoolBackstopVault(address(this), ISwapRouter02(address(router)), IWETH9(address(weth)), IChainlinkPrice(address(ethFeed)));
        vault.setBook(address(aapl), address(aaplFeed), 50, 500, true, 100 ether, 5 ether);
        vault.setPool(POOL);
        vault.setRebalancer(REBALANCER, 100, 1000);
        for (uint256 i; i < 3; i++) {
            address who = [LP1, LP2, POOL][i];
            vm.deal(who, 100 ether);
            aapl.mint(who, 1000 ether);
            vm.prank(who);
            aapl.approve(address(vault), type(uint256).max);
        }
        aapl.mint(address(router), 1000 ether);
        vm.deal(address(this), 100 ether);
        weth.deposit{value: 100 ether}();
        weth.transfer(address(router), 100 ether);
    }

    function _book() internal view returns (uint256 eth, uint256 tokens, uint256 shares) {
        (,,,,, eth, tokens, shares,,) = vault.books(address(aapl));
    }

    function test_deposits_mint_shares_at_value_and_withdraw_pro_rata() public {
        vm.prank(LP1);
        uint256 s1 = vault.deposit{value: 5 ether}(address(aapl), 100 ether); // 5 ETH + 100 AAPL (= 5 ETH) = 10 ETH of value
        assertEq(s1, 10 ether);
        vm.prank(LP2);
        uint256 s2 = vault.deposit{value: 0}(address(aapl), 100 ether); // 5 ETH of value → half of LP1's shares
        assertEq(s2, 5 ether);
        assertEq(vault.bookValue(address(aapl)), 15 ether);

        uint256 before = LP2.balance;
        vm.prank(LP2);
        (uint256 eth, uint256 tokens) = vault.withdraw(address(aapl), s2);
        assertEq(eth, 5 ether * s2 / 15 ether, "a third of the ETH");
        assertEq(tokens, 200 ether * s2 / 15 ether, "a third of the tokens");
        assertEq(LP2.balance - before, eth);
        (uint256 bEth, uint256 bTokens, uint256 bShares) = _book();
        assertEq(bEth + eth, 5 ether);
        assertEq(bTokens + tokens, 200 ether);
        assertEq(bShares, s1);

        vm.prank(LP2);
        vm.expectRevert(DarkPoolBackstopVault.NoShares.selector);
        vault.withdraw(address(aapl), 1);
    }

    function test_share_price_follows_the_oracle_not_the_depositor() public {
        vm.prank(LP1);
        vault.deposit{value: 0}(address(aapl), 100 ether); // 5 ETH of value
        aaplFeed.push(int256(AAPL_USD * 2), block.timestamp); // AAPL doubles: book worth 10 ETH
        vm.prank(LP2);
        uint256 s2 = vault.deposit{value: 10 ether}(address(aapl), 0);
        assertEq(s2, 5 ether, "10 ETH buys the same share count 5 ETH did at half the book value");
    }

    function test_deposit_guards() public {
        vm.prank(LP1);
        vm.expectRevert(DarkPoolBackstopVault.BadAmount.selector);
        vault.deposit(address(aapl), 0);

        vm.warp(block.timestamp + vault.MAX_STALENESS() + 1);
        vm.prank(LP1);
        vm.expectRevert(DarkPoolBackstopVault.BadPrice.selector);
        vault.deposit{value: 1 ether}(address(aapl), 0);

        vault.setBook(address(aapl), address(aaplFeed), 50, 500, false, 0, 0);
        vm.prank(LP1);
        vm.expectRevert(DarkPoolBackstopVault.BookDisabled.selector);
        vault.deposit{value: 1 ether}(address(aapl), 0);
    }

    function test_offer_is_capped_inventory_in_venue_units() public {
        vm.prank(LP1);
        vault.deposit{value: 8 ether}(address(aapl), 150 ether);
        (uint256 qty, uint256 ethMicro, uint16 spread) = vault.offer(address(aapl), 1e12);
        assertEq(qty, 100e6, "capped at maxSellTokens, in micro-units");
        assertEq(ethMicro, 5e6, "capped at maxBuyEth, in micro-ETH");
        assertEq(spread, 50);
        vault.setBook(address(aapl), address(aaplFeed), 50, 500, false, 100 ether, 5 ether);
        (qty, ethMicro,) = vault.offer(address(aapl), 1e12);
        assertEq(qty + ethMicro, 0, "a disabled book offers nothing");
    }

    function test_exchange_moves_the_backstop_leg() public {
        vm.prank(LP1);
        vault.deposit{value: 10 ether}(address(aapl), 100 ether);
        uint256 poolEth = POOL.balance;
        uint256 poolAapl = aapl.balanceOf(POOL);
        vm.prank(POOL); // buyers took 6 AAPL for 0.3015 ETH; sellers gave 2 AAPL for 0.0995 ETH
        vault.exchange{value: 0.3015 ether}(address(aapl), 6 ether, 2 ether, 0.0995 ether);
        (uint256 eth, uint256 tokens,) = _book();
        assertEq(tokens, 96 ether);
        assertEq(eth, 10 ether + 0.3015 ether - 0.0995 ether);
        assertEq(aapl.balanceOf(POOL), poolAapl + 6 ether - 2 ether);
        assertEq(POOL.balance, poolEth - 0.3015 ether + 0.0995 ether);

        vm.expectRevert(DarkPoolBackstopVault.NotPool.selector);
        vault.exchange(address(aapl), 1, 0, 0);
        vm.prank(POOL);
        vm.expectRevert(DarkPoolBackstopVault.Insufficient.selector);
        vault.exchange(address(aapl), 97 ether, 0, 0);
        vm.expectRevert(DarkPoolBackstopVault.PoolAlreadySet.selector);
        vault.setPool(address(0xBAD));
    }

    function test_rebalance_is_bounded_by_the_oracle() public {
        vm.prank(LP1);
        vault.deposit{value: 10 ether}(address(aapl), 200 ether); // 20 ETH of value
        vm.prank(REBALANCER);
        uint256 out = vault.rebalance(address(aapl), true, 20 ether); // 1 ETH of AAPL, within 10% of value
        assertEq(out, 1 ether);
        (uint256 eth, uint256 tokens,) = _book();
        assertEq(eth, 11 ether);
        assertEq(tokens, 180 ether);

        vm.prank(REBALANCER);
        out = vault.rebalance(address(aapl), false, 1 ether);
        assertEq(out, 20 ether, "ETH back into AAPL");

        router.setRate(9_800); // a 2% worse price than Chainlink: beyond the 1% slippage bound
        vm.prank(REBALANCER);
        vm.expectRevert();
        vault.rebalance(address(aapl), true, 20 ether);

        router.setRate(10_000);
        vm.prank(REBALANCER);
        vm.expectRevert(DarkPoolBackstopVault.TooLarge.selector);
        vault.rebalance(address(aapl), true, 41 ether); // 2.05 ETH > 10% of 20 ETH

        vm.expectRevert(DarkPoolBackstopVault.NotRebalancer.selector);
        vault.rebalance(address(aapl), true, 1 ether);
    }

    function test_owner_guards() public {
        vm.expectRevert(DarkPoolBackstopVault.BadBook.selector);
        vault.setBook(address(aapl), address(aaplFeed), 201, 500, true, 0, 0);
        vm.expectRevert(DarkPoolBackstopVault.BadBook.selector);
        vault.setRebalancer(REBALANCER, 501, 1000);
        vm.prank(address(0xCAFE));
        vm.expectRevert(DarkPoolBackstopVault.NotOwner.selector);
        vault.setBook(address(aapl), address(aaplFeed), 10, 500, true, 0, 0);
        vm.deal(address(this), 1 ether); // setUp wrapped all of this contract's ETH
        (bool ok,) = address(vault).call{value: 1}(""); // plain ETH only from WETH unwraps
        assertFalse(ok, "stray ETH is refused");
    }

    function test_deposit_counts_only_what_arrives() public {
        SkimToken skim = new SkimToken();
        skim.mint(LP1, 100 ether);
        vault.setBook(address(skim), address(aaplFeed), 50, 0, true, 0, 0);
        vm.startPrank(LP1);
        skim.approve(address(vault), type(uint256).max);
        vm.expectRevert(DarkPoolBackstopVault.BadAmount.selector);
        vault.deposit(address(skim), 100 ether);
        vm.stopPrank();
    }
}

/// A token that keeps 1% of every transferFrom.
contract SkimToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount * 99 / 100;
        return true;
    }
}
