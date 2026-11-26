// Cross-check a season's submitted Merkle root against the game's leaderboard.
//
// The Token contract never sees the ranking: at season close the operator
// builds the winners' Merkle tree off-chain from the leaderboard and
// submits ONLY the root (submitClaimRoot). This script recomputes that root
// independently from the game's own database export and compares it with
// the root stored on-chain. MATCH = the submitted root is exactly the
// leaderboard's Top 500 with the agreed prize split. MISMATCH = someone
// submitted a different winners/amounts set.
//
// Data sources:
//   - Leaderboard: exported from the game DB (the public API hides wallet
//     addresses, so the API alone is NOT enough — the export below is the
//     same query the leaderboard uses, plus the wallet + created_at the
//     API omits).
//   - On-chain: Token.seasons(seasonId) (prizeLOA + claimRoot) and
//     LoginPassNFT.hasLoginPass per wallet (BSC mainnet, read-only).
//
// Usage:
//   1. Export the leaderboard from the VPS game DB:
//      ssh root@207.148.116.100 'cd /opt/loa-server && docker compose exec -T postgres sh -c '\''psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -A -c "SELECT json_agg(t) FROM (SELECT wallet_address, display_name, total_points, ranked_matches, created_at FROM accounts ORDER BY total_points DESC, created_at ASC) t;"'\''' > leaderboard.json
//   2. Verify season 1 (default Token = the deployed mainnet address):
//      node scripts/verify-season-root.js 1 leaderboard.json
//      TOKEN_ADDRESS=0x... RPC_URL=https://bsc-dataseed.binance.org node scripts/verify-season-root.js 1 leaderboard.json
//
// Exit codes: 0 = MATCH (or root not submitted yet — computed root printed
// for the operator), 1 = MISMATCH, 2 = cannot verify (bad input, season
// not closed, buyback incomplete, token not deployed).
//
// Rules baked in (user decisions 2026-11-23/24):
//   - Eligibility: ranked_matches >= 20 AND holds the Login Pass NFT.
//     Filter FIRST, then rank the eligible and take the Top 500.
//   - Ranking = exactly the leaderboard's order: total_points DESC,
//     created_at ASC. (The spec's wins/kills tie-break is NOT implemented
//     in the leaderboard query, so it is NOT used here either — the root
//     must match the leaderboard players actually see. Ties sitting on a
//     prize-bracket boundary are flagged in the output.)
//   - Prize split of prizeLOA (per 100,000): rank 1: 8000, 2: 6000,
//     3: 5000, 4-5: 3000, 6-10: 2000, 11-20: 1250, 21-50: 600,
//     51-100: 300, 101-200: 120, 201-500: 25. Amounts are floored per
//     winner; the dust (prizeLOA minus the distributed sum) stays in the
//     contract and returns to the reward bucket via sweepUnclaimed.
//   - Leaves are in RANK order (rank 1 first). The root depends on leaf
//     order, so whoever builds the submitted root MUST use this same
//     order — this script is the reference implementation.
//
// Requires: ethers (already in this project's node_modules). No key, no
// signer, no transactions — read-only.

const { ethers } = require("ethers");
const fs = require("fs");

const DEFAULT_RPC = "https://bsc-dataseed.binance.org";
const DEFAULT_TOKEN = "0x0cc2646A720d8541c85BA91ac4161D9F60C37777"; // mainnet Token (7777)
const DEFAULT_LOGIN_PASS = "0xAce2346c9026224c131b22921a54C6F01C82C5f5"; // mainnet Login Pass NFT

const TOKEN_ABI = [
  "function seasons(uint256) view returns (uint256 closeTime, uint256 fundBNB, uint8 tranchesDone, uint256 lastTrancheTime, uint256 prizeLOA, uint256 claimedLOA, bytes32 claimRoot, uint256 claimDeadline, bool swept)",
];
const LOGIN_PASS_ABI = ["function hasLoginPass(address) view returns (bool)"];

const MIN_RANKED_MATCHES = 20;
const TOP_N = 500;
const TRANCHE_COUNT = 8;
// Prize split, per 100,000 of prizeLOA (sums to 100,000).
const PRIZE_BPS_100K = [
  { from: 1, to: 1, bps: 8000 },
  { from: 2, to: 2, bps: 6000 },
  { from: 3, to: 3, bps: 5000 },
  { from: 4, to: 5, bps: 3000 },
  { from: 6, to: 10, bps: 2000 },
  { from: 11, to: 20, bps: 1250 },
  { from: 21, to: 50, bps: 600 },
  { from: 51, to: 100, bps: 300 },
  { from: 101, to: 200, bps: 120 },
  { from: 201, to: 500, bps: 25 },
];
function bpsForRank(rank) {
  const b = PRIZE_BPS_100K.find((x) => rank >= x.from && rank <= x.to);
  return b ? b.bps : 0;
}
// Bracket boundaries where a tie decides different prizes.
const BOUNDARIES = [1, 2, 3, 5, 10, 20, 50, 100, 200];

