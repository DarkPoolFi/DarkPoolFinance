// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HonkVerifier} from "../src/verifiers/BatchCrossVerifier.sol";

/// The bb-generated BatchCrossProof verifier on the EVM, against the venue fixture's settlement proof
/// (`bun circuits/tests/venue.fixture.ts`); skipped when it is absent.
contract BatchCrossVerifierTest is Test {
    string constant PROOF_DIR = "../circuits/target/fixtures/venue_settle/";
    HonkVerifier verifier;
    bytes proof;
    bytes32[] inputs;

    function setUp() public {
        verifier = new HonkVerifier();
        if (!vm.exists(string.concat(PROOF_DIR, "proof"))) return;
        proof = vm.readFileBinary(string.concat(PROOF_DIR, "proof"));
        bytes memory raw = vm.readFileBinary(string.concat(PROOF_DIR, "public_inputs"));
        for (uint256 i; i < raw.length / 32; i++) {
            bytes32 word;
            assembly {
                word := mload(add(raw, add(32, mul(32, i))))
            }
            inputs.push(word);
        }
    }

    function test_verifies_batch_cross_proof() public {
        if (proof.length == 0) vm.skip(true);
        uint256 before = gasleft();
        assertTrue(verifier.verify(proof, inputs));
        emit log_named_uint("verify gas", before - gasleft());
        emit log_named_uint("public inputs", inputs.length);
        emit log_named_uint("proof bytes", proof.length);
    }

    function test_rejects_tampered_public_input() public {
        if (proof.length == 0) vm.skip(true);
        inputs[inputs.length - 1] = bytes32(uint256(inputs[inputs.length - 1]) + 1); // e.g. the claimed fees
        assertFalse(_verifies(proof, inputs));
    }

    function test_rejects_tampered_proof() public {
        if (proof.length == 0) vm.skip(true);
        bytes memory bad = proof;
        bad[bad.length / 2] = bytes1(uint8(bad[bad.length / 2]) ^ 0x01);
        assertFalse(_verifies(bad, inputs));
    }

    function _verifies(bytes memory p, bytes32[] memory i) internal view returns (bool) {
        try verifier.verify(p, i) returns (bool ok) {
            return ok;
        } catch {
            return false;
        }
    }
}
