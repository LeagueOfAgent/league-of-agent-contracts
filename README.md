# League Of Agent — Contracts

Smart contracts for **League Of Agent** (BNB Chain) — a live 3D free-for-all
arena game built for Binance Agentic Wallets. Player identity in the game is
the player's Binance Agent ID (`.ai`), resolved on-chain from the SPACE ID
Agent ID registry.

## Contracts (all live on BNB Chain mainnet)

| Contract | File | Address |
|---|---|---|
| LoginPassNFT (ERC-721, soulbound, free mint, 1/wallet) | `contracts/LoginPassNFT.sol` | `0xAce2346c9026224c131b22921a54C6F01C82C5f5` |
| LeagueOfAgentToken (LOA, ERC-20, 1B cap) | `contracts/LeagueOfAgentToken.sol` | `0x0cc2646A720d8541c85BA91ac4161D9F60C37777` |
| LeagueOfAgentSale (token share sale + Reward Pool + seasons) | `contracts/LeagueOfAgentSale.sol` | `0x11635Bd4Df763940Ee65e04f94152310b2987777` |

All three are source-verified (exact match) on Sourcify and forwarded to
BscScan. The sale opens Fri 2026-11-27 15:00 UTC for 72 hours.

## How Agent ID is used

- **Identity:** the game server resolves a wallet's Agent ID on-chain
  (`handleOf` on the SPACE ID registry
  `0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F`) and uses `<handle>.ai` as the
  player's in-game name — no separate nickname.
- **Access:** entry to the Arena requires holding the free soulbound Login
  Pass NFT, checked on-chain against the player's Agentic Wallet.
- **Sale gating:** paid token-share tiers and the FCFS whitelist require an
  Agent ID (`balanceOf > 0` on the registry) at purchase time.

## Quick start

```sh
npm install
npx hardhat compile
npx hardhat test
```

Stack: Hardhat 2 + Solidity 0.8.24 + OpenZeppelin Contracts v5 + ethers v6.

## Key mechanics

- **Token:** 1B LOA cap — 65% mint share (40,500 slots, ~16,049.38/slot),
  35% LP reserve. No team allocation. Ownership auto-renounces at the first
  mint after the sale opens.
- **Sale:** 4 paid tiers, flat 0.004 BNB/slot, max raise 160 BNB. Tier 1
  auto-adds liquidity on sell-out, otherwise a 90% refund. Tiers 2–4 split
  per purchase: 55% LP / 10% Reward Pool / 25% Treasury / 10% Operator.
- **Referral:** 5% of a referred buyer's paid mint volume, paid in BNB
  inside the same transaction, funded from the Treasury share.
- **Reward Pool:** 30-day ranked seasons; the season fund is
  `min(pool, max(4 BNB, 50% of pool))` for Season 1, 50% after. The contract
  buys LOA back from the PancakeSwap LP in 8 tranches over 24 h and pays the
  Top 500. The pool has no withdraw function.
- **Tax:** 3% only when one side is the LP pair (1.5% Treasury + 1.5%
  Reward Pool); wallet-to-wallet transfers are tax-free.

## Links

- Play the game: https://play.leagueofagent.fun/
- Free NFT mint: https://mint.leagueofagent.fun/
- Official site: https://leagueofagent.fun/
- X: https://x.com/Battle_LOA · Telegram: https://t.me/Battle_LOA
