// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {DarkPoolVault} from "../src/DarkPoolVault.sol";

/// forge script script/DeployVault.s.sol --rpc-url robinhood --broadcast --legacy
/// Env: DARKPOOL_GAS_KEY (deployer; also the operator unless DARKPOOL_VAULT_OPERATOR is set),
///      DARKPOOL_VAULT_TOKENS (comma-separated token addresses to allow),
///      DARKPOOL_VAULT_OWNER (optional; starts a two-step transfer that the owner must accept).
contract DeployVault is Script {
    function run() external returns (DarkPoolVault vault) {
        uint256 pk = vm.envUint("DARKPOOL_GAS_KEY");
        address deployer = vm.addr(pk);
        address operator = vm.envOr("DARKPOOL_VAULT_OPERATOR", deployer);
        address owner = vm.envOr("DARKPOOL_VAULT_OWNER", deployer);
        address[] memory tokens = vm.envAddress("DARKPOOL_VAULT_TOKENS", ",");

        vm.startBroadcast(pk);
        vault = new DarkPoolVault(deployer, operator);
        for (uint256 i; i < tokens.length; i++) {
            vault.setAllowed(tokens[i], true);
        }
        if (owner != deployer) vault.transferOwnership(owner);
        vm.stopBroadcast();

        console.log("DarkPoolVault", address(vault));
        console.log("operator", operator);
        console.log("owner (pending if different from deployer)", owner);
    }
}