// ---- Merkle helpers (mirror test/helpers.js exactly: sorted pairs, odd leaf duplicated) ----
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
function claimLeaf(seasonId, winner, amount) {
  return ethers.solidityPackedKeccak256(
    ["uint256", "address", "uint256"],
    [seasonId, winner, amount]
  );
}
// OpenZeppelin MerkleProof.verify equivalent (sorted pairs).
function verifyProof(leaf, proof, root) {
  let hash = leaf;
  for (const el of proof) hash = hashPair(hash, el);
  return hash.toLowerCase() === root.toLowerCase();
}

// ---- ranking ---------------------------------------------------------------
function rankWinners(rows, prizeLOA) {
  // rows: [{ wallet, displayName, points, rankedMatches, createdAt }] — already
  // eligibility-filtered. Sort exactly like the leaderboard query.
  const sorted = rows.slice().sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });
  const top = sorted.slice(0, TOP_N);
  const winners = top.map((r, i) => {
    const rank = i + 1;
    const bps = bpsForRank(rank);
    const amount = (prizeLOA * BigInt(bps)) / 100000n; // floor
    return { rank, wallet: r.wallet, displayName: r.displayName, points: r.points, bps, amount };
  });
  const distributed = winners.reduce((s, w) => s + w.amount, 0n);
  const tieWarnings = [];
  for (const b of BOUNDARIES) {
    const above = winners[b - 1];
    const below = winners[b];
    if (above && below && above.points === below.points) {
      tieWarnings.push(
        `tie at ranks ${b}/${b + 1}: ${above.wallet} and ${below.wallet} both have ${above.points} points — created_at order decides ${ethers.formatEther(above.amount)} vs ${ethers.formatEther(below.amount)} LOA`
      );
    }
  }
  return { winners, distributed, dust: prizeLOA - distributed, tieWarnings };
}

function buildSeasonRoot(seasonId, winners) {
  const leaves = winners.map((w) => claimLeaf(seasonId, w.wallet, w.amount));
  const tree = buildTree(leaves);
  return { root: tree.root, tree, leaves };
}

// ---- main verification -----------------------------------------------------
async function verifySeason({ provider, tokenAddress, loginPassAddress, seasonId, rows }) {
  // Validate + normalize rows.
  const seen = new Set();
  const clean = rows.map((r, i) => {
    const wallet = ethers.getAddress(r.wallet_address);
    if (seen.has(wallet.toLowerCase())) throw new Error(`duplicate wallet in leaderboard row ${i}: ${wallet}`);
    seen.add(wallet.toLowerCase());
    const points = Number(r.total_points);
    const rankedMatches = Number(r.ranked_matches);
    if (!Number.isFinite(points) || points < 0) throw new Error(`bad total_points in row ${i}`);
    if (!Number.isFinite(rankedMatches) || rankedMatches < 0) throw new Error(`bad ranked_matches in row ${i}`);
    return {
      wallet,
      displayName: r.display_name || "",
      points,
      rankedMatches,
      createdAt: r.created_at,
    };
  });

  const token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
  if ((await provider.getCode(tokenAddress)) === "0x") {
    throw new Error(`no code at token address ${tokenAddress} — Token not deployed there`);
  }
  const s = await token.seasons(seasonId);
  const season = {
    closeTime: s[0],
    fundBNB: s[1],
    tranchesDone: Number(s[2]),
    prizeLOA: s[4],
    claimRoot: s[6],
    claimDeadline: s[7],
  };
  if (season.closeTime === 0n) {
    return { verdict: "NOT_CLOSED", season, totalRows: clean.length };
  }
  const buybackComplete = season.tranchesDone >= TRANCHE_COUNT;

  // Eligibility: >=20 ranked matches, then Login NFT on-chain.
  const byMatches = clean.filter((r) => r.rankedMatches >= MIN_RANKED_MATCHES);
  const pass = new ethers.Contract(loginPassAddress, LOGIN_PASS_ABI, provider);
  const eligible = [];
  const noNft = [];
  const CONCURRENCY = 20;
  for (let i = 0; i < byMatches.length; i += CONCURRENCY) {
    const chunk = byMatches.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map((r) => pass.hasLoginPass(r.wallet)));
    chunk.forEach((r, j) => (results[j] ? eligible.push(r) : noNft.push(r)));
  }

  const { winners, distributed, dust, tieWarnings } = rankWinners(eligible, season.prizeLOA);
  const { root: computedRoot, tree, leaves } = buildSeasonRoot(seasonId, winners);
  // Self-consistency: every winner's proof verifies against the computed root.
  for (let i = 0; i < winners.length; i++) {
    if (!verifyProof(leaves[i], getProof(tree, i), computedRoot)) {
      throw new Error(`internal error: proof for rank ${i + 1} does not verify against the computed root`);
    }
  }

  let verdict;
  if (season.claimRoot === ethers.ZeroHash) verdict = "NO_ROOT";
  else if (season.claimRoot.toLowerCase() === computedRoot.toLowerCase()) verdict = "MATCH";
  else verdict = "MISMATCH";
  return {
    verdict,
    season,
    buybackComplete,
    totalRows: clean.length,
    afterMatchesFilter: byMatches.length,
    afterNftFilter: eligible.length,
    noNftCount: noNft.length,
    winners,
    distributed,
    dust,
    tieWarnings,
    computedRoot,
    onChainRoot: season.claimRoot,
  };
}

