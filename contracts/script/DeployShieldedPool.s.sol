// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DarkPoolBackstopVault, IChainlinkPrice, ISwapRouter02, IWETH9} from "../src/DarkPoolBackstopVault.sol";
import {DarkPoolDisclosureRegistry} from "../src/DarkPoolDisclosureRegistry.sol";
import {DarkPoolScreeningGate} from "../src/DarkPoolScreeningGate.sol";
import {DarkPoolShieldedPool, IBackstopVault, IChainlinkFeed, IProofVerifier, IScreeningGate} from "../src/DarkPoolShieldedPool.sol";
import {DarkPoolTimelock} from "../src/DarkPoolTimelock.sol";
// Every bb-generated verifier is named HonkVerifier; aliases keep them apart (forge script only builds what it imports).
import {HonkVerifier as BatchCrossHonk} from "../src/verifiers/BatchCrossVerifier.sol";
import {HonkVerifier as OrderValidityHonk} from "../src/verifiers/OrderValidityVerifier.sol";
import {HonkVerifier as ReclaimHonk} from "../src/verifiers/ReclaimVerifier.sol";

/// forge script script/DeployShieldedPool.s.sol --rpc-url $DARKPOOL_RPC_URL --broadcast --slow --skip-simulation --legacy --with-gas-price <price>
/// Pool v4 (X2 order terms and the backstop vault). Reuses the live deposit, transact and tree-update verifiers, the
/// screening gate, the disclosure registry and the timelock (their circuits and contracts are unchanged); deploys the
/// order-validity, batch-cross and reclaim verifiers, the pool and DarkPoolBackstopVault (books for the markets with a
/// Uniswap v3 WETH pool; the pool operator rebalances). Pool and vault are configured by the deployer, then handed to
/// the timelock (the timelock only accepts ownership itself).
/// Env: DARKPOOL_GAS_KEY, DARKPOOL_ETH_USD_FEED, DARKPOOL_FEE_OWNER, DARKPOOL_POOL_OPERATOR_ADDRESS, DARKPOOL_DEPOSIT_FEE_WEI,
///      DARKPOOL_VERIFIER_DEPOSIT, DARKPOOL_VERIFIER_TRANSACT, DARKPOOL_VERIFIER_TREE, DARKPOOL_GATE_ADDRESS,
///      DARKPOOL_TIMELOCK_ADDRESS, DARKPOOL_POOL_TOKENS, DARKPOOL_POOL_FEEDS and DARKPOOL_POOL_UNISWAP_FEES (comma-separated,
///      same order; fee 0 = no rebalancing), DARKPOOL_BACKSTOP_SPREAD_BPS.
contract DeployShieldedPool is Script {
    uint16 constant FEE_BPS = 5; // dark_config fee_bps
    ISwapRouter02 constant SWAP_ROUTER02 = ISwapRouter02(0xCaf681a66D020601342297493863E78C959E5cb2); // Uniswap v3, chain 4663
    IWETH9 constant WETH9 = IWETH9(0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73);

    struct Deployed {
        DarkPoolShieldedPool pool;
        DarkPoolBackstopVault vault;
        IProofVerifier order;
        IProofVerifier batch;
        IProofVerifier reclaim;
    }

    function run() external returns (DarkPoolShieldedPool pool) {
        uint256 pk = vm.envUint("DARKPOOL_GAS_KEY");
        address deployer = vm.addr(pk);
        address[] memory tokens = vm.envAddress("DARKPOOL_POOL_TOKENS", ",");
        address[] memory feeds = vm.envAddress("DARKPOOL_POOL_FEEDS", ",");
        uint256[] memory poolFees = vm.envUint("DARKPOOL_POOL_UNISWAP_FEES", ",");
        require(tokens.length == feeds.length && tokens.length == poolFees.length, "tokens, feeds and fees differ in length");
        DarkPoolTimelock timelock = DarkPoolTimelock(vm.envAddress("DARKPOOL_TIMELOCK_ADDRESS"));
        require(timelock.admin() == deployer, "the deployer does not administer the timelock");

        vm.startBroadcast(pk);
        Deployed memory d;
        d.order = IProofVerifier(address(new OrderValidityHonk()));
        d.batch = IProofVerifier(address(new BatchCrossHonk()));
        d.reclaim = IProofVerifier(address(new ReclaimHonk()));
        DarkPoolShieldedPool.Verifiers memory v = DarkPoolShieldedPool.Verifiers({
            deposit: _existing("DARKPOOL_VERIFIER_DEPOSIT"),
            tree: _existing("DARKPOOL_VERIFIER_TREE"),
            transact: _existing("DARKPOOL_VERIFIER_TRANSACT"),
            order: d.order,
            batch: d.batch,
            reclaim: d.reclaim
        });
        IChainlinkFeed ethUsd = IChainlinkFeed(vm.envAddress("DARKPOOL_ETH_USD_FEED"));
        d.pool = new DarkPoolShieldedPool(deployer, v, ethUsd, vm.envBytes32("DARKPOOL_FEE_OWNER"), FEE_BPS);
        d.vault = new DarkPoolBackstopVault(deployer, SWAP_ROUTER02, WETH9, IChainlinkPrice(address(ethUsd)));
        _configure(d, tokens, feeds, poolFees, deployer);
        d.pool.transferOwnership(address(timelock));
        d.vault.transferOwnership(address(timelock));
        timelock.execute(address(d.pool), abi.encodeWithSignature("acceptOwnership()"));
        timelock.execute(address(d.vault), abi.encodeWithSignature("acceptOwnership()"));
        vm.stopBroadcast();

        require(d.pool.owner() == address(timelock) && d.vault.owner() == address(timelock), "timelock does not own pool and vault");
        pool = d.pool;
        console.log("DarkPoolShieldedPool", address(d.pool));
        console.log("DarkPoolBackstopVault", address(d.vault));
        console.log("OrderValidityVerifier", address(d.order));
        console.log("BatchCrossVerifier", address(d.batch));
        console.log("ReclaimVerifier", address(d.reclaim));
    }

    function _configure(Deployed memory d, address[] memory tokens, address[] memory feeds, uint256[] memory poolFees, address deployer) private {
        address operator = vm.envAddress("DARKPOOL_POOL_OPERATOR_ADDRESS");
        uint16 spread = uint16(vm.envUint("DARKPOOL_BACKSTOP_SPREAD_BPS"));
        d.pool.setGate(IScreeningGate(vm.envAddress("DARKPOOL_GATE_ADDRESS")));
        for (uint256 i; i < tokens.length; i++) {
            uint8 decimals = abi.decode(_read(tokens[i], "decimals()"), (uint8));
            require(decimals >= 6, "token has fewer than 6 decimals");
            d.pool.setMarket(tokens[i], feeds[i], uint88(10 ** (decimals - 6)), true);
            d.pool.setAllowed(tokens[i], true);
            // per-window caps start at 100 tokens and 1 ETH; LPs decide how much actually backs them
            d.vault.setBook(tokens[i], feeds[i], spread, uint24(poolFees[i]), true, 100 ether, 1 ether);
        }
        d.pool.setDepositFee(operator, vm.envUint("DARKPOOL_DEPOSIT_FEE_WEI"));
        d.pool.setBackstop(IBackstopVault(address(d.vault)));
        d.vault.setPool(address(d.pool));
        d.vault.setRebalancer(operator, 100, 1000);
        deployer; // the owner until the timelock accepts
    }

    function _existing(string memory name) private view returns (IProofVerifier verifier) {
        verifier = IProofVerifier(vm.envAddress(name));
        require(address(verifier).code.length > 0, name);
    }

    function _read(address target, string memory sig) private view returns (bytes memory ret) {
        bool ok;
        (ok, ret) = target.staticcall(abi.encodeWithSignature(sig));
        require(ok && ret.length >= 32, sig);
    }
}
