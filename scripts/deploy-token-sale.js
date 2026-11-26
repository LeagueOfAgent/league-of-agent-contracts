// Deploy the LOA token suite: LeagueOfAgentSale + LeagueOfAgentToken.
//
// Target: BSC TESTNET (chainId 97) first — testnet -> audit -> mainnet is
// the project's standing discipline. Do NOT point this at mainnet until
// the audit is done.
//
// Deployment order resolves the Token <-> Sale circular dependency:
//   1. LeagueOfAgentSale (takes treasury + operator wallets, Agent ID
//      registry, Login Pass NFT addresses — all known upfront).
//   2. LeagueOfAgentToken (constructor takes the Sale address, the two
//      wallets, and the router, and mints the 650,000,000 LOA mint share
//      straight to the Sale; the 350,000,000 LOA LP reserve stays in the
//      token contract).
//   3. Sale.setToken(tokenAddress) — one-time link.
//
// After deployment (owner steps, in order, when ready):
//   - Sale.setGuaranteeRoot(guaranteeRoot)                      [before start; Guarantee only —
//     FCFS has NO Merkle root since 2026-11-25: NFT + Agent ID only]
//   - Sale.setSaleTimes(start, end) — SET AUTOMATICALLY by this script
//     (user decision 2026-11-26): start 1795791600 = Fri 2026-11-27 15:00 UTC,
//     end 1796050800 = Mon 2026-11-30 15:00 UTC (+72h). Override via
//     SALE_START_TIME / SALE_END_TIME env.
//   - Token season operator: passed as a CONSTRUCTOR arg (SEASON_OPERATOR
//     env below) — no setSeasonOperator anymore (user decision 2026-11-26).
//   - Ownership RENOUNCES AUTOMATICALLY at the first mint after the sale
//     opens (user decision 2026-11-26) — the Sale renounces both contracts
//     in that mint transaction. No manual renounce step. Consequence: the
//     Guarantee root must be final BEFORE the sale opens (setGuaranteeRoot
//     freezes at the first mint); sale times freeze too.
//   - Launch ACTIVATES AUTOMATICALLY at the first liquidity add (tier-1
//     sellout auto-add or Treasury early open) — no activateLaunch() call
//     anymore (user decision 2026-11-26). No finalizeLaunch() either.
//   - No finalizeSale() anymore (user decision 2026-11-26): the Sale's
//     leftover LOA burns automatically on the first post-sale-end touch
//     (claimRefund / sweepExpiredRefunds), tier-1 refund tokens burn in
//     the refund transaction itself, and leftover BNB sweeps to the
//     treasury via sweepExpiredRefunds() after the 7-day refund window.
//   Per completed tier: anyone may call Token.addTierLiquidity(tier).
//   PAIR-ONLY TAX (user decision 2026-11-25): the 3% tax applies ONLY to
//   transfers where one side is the LP pair; wallet-to-wallet transfers
//   are tax-free. The pair is set AUTOMATICALLY by the Token itself when
//   the first addTierLiquidity() runs (user decision 2026-11-26): it
//   reads the pair from the Pancake factory (factory.getPair(token,
//   WETH)) — there is NO owner setPair call anymore, and no manual step
//   after the first liquidity add.
//
// Configuration via environment:
//   TREASURY_WALLET     (required) treasury = marketing wallet.
//                       Mainnet (user-provided 2026-11-25):
//                       0x2A57CBeF4cC7C5995a4f0D6b67D47f30DCAbe402
//   OPERATOR_WALLET   (required) operator wallet.
//                       Mainnet (user-provided 2026-11-25):
//                       0x1dec0381323391eC78511E4019c79EFf412C2aa9
//                       SEASON_OPERATOR defaults to this wallet (user
//                       decision 2026-11-26) — set it for real deploys.
//   AGENT_ID_REGISTRY   Agent ID registry. Mainnet: 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F
//                       (SPACE ID ".ai" registry — the SAME address is used
//                       for testnet rehearsals only if a registry/mock is
//                       deployed there; set explicitly.)
//   LOGIN_PASS_ADDRESS  Login Pass NFT. Mainnet: 0xAce2346c9026224c131b22921a54C6F01C82C5f5
//   PANCAKE_ROUTER      PancakeSwap V2 router.
//                       Mainnet: 0x10ED43C718714eb63d5aA57B78B54704E256024E
//                       Testnet: 0xD99D1c33F9fC3444f8101754aBC46c52416550D1 (default below)
//   SEASON_OPERATOR     Season operator: the ONLY address that may submit a
//                       season's claim Merkle root (and co-sign revenue
//                       deposits). Set once in the Token constructor; never
//                       changeable; survives the automatic renounce at the
//                       first mint (user decision 2026-11-26). Defaults to
//                       the Operator wallet (OPERATOR_WALLET above; mainnet
//                       0x1dec0381323391eC78511E4019c79EFf412C2aa9) — user
//                       decision 2026-11-26. Set SEASON_OPERATOR explicitly
//                       only if a different operator is ever wanted.
//
// Run (testnet):  DEPLOYER_PRIVATE_KEY=... npx hardhat run scripts/deploy-token-sale.js --network bscTestnet

