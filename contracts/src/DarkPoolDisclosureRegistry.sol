// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title DarkPoolDisclosureRegistry
/// @notice Selective disclosure for the shielded pool (plan.md X1.1). A user seals their viewing material (viewing key,
/// deposit blinding key, owner key) to an auditor's public key and publishes it here; the auditor can then rebuild that
/// user's notes, orders and results from public pool data, but cannot spend (spending needs the secret, which is never
/// disclosed). A grant cannot be withdrawn once read — publish only to auditors you mean to show everything to.
contract DarkPoolDisclosureRegistry {
    event Disclosed(bytes32 indexed auditor, address indexed from, bytes grant);

    error EmptyGrant();

    /// @param auditor keccak256 of the auditor's compressed secp256k1 public key.
    /// @param grant ECIES ciphertext of the viewing material, sealed to that key.
    function disclose(bytes32 auditor, bytes calldata grant) external {
        if (grant.length == 0) revert EmptyGrant();
        emit Disclosed(auditor, msg.sender, grant);
    }
}
