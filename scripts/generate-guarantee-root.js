// Generate the Guarantee whitelist Merkle root + per-wallet proofs for
// LeagueOfAgentSale.claimGuarantee.
//
// Leaf encoding MUST match the contract (LeagueOfAgentSale.sol):
//   leaf = keccak256(abi.encodePacked(wallet, maxSlots))
// Tree hashing MUST match test/helpers.js buildTree (OpenZeppelin
// MerkleProof compatible: sorted pairs, odd node duplicated).
// The hard contract cap is 1 slot/wallet (GUARANTEE_MAX_PER_WALLET), so
// maxSlots=1 for every wallet is the normal case; a per-line maxSlots
// above 1 is accepted but can never grant more than 1 slot on-chain.
//
// Usage:
//   node scripts/generate-guarantee-root.js <list-file> [--out proofs.json]
//     [--max-slots 1]
//
// List file: one wallet per line, optionally "0xabc...,2" for a per-wallet
// maxSlots; blank lines and lines starting with # are ignored. A JSON
// array of addresses (or [{address, maxSlots}]) is also accepted.
// Output: prints the root + count, and writes a proofs JSON
// { root, count, entries: [{ address, maxSlots, leaf, proof[] }] } that
// the mint page / claim script can serve per wallet.
//
// No chain interaction. No private keys. Safe to run anywhere.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const EXPECTED_COUNT = 300;

function usageFail(msg) {
  console.error(`error: ${msg}`);
  console.error(
    "usage: node scripts/generate-guarantee-root.js <list-file> [--out proofs.json] [--max-slots 1]"
  );
  process.exit(1);
}

// ---- merkle (identical to test/helpers.js) --------------------------------
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

const guaranteeLeaf = (wallet, maxSlots) =>
  ethers.solidityPackedKeccak256(["address", "uint256"], [wallet, maxSlots]);

// ---- input parsing ---------------------------------------------------------
function parseList(raw, defaultMaxSlots) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    const arr = JSON.parse(trimmed);
    if (!Array.isArray(arr)) usageFail("JSON input must be an array");
    return arr.map((item, i) => {
      if (typeof item === "string") return { address: item, maxSlots: defaultMaxSlots, line: i + 1 };
      if (item && typeof item.address === "string")
        return {
          address: item.address,
          maxSlots: item.maxSlots === undefined ? defaultMaxSlots : Number(item.maxSlots),
          line: i + 1,
        };
      usageFail(`JSON entry ${i} is not an address or {address, maxSlots}`);
    });
  }
  const entries = [];
  raw.split(/\r?\n/).forEach((lineRaw, i) => {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) return;
    const [addr, slots] = line.split(",").map((s) => s.trim());
    entries.push({
      address: addr,
      maxSlots: slots === undefined || slots === "" ? defaultMaxSlots : Number(slots),
      line: i + 1,
    });
  });
  return entries;
}

function main() {
  const args = process.argv.slice(2);
  const listFile = args.find((a) => !a.startsWith("--"));
  const outIdx = args.indexOf("--out");
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const msIdx = args.indexOf("--max-slots");
  const defaultMaxSlots = msIdx >= 0 ? Number(args[msIdx + 1]) : 1;
  if (!listFile) usageFail("missing <list-file>");
  if (!fs.existsSync(listFile)) usageFail(`list file not found: ${listFile}`);
  if (!Number.isInteger(defaultMaxSlots) || defaultMaxSlots < 1)
    usageFail("--max-slots must be a positive integer");

  const entries = parseList(fs.readFileSync(listFile, "utf8"), defaultMaxSlots);
  if (entries.length === 0) usageFail("list is empty");

  // Validate + dedupe (case-insensitive; keep checksummed form).
  const seen = new Map();
  const clean = [];
  const problems = [];
  for (const e of entries) {
    if (!ethers.isAddress(e.address)) {
      problems.push(`line ${e.line}: not an address: ${e.address}`);
      continue;
    }
    if (!Number.isInteger(e.maxSlots) || e.maxSlots < 1) {
      problems.push(`line ${e.line}: bad maxSlots for ${e.address}: ${e.maxSlots}`);
      continue;
    }
    const checksummed = ethers.getAddress(e.address);
    const key = checksummed.toLowerCase();
    if (seen.has(key)) {
      problems.push(
        `line ${e.line}: duplicate of line ${seen.get(key)}: ${checksummed}`
      );
      continue;
    }
    seen.set(key, e.line);
    clean.push({ address: checksummed, maxSlots: e.maxSlots });
  }
  if (problems.length > 0) {
    console.error("input rejected:");
    problems.forEach((p) => console.error(`  - ${p}`));
    process.exit(1);
  }

  const leaves = clean.map((e) => guaranteeLeaf(e.address, e.maxSlots));
  const tree = buildTree(leaves);
  const out = {
    root: tree.root,
    count: clean.length,
    entries: clean.map((e, i) => ({
      address: e.address,
      maxSlots: e.maxSlots,
      leaf: leaves[i],
      proof: getProof(tree, i),
    })),
  };

  const outPath =
    outFile ||
    path.join(
      path.dirname(listFile),
      `guarantee-proofs-${tree.root.slice(2, 10)}.json`
    );
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");

  console.log(`wallets: ${clean.length}`);
  console.log(`root:    ${tree.root}`);
  console.log(`proofs:  ${outPath}`);
  if (clean.length !== EXPECTED_COUNT) {
    console.log(
      `warning: expected ${EXPECTED_COUNT} Guarantee wallets, got ${clean.length} — the root is still valid, but confirm the list is final before setting it on-chain.`
    );
  }
  console.log(`next:    Sale.setGuaranteeRoot(${tree.root})  (owner, BEFORE the sale opens — it freezes at the first mint)`);
}

main();