const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log("Deployer:", deployer.address);
  console.log("Chain ID:", network.chainId.toString());

  const treasuryWallet = process.env.TREASURY_WALLET || deployer.address;
  const operatorWallet = process.env.OPERATOR_WALLET || deployer.address;
  const agentIDRegistry = process.env.AGENT_ID_REGISTRY;
  const loginPass = process.env.LOGIN_PASS_ADDRESS;
  const pancakeRouter =
    process.env.PANCAKE_ROUTER || "0xD99D1c33F9fC3444f8101754aBC46c52416550D1"; // BSC testnet
  const seasonOperator = process.env.SEASON_OPERATOR || operatorWallet;
  const saleStartTime = Number(process.env.SALE_START_TIME || "1795791600"); // Fri 2026-11-27 15:00 UTC (user decision 2026-11-26)
  const saleEndTime = Number(process.env.SALE_END_TIME || "1796050800"); // Mon 2026-11-30 15:00 UTC (+72h)
  if (!(saleEndTime > saleStartTime)) throw new Error("SALE_END_TIME must be after SALE_START_TIME");

  if (!agentIDRegistry) throw new Error("AGENT_ID_REGISTRY env is required");
  if (!loginPass) throw new Error("LOGIN_PASS_ADDRESS env is required");

  console.log("Treasury wallet:  ", treasuryWallet);
  console.log("Operator wallet:", operatorWallet);
  console.log("Season operator: ", seasonOperator);
  console.log("Agent ID registry:", agentIDRegistry);
  console.log("Login Pass NFT:  ", loginPass);
  console.log("Pancake router:  ", pancakeRouter);
  console.log("Sale window:     ", new Date(saleStartTime * 1000).toISOString(), "->", new Date(saleEndTime * 1000).toISOString());

  // 1. Sale first.
  const Sale = await ethers.getContractFactory("LeagueOfAgentSale");
  const sale = await Sale.deploy(deployer.address, treasuryWallet, operatorWallet, agentIDRegistry, loginPass);
  await sale.waitForDeployment();
  const saleAddress = await sale.getAddress();
  console.log("LeagueOfAgentSale deployed:", saleAddress);

  // 2. Token, with the Sale address known (mints the 650M share to it).
  //    The season operator is a constructor arg (user decision 2026-11-26).
  const Token = await ethers.getContractFactory("LeagueOfAgentToken");
  const token = await Token.deploy(
    deployer.address,
    saleAddress,
    treasuryWallet,
    operatorWallet,
    pancakeRouter,
    seasonOperator
  );
  await token.waitForDeployment();
  const tokenAddress = await token.getAddress();
  console.log("LeagueOfAgentToken deployed:", tokenAddress);

  // 3. One-time link from Sale to Token.
  const tx = await sale.setToken(tokenAddress);
  await tx.wait();
  console.log("Sale.setToken done.");

  // 4. Sale window (user decision 2026-11-26).
  const txTimes = await sale.setSaleTimes(saleStartTime, saleEndTime);
  await txTimes.wait();
  console.log("Sale.setSaleTimes done.");

  // Sanity checks.
  const saleBalance = await token.balanceOf(saleAddress);
  const tokenBalance = await token.balanceOf(tokenAddress);
  console.log("Sale LOA balance: ", ethers.formatUnits(saleBalance, 18));
  console.log("Token LOA balance:", ethers.formatUnits(tokenBalance, 18));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
