const { ethers } = require("hardhat");

// ---- time travel -----------------------------------------------------------
async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}

// ---- merkle trees (OpenZeppelin MerkleProof compatible: sorted pairs) -----
function hashPair(a, b) {
  const ordered = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
  return ethers.keccak256(ethers.concat(ordered));
}

function buildTree(leaves) {
  const layers = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = level[i + 1] !== undefined ? level[i + 1] : a;
      next.push(hashPair(a, b));
    }
    level = next;
    layers.push(level);
  }
  return { root: level[0], layers };
}

function getProof(tree, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const level = tree.layers[l];
    const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(level[sib] !== undefined ? level[sib] : level[idx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

// ---- leaf encodings (must match the contracts' abi.encodePacked) ----------
const fcfsLeaf = (wallet) =>
  ethers.solidityPackedKeccak256(["address"], [wallet]);
const guaranteeLeaf = (wallet, maxSlots) =>
  ethers.solidityPackedKeccak256(["address", "uint256"], [wallet, maxSlots]);
const claimLeaf = (seasonId, winner, amount) =>
  ethers.solidityPackedKeccak256(
    ["uint256", "address", "uint256"],
    [seasonId, winner, amount]
  );

module.exports = {
  increaseTime,
  latestTimestamp,
  buildTree,
  getProof,
  fcfsLeaf,
  guaranteeLeaf,
  claimLeaf,
};
