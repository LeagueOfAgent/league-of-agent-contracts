const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  increaseTime,
  buildTree,
  getProof,
  claimLeaf,
} = require("./helpers");

const LOA = (n) => ethers.parseUnits(n.toString(), 18);
const BNB = (n) => ethers.parseEther(n.toString());
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 24 * 3600;

// In these token-focused tests the "sale contract" is an EOA signer: the
// token constructor simply mints the 650M share to whatever address it is
// given, which lets us drive receiveTierSplit() and exempt transfers
// directly without the real Sale in the loop.
describe("LeagueOfAgentToken", function () {
  let token, router, factory, pair;
  let owner, sale, treasury, operatorWallet, operator, alice, bob, carol;

  beforeEach(async function () {
    [owner, sale, treasury, operatorWallet, operator, alice, bob, carol] =
      await ethers.getSigners();
    const MockRouter = await ethers.getContractFactory("MockPancakeRouter");
    router = await MockRouter.deploy();
    await router.waitForDeployment();
    factory = await ethers.getContractAt(
      "MockPancakeFactory",
      await router.factory()
    );
    pair = await ethers.getContractAt("MockPair", await router.pair());

    const Token = await ethers.getContractFactory("LeagueOfAgentToken");
    token = await Token.deploy(
      owner.address,
      sale.address,
      treasury.address,
      operatorWallet.address,
      await router.getAddress(),
      operator.address
    );
    await token.waitForDeployment();
  });

  // Set the pair the way production does now (user decision 2026-11-26):
  // configure the mock factory, then trigger a liquidity add — the Token
  // reads the pair from the factory and the pair-only tax starts. A
  // zero-value tier split pairs the tier's tokens with no BNB, so pool
  // numbers stay exact in tests that assert them.
  async function setPairViaLiquidity(pairAddr) {
    await factory.configure(
      await token.getAddress(),
      await router.WETH(),
      pairAddr
    );
    await token.connect(sale).receiveTierSplit(0, 10_000, { value: 0 });
    await token.addTierLiquidity(0);
    expect(await token.pair()).to.equal(pairAddr);
  }

  // ---------------------------------------------------------- brief item 1
  it("construction: name/symbol/decimals, 1B cap split 650M sale / 350M token", async function () {
    expect(await token.name()).to.equal("League Of Agent");
    expect(await token.symbol()).to.equal("LOA");
    expect(await token.decimals()).to.equal(18);
    expect(await token.totalSupply()).to.equal(LOA(1_000_000_000));
    expect(await token.balanceOf(sale.address)).to.equal(LOA(650_000_000));
    expect(await token.balanceOf(await token.getAddress())).to.equal(
      LOA(350_000_000)
    );
  });

  // ---------------------------------------------------------- brief item 2
  // Pair-only tax (user decision 2026-11-25): wallet-to-wallet transfers
  // are tax-free; only transfers where one side is the LP pair (a buy or
  // a sell) are taxed 3% (1.5% treasury / 1.5% reward bucket).
  it("tax: wallet-to-wallet transfer is tax-free while the pair is unset", async function () {
    expect(await token.pair()).to.equal(ethers.ZeroAddress);
    await token.connect(sale).transfer(alice.address, LOA(200_000)); // exempt side: untaxed
    expect(await token.balanceOf(alice.address)).to.equal(LOA(200_000));

    await token.connect(alice).transfer(bob.address, LOA(100_000));
    expect(await token.balanceOf(bob.address)).to.equal(LOA(100_000));
    expect(await token.balanceOf(treasury.address)).to.equal(0);
    expect(await token.balanceOf(operatorWallet.address)).to.equal(0);
    expect(await token.rewardTokenBucket()).to.equal(0);
  });

  it("tax: transfer from an exempt address is untaxed", async function () {
    await token.connect(sale).transfer(carol.address, LOA(50_000));
    expect(await token.balanceOf(carol.address)).to.equal(LOA(50_000));
    expect(await token.rewardTokenBucket()).to.equal(0);
  });

  it("tax: sell (buyer -> pair) is taxed 3% (1.5% treasury / 1.5% reward bucket)", async function () {
    await setPairViaLiquidity(bob.address); // bob stands in for the LP pair
    await token.connect(sale).transfer(alice.address, LOA(10_000));
    await token.connect(alice).transfer(bob.address, LOA(10_000));
    expect(await token.balanceOf(bob.address)).to.equal(LOA(9_700));
    expect(await token.balanceOf(treasury.address)).to.equal(LOA(150));
    expect(await token.balanceOf(operatorWallet.address)).to.equal(0); // tax share is treasury's, not operatorWallet'
    expect(await token.rewardTokenBucket()).to.equal(LOA(150));
  });

  it("tax: buy (pair -> buyer) is taxed 3%", async function () {
    await setPairViaLiquidity(bob.address); // bob stands in for the LP pair
    await token.connect(sale).transfer(bob.address, LOA(10_000)); // pair holds LOA
    await token.connect(bob).transfer(alice.address, LOA(10_000));
    expect(await token.balanceOf(alice.address)).to.equal(LOA(9_700));
    expect(await token.balanceOf(treasury.address)).to.equal(LOA(150));
    expect(await token.rewardTokenBucket()).to.equal(LOA(150));
  });

  it("tax: transfer between two non-pair wallets stays untaxed after the pair is set", async function () {
    await setPairViaLiquidity(bob.address);
    await token.connect(sale).transfer(alice.address, LOA(10_000));
    await token.connect(alice).transfer(carol.address, LOA(10_000));
    expect(await token.balanceOf(carol.address)).to.equal(LOA(10_000));
    expect(await token.balanceOf(treasury.address)).to.equal(0);
    expect(await token.rewardTokenBucket()).to.equal(0);
  });

  it("tax: there is no setPair — the pair is set automatically on the first liquidity add", async function () {
    // The ABI exposes no setPair at all (user decision 2026-11-26:
    // the pair is read from the Pancake factory in _addTierLiquidity).
    const names = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    expect(names).to.not.include("setPair");
    expect(await token.pair()).to.equal(ethers.ZeroAddress);

    // The liquidity add sets the pair from the factory and emits PairSet.
    await factory.configure(
      await token.getAddress(),
      await router.WETH(),
      bob.address
    );
    await token.connect(sale).receiveTierSplit(0, 10_000, { value: 0 });
    await expect(token.addTierLiquidity(0))
      .to.emit(token, "PairSet")
      .withArgs(bob.address);
    expect(await token.pair()).to.equal(bob.address);

    // And the tax is live immediately: a transfer touching the pair is taxed.
    await token.connect(sale).transfer(alice.address, LOA(10_000));
    await token.connect(alice).transfer(bob.address, LOA(10_000));
    expect(await token.balanceOf(bob.address)).to.equal(LOA(9_700));
    expect(await token.rewardTokenBucket()).to.equal(LOA(150));
  });

  // ---------------------------------------------------------- brief item 7
  it("pool: depositReward credits the bucket; plain BNB transfers allocate nothing", async function () {
    await token.connect(alice).depositReward({ value: BNB(5) });
    expect(await token.rewardPoolBNB()).to.equal(BNB(5));

    await alice.sendTransaction({
      to: await token.getAddress(),
      value: BNB(1),
    });
    // Plain transfer: accepted but NOT allocated to the pool bucket.
    expect(await token.rewardPoolBNB()).to.equal(BNB(5));
  });

  it("pool: depositRevenue splits 80% pool / 20% operator wallet", async function () {
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    await token.connect(owner).depositRevenue({ value: BNB(10) });
    expect(await token.rewardPoolBNB()).to.equal(BNB(8));
    const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
    expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(2));
    // Treasury gets nothing from the revenue door.
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    expect(treasuryAfter).to.equal(treasuryBefore);

    // A random wallet may not use the revenue door.
    await expect(
      token.connect(alice).depositRevenue({ value: BNB(1) })
    ).to.be.revertedWithCustomError(token, "NotOwnerOrOperator");
  });

  it("pool: there is no owner path that pays BNB out of the contract", async function () {
    // Design assertion (brief item 7): the ABI exposes no withdraw-like
    // function at all. The only BNB outflows are depositRevenue's fixed
    // 20% operatorWallet slice, the tier-split routing, and season buybacks.
    const names = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const n of names) {
      expect(n.toLowerCase()).to.not.include("withdraw");
    }
  });

  // ------------------------------------------------- tier split + LP (item 4, token side)
  it("tier split: receiveTierSplit is Sale-only and routes 55% LP / 10% pool of the tier total", async function () {
    await expect(
      token.connect(alice).receiveTierSplit(0, 10_000, { value: BNB(26) })
    ).to.be.revertedWithCustomError(token, "NotSaleContract");

    // Sale forwards 65% of tier 1's 40 BNB = 26 BNB.
    await token.connect(sale).receiveTierSplit(0, 10_000, { value: BNB(26) });
    expect(await token.tierLPBNB(0)).to.equal(BNB(22));
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    expect(await token.tierSplitReceived(0)).to.equal(true);

    await expect(
      token.connect(sale).receiveTierSplit(0, 10_000, { value: BNB(26) })
    ).to.be.revertedWithCustomError(token, "TierSplitAlreadyReceived");
  });

  it("addTierLiquidity pairs 87.5M LOA with the tier BNB and burns the LP", async function () {
    await token.connect(sale).receiveTierSplit(0, 10_000, { value: BNB(26) });
    await token.connect(alice).addTierLiquidity(0); // anyone may call

    expect(await router.lastLiquidityToken()).to.equal(await token.getAddress());
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(87_500_000));
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await router.lastLiquidityTo()).to.equal(DEAD);
    expect(await pair.balanceOf(DEAD)).to.be.gt(0); // LP minted to burn address
    expect(await token.balanceOf(await token.getAddress())).to.equal(
      LOA(350_000_000 - 87_500_000)
    );
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    // The mock factory is unconfigured here, so getPair returns
    // address(0): the fail-safe leaves the pair unset and the add
    // still succeeds (user decision 2026-11-26).
    expect(await token.pair()).to.equal(ethers.ZeroAddress);

    await expect(token.addTierLiquidity(0)).to.be.revertedWithCustomError(
      token,
      "TierLiquidityAlreadyDone"
    );
    await expect(token.addTierLiquidity(1)).to.be.revertedWithCustomError(
      token,
      "TierSplitNotReceived"
    );
  });

  // ---------------------------------------------------------- brief item 8
  it("season: close locks the fund (season-1 floor: 18 BNB pool -> 9), tranches buy back over 24h, operator root, claim, sweep", async function () {
    const tokenAddr = await token.getAddress();
    // The season operator is a constructor arg now (user decision
    // 2026-11-26) — already set to `operator` in beforeEach.
    expect(await token.seasonOperator()).to.equal(operator.address);
    // Fund the mock router with LOA inventory for the buyback payouts.
    // (The router needs no tax exemption anymore: the funding transfer
    // has the exempt Sale as sender, and the buyback swap pays LOA to
    // this contract, an exempt recipient.)
    await token.connect(sale).transfer(await router.getAddress(), LOA(20_000_000));

    // Pool funding: 10 BNB public deposit + 10 BNB revenue (8 to pool).
    await token.connect(alice).depositReward({ value: BNB(10) });
    await token.connect(owner).depositRevenue({ value: BNB(10) });
    expect(await token.rewardPoolBNB()).to.equal(BNB(18));

    // Seed the tax reward bucket: a taxed SELL of 100,000 LOA -> 1,500 LOA bucket.
    // (Pair-only tax 2026-11-25: a plain wallet-to-wallet transfer would be
    // untaxed, so the pair must be set and the transfer must touch it.
    // The pair is set automatically by the liquidity add — user decision
    // 2026-11-26 — via a zero-value tier split, which leaves the pool
    // numbers below exact.)
    await setPairViaLiquidity(bob.address);
    await token.connect(sale).transfer(alice.address, LOA(100_000));
    await token.connect(alice).transfer(bob.address, LOA(100_000));
    expect(await token.rewardTokenBucket()).to.equal(LOA(1_500));

    // Launch auto-activated at the first liquidity add above (user
    // decision 2026-11-26) — no activateLaunch() call anymore.
    expect(await token.launched()).to.equal(true);
    expect(await token.launchTime()).to.be.gt(0);
    await expect(token.closeSeason(1)).to.be.revertedWithCustomError(
      token,
      "SeasonNotEnded"
    );

    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    let s = await token.seasons(1);
    // Season 1 exception — FINAL floor form (user decision 2026-11-23
    // 23:02-23:04): fund = min(pool, max(4 BNB floor, 50% of pool)).
    // This pool is 18 BNB, so 50% (9) beats the floor.
    expect(s.fundBNB).to.equal(BNB(9)); // 50% of 18 BNB
    expect(await token.rewardPoolBNB()).to.equal(BNB(9)); // other half stays
    expect(s.prizeLOA).to.equal(LOA(1_500)); // tax bucket snapshot
    expect(await token.rewardTokenBucket()).to.equal(0);

    // Tranche 1 runs immediately; tranche 2 too early reverts.
    await token.executeBuybackTranche(1);
    await expect(token.executeBuybackTranche(1)).to.be.revertedWithCustomError(
      token,
      "TrancheTooEarly"
    );
    for (let i = 0; i < 7; i++) {
      await increaseTime(3 * 3600);
      await token.executeBuybackTranche(1);
    }
    s = await token.seasons(1);
    expect(s.tranchesDone).to.equal(8);
    expect(s.fundBNB).to.equal(0);
    // 9 BNB at the mock's fixed 1,000,000 LOA/BNB + 1,500 snapshot.
    expect(s.prizeLOA).to.equal(LOA(9_000_000) + LOA(1_500));
    await expect(token.executeBuybackTranche(1)).to.be.revertedWithCustomError(
      token,
      "BuybackComplete"
    );

    // Claim root: non-operator reverts; operator before close+48h reverts.
    // Indices 8–9 are fresh accounts (indices 0–7 are the named roles
    // above, and bob at index 6 already holds taxed-transfer LOA in
    // this test — winners must start at zero for the exact-balance
    // assertions below).
    const [, , , , , , , , winner1, winner2] = await ethers.getSigners();
    const amt1 = LOA(4_000_000);
    const amt2 = LOA(3_000_000);
    const tree = buildTree([
      claimLeaf(1, winner1.address, amt1),
      claimLeaf(1, winner2.address, amt2),
    ]);
    await expect(
      token.connect(alice).submitClaimRoot(1, tree.root)
    ).to.be.revertedWithCustomError(token, "NotOwnerOrOperator");
    await expect(
      token.connect(operator).submitClaimRoot(1, tree.root)
    ).to.be.revertedWithCustomError(token, "RootTooEarly");

    await increaseTime(48 * 3600 - 21 * 3600 + 60); // now past close + 48h
    await token.connect(operator).submitClaimRoot(1, tree.root);

    // Winner 1 claims the exact amount, untaxed (sender is the contract).
    await token
      .connect(winner1)
      .claim(1, amt1, getProof(tree, 0));
    expect(await token.balanceOf(winner1.address)).to.equal(amt1);
    // Double claim reverts.
    await expect(
      token.connect(winner1).claim(1, amt1, getProof(tree, 0))
    ).to.be.revertedWithCustomError(token, "AlreadyClaimed");
    // Wrong amount reverts.
    await expect(
      token.connect(winner2).claim(1, LOA(1), getProof(tree, 1))
    ).to.be.revertedWithCustomError(token, "InvalidClaimProof");

    // After the 7-day window: late claim reverts, sweep returns the rest.
    await increaseTime(7 * DAY + 1);
    await expect(
      token.connect(winner2).claim(1, amt2, getProof(tree, 1))
    ).to.be.revertedWithCustomError(token, "ClaimWindowClosed");
    await token.sweepUnclaimed(1);
    // Unclaimed = 9,001,500 - 4,000,000 = 5,001,500 LOA back to the bucket.
    expect(await token.rewardTokenBucket()).to.equal(LOA(5_001_500));
    void tokenAddr;
  });

  // --------------------------------- season 1 fund floor (2026-11-23 23:04)
  it("season fund: season 1 close with a pool of exactly 4 BNB locks the full 4 BNB", async function () {
    await token.connect(alice).depositReward({ value: BNB(4) });
    // Launch auto-activates at the first liquidity add (user decision
    // 2026-11-26): a zero-value tier split + add is the trigger here.
    await setPairViaLiquidity(bob.address);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    const s = await token.seasons(1);
    expect(s.fundBNB).to.equal(BNB(4));
    expect(await token.rewardPoolBNB()).to.equal(0);
  });

  it("season fund: season 1 close with a pool below the floor (3 BNB) locks the entire pool", async function () {
    await token.connect(alice).depositReward({ value: BNB(3) });
    // Launch auto-activates at the first liquidity add (user decision
    // 2026-11-26): a zero-value tier split + add is the trigger here.
    await setPairViaLiquidity(bob.address);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    const s = await token.seasons(1);
    expect(s.fundBNB).to.equal(BNB(3)); // whole pool — pool holds less than the 4 BNB floor
    expect(await token.rewardPoolBNB()).to.equal(0);
  });

  it("season fund: season 1 close with a 6 BNB pool locks the 4 BNB floor (not 50% = 3)", async function () {
    await token.connect(alice).depositReward({ value: BNB(6) });
    // Launch auto-activates at the first liquidity add (user decision
    // 2026-11-26): a zero-value tier split + add is the trigger here.
    await setPairViaLiquidity(bob.address);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    const s = await token.seasons(1);
    expect(s.fundBNB).to.equal(BNB(4)); // floor bites: max(4, 50% of 6 = 3) = 4
    expect(await token.rewardPoolBNB()).to.equal(BNB(2)); // remainder stays
  });

  it("season fund: season 1 close with a 10 BNB pool locks 5 (50% beats the floor)", async function () {
    await token.connect(alice).depositReward({ value: BNB(10) });
    // Launch auto-activates at the first liquidity add (user decision
    // 2026-11-26): a zero-value tier split + add is the trigger here.
    await setPairViaLiquidity(bob.address);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    const s = await token.seasons(1);
    expect(s.fundBNB).to.equal(BNB(5)); // max(4 floor, 50% of 10 = 5) = 5
    expect(await token.rewardPoolBNB()).to.equal(BNB(5)); // other half stays
  });

  it("season fund: season 2 close locks 50% of the then-current pool", async function () {
    await token.connect(alice).depositReward({ value: BNB(10) });
    // Launch auto-activates at the first liquidity add (user decision
    // 2026-11-26): a zero-value tier split + add is the trigger here.
    await setPairViaLiquidity(bob.address);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1); // season 1: max(4 floor, 50% of 10) = 5, leaving 5
    expect(await token.rewardPoolBNB()).to.equal(BNB(5));

    await increaseTime(30 * DAY);
    await token.closeSeason(2);
    const s2 = await token.seasons(2);
    expect(s2.fundBNB).to.equal(BNB(2.5)); // 50% of the 5 BNB pool
    expect(await token.rewardPoolBNB()).to.equal(BNB(2.5)); // other half stays
  });

  // --------------------------- owner cut + auto-renounce 2026-11-26
  it("owner powers removed: no wallet/tax/operator setters, no activate/finalize launch in the ABI", async function () {
    // User decision 2026-11-26: the owner keeps NO power in the Token —
    // wallets are immutable constructor args, the tax-exemption set is
    // fixed in code, the season operator is a constructor arg, launch
    // activates automatically, ownership renounces automatically at the
    // first mint (via the Sale). The ABI must not expose any of them.
    const names = token.interface.fragments
      .filter((f) => f.type === "function")
      .map((f) => f.name);
    for (const removed of [
      "setTreasuryWallet",
      "setOperatorWallet",
      "setTaxExempt",
      "setSeasonOperator",
      "activateLaunch",
      "finalizeLaunch",
      "taxExempt",
    ]) {
      expect(names).to.not.include(removed);
    }
    // The constructor args are stored (immutable).
    expect(await token.treasuryWallet()).to.equal(treasury.address);
    expect(await token.operatorWallet()).to.equal(operatorWallet.address);
    expect(await token.seasonOperator()).to.equal(operator.address);
    // And the fixed exemptions still work: a transfer FROM the Sale
    // (an exempt address) is untaxed.
    await token.connect(sale).transfer(alice.address, LOA(50_000));
    expect(await token.balanceOf(alice.address)).to.equal(LOA(50_000));
    expect(await token.rewardTokenBucket()).to.equal(0);
  });

  it("launch auto-activates at the first liquidity add (no owner call)", async function () {
    expect(await token.launched()).to.equal(false);
    expect(await token.launchTime()).to.equal(0);
    await expect(token.closeSeason(1)).to.be.revertedWithCustomError(
      token,
      "NotLaunched"
    );
    await setPairViaLiquidity(bob.address);
    expect(await token.launched()).to.equal(true);
    expect(await token.launchTime()).to.be.gt(0);
    // A second liquidity add does not move the launch time.
    const launchTime = await token.launchTime();
    await increaseTime(60);
    await token.connect(sale).receiveTierSplit(1, 10_000, { value: 0 });
    await token.addTierLiquidity(1);
    expect(await token.launchTime()).to.equal(launchTime);
  });

  it("renounceOwnershipFromSale: only the Sale contract may call it", async function () {
    await expect(
      token.connect(alice).renounceOwnershipFromSale()
    ).to.be.revertedWithCustomError(token, "NotSaleContract");
    await expect(
      token.connect(owner).renounceOwnershipFromSale()
    ).to.be.revertedWithCustomError(token, "NotSaleContract");
    // The EOA standing in for the Sale in these tests CAN call it.
    await token.connect(sale).renounceOwnershipFromSale();
    expect(await token.owner()).to.equal(ethers.ZeroAddress);
    expect(await token.seasonOperator()).to.equal(operator.address);
  });

  // --------------------------------- wallet split 2026-11-25 (Addendum 5)
  it("wallets: constructor stores treasury + operatorWallet (immutable) and the season operator", async function () {
    expect(await token.treasuryWallet()).to.equal(treasury.address);
    expect(await token.operatorWallet()).to.equal(operatorWallet.address);
    expect(await token.seasonOperator()).to.equal(operator.address);
  });
});
