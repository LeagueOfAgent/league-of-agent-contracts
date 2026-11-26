#!/usr/bin/env node
/**
 * League Of Agent — season keeper (buyback + close).
 *
 * What it does, once per run (call it from cron every 3 hours):
 *   - closes any season whose 30-day window has ended (closeSeason), and
 *   - executes the next buyback tranche of any closed season whose 3-hour
 *     spacing has elapsed (executeBuybackTranche).
 *
 * The contract cannot run on a clock by itself, so this script is the
 * clock: it only presses the button at the right time. ALL money logic
 * (fund size, tranche size, the swap itself) lives in the contract —
 * this script never computes amounts, never sets slippage, never swaps.
 * Both functions are permissionless, so any wallet with BNB for gas
 * can be the keeper.
 *
 * Standalone: only dependency is ethers v6 (`npm i ethers`). It embeds
 * a minimal ABI and never reads Hardhat build artifacts.
 *
 * Configuration is 100% environment variables — nothing is hardcoded:
 *   RPC_URL              BSC RPC endpoint (mainnet or testnet) [required]
 *   TOKEN_ADDRESS        LeagueOfAgentToken contract address [required]
 *   KEEPER_PRIVATE_KEY   Keeper wallet key (BNB for gas only) [required]
 *   SEASONS_TO_CHECK     Optional: comma list, e.g. "1,2". Default: every
 *                        season from 1 up to the current one.
 *   LOG_LEVEL            "info" (default) or "debug".
 *
 * Exit codes: 0 = ok (including "nothing due"); 1 = RPC error, tx
 * failure, or bad/missing config. One run, then exit — no background loop.
 */
"use strict";

const { ethers } = require("ethers");

const SEASON_DURATION = 30 * 24 * 3600; // seconds, matches Token.SEASON_DURATION
const TRANCHE_COUNT = 8; // matches Token.TRANCHE_COUNT
const TRANCHE_INTERVAL = 3 * 3600; // seconds, matches Token.TRANCHE_INTERVAL

// Minimal ABI: only the functions this keeper ever calls or reads.
const TOKEN_ABI = [
  "function launched() view returns (bool)",
  "function launchTime() view returns (uint256)",
  "function seasonEndTime(uint256 seasonId) view returns (uint256)",
  "function seasons(uint256 seasonId) view returns (uint256 closeTime, uint256 fundBNB, uint8 tranchesDone, uint256 lastTrancheTime, uint256 prizeLOA, uint256 claimedLOA, bytes32 claimRoot, uint256 claimDeadline, bool swept)",
  "function closeSeason(uint256 seasonId)",
  "function executeBuybackTranche(uint256 seasonId)",
];

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();

function log(level, msg) {
  if (level === "debug" && LOG_LEVEL !== "debug") return;
  const ts = new Date().toISOString();
  console.log(`[${ts}] [keeper] [${level}] ${msg}`);
}

function fail(msg) {
  console.error(`[keeper] [error] ${msg}`);
  process.exit(1);
}