async function main() {
  const seasonId = Number(process.argv[2] || "1");
  const file = process.argv[3];
  if (!file) {
    console.error("usage: node scripts/verify-season-root.js <seasonId> <leaderboard.json>");
    process.exit(2);
  }
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(rows)) throw new Error("leaderboard file must be a JSON array");
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || DEFAULT_RPC);
  const tokenAddress = process.env.TOKEN_ADDRESS || DEFAULT_TOKEN;
  const loginPassAddress = process.env.LOGIN_PASS_ADDRESS || DEFAULT_LOGIN_PASS;

  const r = await verifySeason({ provider, tokenAddress, loginPassAddress, seasonId, rows });

  console.log(`Season ${seasonId} — Token ${tokenAddress}`);
  if (r.verdict === "NOT_CLOSED") {
    console.log(`Season not closed yet (closeTime = 0). Nothing to verify.`);
    console.log(`Leaderboard rows: ${r.totalRows}`);
    process.exit(2);
  }
  console.log(`Fund: ${ethers.formatEther(r.season.fundBNB)} BNB | prizeLOA: ${ethers.formatEther(r.season.prizeLOA)} LOA | tranches: ${r.season.tranchesDone}/8`);
  if (!r.buybackComplete) {
    console.log(`WARNING: buyback incomplete (${r.season.tranchesDone}/8) — prizeLOA is not final, the computed root WILL change. This is a PREVIEW only.`);
  }
  console.log(`Leaderboard rows: ${r.totalRows} | >=20 ranked: ${r.afterMatchesFilter} | + Login NFT: ${r.afterNftFilter} (no NFT: ${r.noNftCount}) | winners: ${r.winners.length}`);
  console.log(`Distributed: ${ethers.formatEther(r.distributed)} LOA | dust: ${ethers.formatEther(r.dust)} LOA`);
  for (const w of r.tieWarnings) console.log(`WARNING: ${w}`);
  console.log(`Computed root: ${r.computedRoot}`);
  console.log(`On-chain root: ${r.onChainRoot}`);
  if (r.verdict === "MATCH") {
    console.log(`VERDICT: MATCH — the submitted root is exactly the leaderboard Top ${r.winners.length} with the agreed split.`);
    process.exit(0);
  }
  if (r.verdict === "NO_ROOT") {
    console.log(`VERDICT: NO_ROOT — no root submitted yet. The operator can submit the computed root above (after the 48h review).`);
    const out = `verify-season-${seasonId}-computed.json`;
    fs.writeFileSync(out, JSON.stringify({ seasonId, computedRoot: r.computedRoot, winners: r.winners.map((w) => ({ ...w, amount: w.amount.toString() })) }, null, 2));
    console.log(`Computed winners table saved to ${out}`);
    process.exit(0);
  }
  console.log(`VERDICT: MISMATCH — the submitted root does NOT match the leaderboard recomputation. Do NOT trust the submitted root; investigate before the claim window is relied on.`);
  const out = `verify-season-${seasonId}-computed.json`;
  fs.writeFileSync(out, JSON.stringify({ seasonId, computedRoot: r.computedRoot, onChainRoot: r.onChainRoot, winners: r.winners.map((w) => ({ ...w, amount: w.amount.toString() })) }, null, 2));
  console.log(`Computed winners table saved to ${out} for comparison against the submitted set.`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`ERROR: ${e.message}`);
    process.exit(2);
  });
}

module.exports = { verifySeason, rankWinners, buildSeasonRoot, claimLeaf, getProof, verifyProof, PRIZE_BPS_100K };
