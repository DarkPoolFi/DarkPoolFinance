// DarkPoolShieldedPool from the operator side (plan.md X1.3): the interface and the pool operator wallet, whose sends
// go through the queue in sends.ts. advanceTree, seal, settleWindow and relayed withdrawals are permissionless, so this wallet holds no
// rights over the pool, only gas; it also posts association roots to the screening gate (its poster). It is separate
// from the gas wallet so pool sends never race the X0 crons for a nonce.
import { Contract, Interface, Wallet } from "ethers";
import { provider } from "../chain";
import { env } from "../env";

export const POOL_ABI = new Interface([
  "event Committed(uint256 indexed index, bytes32 commitment)",
  "event Deposited(address indexed from, address indexed asset, uint256 amount, bytes32 commitment, uint256 label)",
  "event TreeAdvanced(bytes32 root, uint256 size)",
  "event Transacted(bytes32 indexed nullifier0, bytes32 indexed nullifier1, address indexed asset, address to, uint256 released, address relayer, uint256 fee, bytes memo)",
  "event OrderResting(address indexed asset, uint256 indexed epoch, bytes32 commitment, bytes sealedOrder)",
  "event OrderFeePaid(address indexed relayer, uint256 fee)",
  "event WindowSealed(address indexed asset, uint256 indexed epoch, uint256 refUsd, uint256 ethUsd, bool live)",
  "event WindowSettled(address indexed asset, uint256 indexed epoch, bytes notes)",
  "event BackstopSettled(address indexed asset, uint256 indexed epoch, uint256 sold, uint256 ethIn, uint256 bought, uint256 ethOut)",
  "event WindowAbandoned(address indexed asset, uint256 indexed epoch)",
  "event OrderReclaimed(address indexed asset, uint256 indexed epoch, uint256 slot)",
  "event Disclosed(bytes32 indexed auditor, address indexed from, bytes grant)", // DarkPoolDisclosureRegistry, indexed alongside
  "function commitmentCount() view returns (uint256)",
  "function treeSize() view returns (uint256)",
  "function root() view returns (bytes32)",
  "function spent(bytes32) view returns (bool)",
  "function gate() view returns (address)",
  "function depositFee() view returns (uint256)",
  "function feeOwner() view returns (bytes32)",
  "function feeBps() view returns (uint16)",
  "function ethUsdFeed() view returns (address)",
  "function SETTLE_DEADLINE() view returns (uint256)",
  "function markets(address) view returns (address feed, uint88 unit, bool listed)",
  "function windows(address, uint256) view returns (bool isSealed, bool isSettled, bool live, uint64 refUsd, uint64 ethUsd, uint16 feeBps, bool abandoned, uint64 bsQty, uint64 bsEth, uint16 bsSpread)",
  "function advanceTree(uint256 count, bytes32 newRoot, bytes proof)",
  "function seal(address asset, uint256 epoch, uint80 assetRound, uint80 ethRound)",
  "function settleWindow(address asset, uint256 epoch, (bytes32[64] fills, bytes32[64] residuals, bool[64] rolls, bytes32 feeNote, uint256 bsSold, uint256 bsEthIn, uint256 bsBought, uint256 bsEthOut) s, bytes proof, bytes notes)",
  "function transact((bytes32 root, bytes32 aspRoot, bytes32[2] nullifiers, bytes32[2] outputs, address asset, uint256 released, uint256 fee, address to, address relayer) t, bytes proof, bytes memo)",
  "function placeOrder(address asset, (bytes32 root, bytes32 nullifier, bytes32 feeNullifier, bytes32 change, bytes32 feeChange, bytes32 commitment, address relayer, uint256 fee) p, bytes proof, bytes sealedOrder)",
]);

export const GATE_ABI = new Interface([
  "function allowed(address) view returns (bool)",
  "function associationRequired() view returns (bool)",
  "function isAssociationRoot(bytes32) view returns (bool)",
  "function latestAssociationRoot() view returns (bytes32)",
  "function postAssociationRoot(bytes32 root)",
]);

export const poolAddress = () => env("DARKPOOL_POOL_ADDRESS");
export const pool = () => new Contract(poolAddress(), POOL_ABI, provider());
export const gate = () => new Contract(env("DARKPOOL_GATE_ADDRESS"), GATE_ABI, provider());
export const operator = () => new Wallet(env("DARKPOOL_POOL_OPERATOR_KEY"));