function parseSeasonsToCheck(raw, currentSeason) {
  if (!raw) {
    const list = [];
    for (let i = 1; i <= currentSeason; i++) list.push(i);
    return list;
  }
  const list = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1);
  if (list.length === 0) fail(`SEASONS_TO_CHECK has no valid season id: "${raw}"`);
  return [...new Set(list)].sort((a, b) => a - b);
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  const tokenAddress = process.env.TOKEN_ADDRESS;
  const keeperKey = process.env.KEEPER_PRIVATE_KEY;

  if (!rpcUrl) fail("missing required env RPC_URL");
  if (!tokenAddress || !ethers.isAddress(tokenAddress)) {
    fail(`missing or invalid env TOKEN_ADDRESS: ${tokenAddress || "(empty)"}`);
  }
  if (!keeperKey) fail("missing required env KEEPER_PRIVATE_KEY");
  // Never print the key — not even partially.

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  let wallet;
  try {
    // NonceManager: this run can send several tx back-to-back (close +
    // tranche 1). A plain Wallet re-reads the pending nonce from the
    // provider for each send, and right after a tx is mined that read
    // can still return the pre-tx nonce ("Nonce too low" / tx never
    // mines). The manager caches the nonce once and increments locally,
    // so sends in one run are sequential. Fresh instance per run.
    wallet = new ethers.NonceManager(new ethers.Wallet(keeperKey, provider));
  } catch (e) {
    fail(`KEEPER_PRIVATE_KEY is not a valid private key (${e.message})`);
  }
  const keeperAddress = await wallet.getAddress();
  const token = new ethers.Contract(tokenAddress, TOKEN_ABI, wallet);

  let chainId;
  try {
    chainId = (await provider.getNetwork()).chainId;
  } catch (e) {
    fail(`cannot reach RPC at ${rpcUrl}: ${e.message}`);
  }
  log("info", `chain ${chainId} token ${tokenAddress} keeper ${keeperAddress}`);

  let launched;
  let launchTime;
  try {
    launched = await token.launched();
    launchTime = await token.launchTime();
  } catch (e) {
    fail(`cannot read token state: ${e.message}`);
  }
  if (!launched) {
    log("info", "not launched yet — nothing to do");
    return;
  }

  let now;
  try {
    // Chain time is the clock that matters (not wall time): the contract
    // enforces its deadlines against block timestamps.
    now = (await provider.getBlock("latest")).timestamp;
  } catch (e) {
    fail(`cannot read latest block: ${e.message}`);
  }
  const launchTimeNum = Number(launchTime);
  if (now < launchTimeNum) {
    log("info", "launchTime is in the future — nothing to do");
    return;
  }
  const currentSeason = Math.floor((now - launchTimeNum) / SEASON_DURATION) + 1;
  log(
    "info",
    `launched at ${launchTimeNum} (${new Date(launchTimeNum * 1000).toISOString()}), ` +
      `now ${now}, current season ${currentSeason}`
  );

  const seasons = parseSeasonsToCheck(process.env.SEASONS_TO_CHECK, currentSeason);
  log("debug", `seasons to check: ${seasons.join(", ")}`);

  // Fail fast with a clear message instead of sending a tx that runs out
  // of gas money mid-run. 0.001 BNB is a generous ceiling for these calls.
  let balance = 0n;
  try {
    balance = await provider.getBalance(keeperAddress);
  } catch (e) {
    fail(`cannot read keeper balance: ${e.message}`);
  }
  log("debug", `keeper balance ${ethers.formatEther(balance)} BNB`);

  let closed = 0;
  let tranches = 0;
  let skipped = 0;

  // A sent tx mines in a new block, so the chain clock moves past the
  // `now` sampled at the start of the run. Refresh it after every send —
  // and read the RECEIPT's block by number, not "latest": ethers'
  // JsonRpcProvider caches identical requests for ~250ms, so a "latest"
  // read right after a send can still return the pre-tx block and make
  // tranche 1 (due exactly at closeTime) look 1s too early.
  async function refreshNow(blockNumber) {
    try {
      const block =
        blockNumber != null
          ? await provider.getBlock(blockNumber)
          : await provider.getBlock("latest");
      now = block.timestamp;
    } catch (e) {
      fail(`cannot re-read block: ${e.message}`);
    }
  }

  // `method` is the contract method itself (e.g. token.closeSeason) with
  // its args — NOT a wrapper closure: ethers v6 attaches .staticCall to
  // the method, and a wrapper would not have it.
  async function sendChecked(label, method, args) {
    // Static-call first: only send a tx we expect to succeed, so a
    // re-run never fires a reverting transaction.
    try {
      await method.staticCall(...args);
    } catch (e) {
      log("info", `${label}: staticCall reverted, not sending (${e.message})`);
      skipped++;
      return null;
    }
    if (balance < ethers.parseEther("0.001")) {
      fail(`${label}: keeper wallet ${keeperAddress} is out of BNB for gas`);
    }
    let tx;
    try {
      tx = await method(...args);
    } catch (e) {
      fail(`${label}: send failed: ${e.message}`);
    }
    log("info", `${label}: sent ${tx.hash}`);
    let receipt;
    try {
      receipt = await tx.wait(1);
    } catch (e) {
      fail(`${label}: tx ${tx.hash} did not confirm: ${e.message}`);
    }
    if (receipt.status !== 1) {
      fail(`${label}: tx ${tx.hash} reverted on-chain`);
    }
    log("info", `${label}: confirmed in block ${receipt.blockNumber}`);
    return receipt;
  }

  for (const seasonId of seasons) {
    let s;
    try {
      s = await token.seasons(seasonId);
    } catch (e) {
      fail(`cannot read seasons(${seasonId}): ${e.message}`);
    }
    const endTime = Number(await token.seasonEndTime(seasonId));
    log(
      "debug",
      `season ${seasonId}: closeTime=${s.closeTime} fundBNB=${ethers.formatEther(s.fundBNB)} ` +
        `tranchesDone=${s.tranchesDone} lastTrancheTime=${s.lastTrancheTime} endTime=${endTime}`
    );

    // --- close the season if its window ended and it is still open ---
    if (s.closeTime === 0n) {
      if (now >= endTime) {
        const receipt = await sendChecked(
          `closeSeason(${seasonId})`,
          token.closeSeason,
          [seasonId]
        );
        if (receipt) {
          closed++;
          await refreshNow(receipt.blockNumber);
          s = await token.seasons(seasonId); // re-read: tranche 1 is due now
          log(
            "info",
            `season ${seasonId} closed, fund ${ethers.formatEther(s.fundBNB)} BNB`
          );
        }
      } else {
        log(
          "info",
          `season ${seasonId} not ended yet (ends ${new Date(endTime * 1000).toISOString()})`
        );
        continue;
      }
    }

    // --- next buyback tranche, if one is due ---
    if (Number(s.tranchesDone) >= TRANCHE_COUNT) {
      log("info", `season ${seasonId} buyback complete (${s.tranchesDone}/8)`);
      continue;
    }
    const nextAllowed =
      Number(s.tranchesDone) === 0
        ? Number(s.closeTime)
        : Number(s.lastTrancheTime) + TRANCHE_INTERVAL;
    if (now >= nextAllowed) {
      const receipt = await sendChecked(
        `executeBuybackTranche(${seasonId}) #${Number(s.tranchesDone) + 1}`,
        token.executeBuybackTranche,
        [seasonId]
      );
      if (receipt) {
        tranches++;
        await refreshNow(receipt.blockNumber);
        const after = await token.seasons(seasonId);
        log(
          "info",
          `season ${seasonId} tranche ${after.tranchesDone}/8 done, ` +
            `prizeLOA now ${ethers.formatEther(after.prizeLOA)} LOA`
        );
      }
    } else {
      log(
        "info",
        `season ${seasonId} tranche #${Number(s.tranchesDone) + 1} not due until ` +
          `${new Date(nextAllowed * 1000).toISOString()}`
      );
    }
  }

  log("info", `done: ${closed} season(s) closed, ${tranches} tranche(s) executed, ${skipped} skipped`);
}

main().catch((e) => fail(`unexpected error: ${e.message || e}`));
