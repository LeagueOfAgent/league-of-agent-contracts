const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  increaseTime,
  latestTimestamp,
  buildTree,
  getProof,
  guaranteeLeaf,
} = require("./helpers");

const LOA = (n) => ethers.parseUnits(n.toString(), 18);
const BNB = (n) => ethers.parseEther(n.toString());
const DEAD = "0x000000000000000000000000000000000000dEaD";
const DAY = 24 * 3600;

describe("LeagueOfAgentSale", function () {
  let token, sale, registry, loginPass, router, factory, pair;
  let owner, treasury, operatorWallet, buyer, whale, alice, bob, carol, dave, erin, frank, operator;
  let TPS; // TOKENS_PER_SLOT

  beforeEach(async function () {
    [owner, treasury, operatorWallet, buyer, whale, alice, bob, carol, dave, erin, frank, operator] =
      await ethers.getSigners();

    const MockRegistry = await ethers.getContractFactory("MockAgentIDRegistry");
    registry = await MockRegistry.deploy();
    const MockPass = await ethers.getContractFactory("MockLoginPass");
    loginPass = await MockPass.deploy();
    const MockRouter = await ethers.getContractFactory("MockPancakeRouter");
    router = await MockRouter.deploy();
    factory = await ethers.getContractAt(
      "MockPancakeFactory",
      await router.factory()
    );
    pair = await ethers.getContractAt("MockPair", await router.pair());

    const Sale = await ethers.getContractFactory("LeagueOfAgentSale");
    sale = await Sale.deploy(
      owner.address,
      treasury.address,
      operatorWallet.address,
      await registry.getAddress(),
      await loginPass.getAddress()
    );
    await sale.waitForDeployment();

    const Token = await ethers.getContractFactory("LeagueOfAgentToken");
    token = await Token.deploy(
      owner.address,
      await sale.getAddress(),
      treasury.address,
      operatorWallet.address,
      await router.getAddress(),
      operator.address
    );
    await token.waitForDeployment();
    await sale.setToken(await token.getAddress());
    // The mock factory returns the mock pair for the real (token, WETH)
    // query, so every liquidity add sets the Token's pair automatically
    // (user decision 2026-11-26) and the pair-only tax goes live.
    await factory.configure(
      await token.getAddress(),
      await router.WETH(),
      await pair.getAddress()
    );

    TPS = await sale.TOKENS_PER_SLOT();
  });

  async function giveAgentID(wallet) {
    await registry.setBalance(wallet.address, 1);
  }

  // Roots/windows must be set BEFORE the start time is fixed (the contract
  // locks them once the sale has started), so each test configures first,
  // then calls this to open the sale and time-travel just past the start.
  async function startSale(duration = 7 * DAY) {
    const now = await latestTimestamp();
    await sale.setSaleTimes(now + 30, now + 30 + duration);
    await increaseTime(31);
  }

  // Fill a paid tier with many distinct Agent-ID wallets, each buying at
  // most the 10-slot base paid limit — the referral purchase cap (user
  // decision 2026-11-24) makes the old single-whale bulk buy impossible.
  // Wallets are funded via hardhat_setBalance (no funding tx needed).
  // Returns one of the filler wallets (holds exactly 10 slots' worth).
  async function fillTier(tier, totalSlots) {
    let remaining = totalSlots;
    let sampleWallet = null;
    while (remaining > 0) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [
        w.address,
        "0xDE0B6B3A7640000", // 1 BNB
      ]);
      await registry.setBalance(w.address, 1);
      const n = Math.min(10, remaining);
      const cost = await sale.quoteCost(tier, n);
      await sale.connect(w).buy(tier, n, ethers.ZeroAddress, { value: cost });
      if (!sampleWallet) sampleWallet = w;
      remaining -= n;
    }
    return sampleWallet;
  }

  // Like fillTier, but every buyer names `referrer` (ZeroAddress = no
  // referral). Used to prove the 5% reward accounting at tier completion.
  async function fillTierAs(tier, totalSlots, referrer) {
    let remaining = totalSlots;
    while (remaining > 0) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      await ethers.provider.send("hardhat_setBalance", [
        w.address,
        "0xDE0B6B3A7640000", // 1 BNB
      ]);
      await registry.setBalance(w.address, 1);
      const n = Math.min(10, remaining);
      const cost = await sale.quoteCost(tier, n);
      await sale.connect(w).buy(tier, n, referrer, { value: cost });
      remaining -= n;
    }
  }

  // ---------------------------------------------------------- brief item 3
  it("paid buy: without Agent ID reverts; with Agent ID succeeds, tokens = slots x TOKENS_PER_SLOT", async function () {
    await startSale();
    // Flat price 0.004/slot in every tier: 2 slots = 0.008 BNB.
    await expect(
      sale.connect(buyer).buy(0, 2, ethers.ZeroAddress, { value: BNB(0.008) })
    ).to.be.revertedWithCustomError(sale, "AgentIDRequired");

    await giveAgentID(buyer);
    await expect(
      sale.connect(buyer).buy(0, 2, ethers.ZeroAddress, { value: BNB(0.005) })
    ).to.be.revertedWithCustomError(sale, "WrongPayment");

    await sale.connect(buyer).buy(0, 2, ethers.ZeroAddress, { value: BNB(0.008) });
    expect(await token.balanceOf(buyer.address)).to.equal(TPS * 2n);
    expect(await sale.tierSold(0)).to.equal(2);

    // Multi-slot buys work across tiers; the buyer's combined total here
    // is 7, under the 10-slot base paid limit (referral cap, 2026-11-24).
    // Tier 4 price is 0.004/slot: 5 slots = 0.02 BNB.
    await sale.connect(buyer).buy(3, 5, ethers.ZeroAddress, { value: BNB(0.02) });
    expect(await token.balanceOf(buyer.address)).to.equal(TPS * 7n);
  });

  // ------------------------------------------- pricing 2026-11-23 22:45
  it("per-tier pricing: ALL tiers flat 0.004; quoteCost = price x slots; exact value enforced", async function () {
    await startSale();
    await giveAgentID(buyer);

    expect(await sale.quoteCost(0, 1)).to.equal(BNB(0.004));
    expect(await sale.quoteCost(0, 10_000)).to.equal(BNB(40));
    expect(await sale.quoteCost(1, 1)).to.equal(BNB(0.004));
    expect(await sale.quoteCost(2, 250)).to.equal(BNB(1));
    expect(await sale.quoteCost(3, 10_000)).to.equal(BNB(40));
    await expect(sale.quoteCost(4, 1)).to.be.revertedWithCustomError(
      sale,
      "TierOutOfRange"
    );

    // Underpay AND overpay both revert — payment must be exact.
    await expect(
      sale.connect(buyer).buy(1, 2, ethers.ZeroAddress, { value: BNB(0.007) })
    ).to.be.revertedWithCustomError(sale, "WrongPayment");
    await expect(
      sale.connect(buyer).buy(1, 2, ethers.ZeroAddress, { value: BNB(0.009) })
    ).to.be.revertedWithCustomError(sale, "WrongPayment");

    await sale.connect(buyer).buy(0, 3, ethers.ZeroAddress, { value: BNB(0.012) });
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    await sale.connect(buyer).buy(1, 2, ethers.ZeroAddress, { value: BNB(0.008) });
    expect(await token.balanceOf(buyer.address)).to.equal(TPS * 5n);
    expect(await sale.tierBNB(0)).to.equal(BNB(0.012));
    // Tier 2-4 split PER PURCHASE (user decision 2026-11-26): nothing
    // stays in the tier — 65% of the 0.008 BNB buy went to the Token
    // (LP 0.0044 + pool 0.0008), 10% to operatorWallet, 25% to the treasury.
    expect(await sale.tierBNB(1)).to.equal(0);
    expect(await token.tierLPBNB(1)).to.equal(BNB(0.0044));
    expect(await token.rewardPoolBNB()).to.equal(BNB(0.0008));
    expect(await ethers.provider.getBalance(treasury.address) - treasuryBefore).to.equal(BNB(0.002));
    expect(await ethers.provider.getBalance(operatorWallet.address) - operatorWalletBefore).to.equal(BNB(0.0008));
  });

  // ---------------------------------------------------------- brief item 4
  it("tier completion: Tier 1 accumulates 40 BNB and splits 22 LP / 4 pool / 10 treasury / 4 operatorWallet", async function () {
    this.timeout(300_000);
    await startSale();
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);

    // Fill the whole Tier 1 (10,000 slots x 0.004 = 40 BNB) with 1,000
    // distinct Agent-ID wallets buying 10 slots each — the referral
    // purchase cap (2026-11-24) limits a single wallet to 10 slots
    // without referrals, so no whale bulk buy is possible anymore.
    const sample = await fillTier(0, 10_000);

    expect(await sale.tierCompleted(0)).to.equal(true);
    expect(await sale.tierSold(0)).to.equal(10_000);
    expect(await token.balanceOf(sample.address)).to.equal(TPS * 10n);
    // 10% -> reward pool. The 55% LP slice was AUTO-ADDED to PancakeSwap
    // in the completing buy (user decision 2026-11-26): tierLPBNB(0)
    // is 0, the router paired 87.5M LOA with 22 BNB, LP tokens went to
    // the burn address, and no manual call is needed (or possible).
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(87_500_000));
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await router.lastLiquidityTo()).to.equal(DEAD);
    expect(await pair.balanceOf(DEAD)).to.equal(BNB(22)); // mock LP: liquidity = msg.value
    await expect(token.addTierLiquidity(0)).to.be.revertedWithCustomError(
      token,
      "TierLiquidityAlreadyDone"
    );
    // 25% marketing -> treasury wallet, 10% operatorWallet -> operator wallet.
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(10));
    expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(4));

    // The completed tier is closed for further buys.
    await giveAgentID(buyer);
    await expect(
      sale.connect(buyer).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) })
    ).to.be.revertedWithCustomError(sale, "TierSoldOut");

    // Launch auto-activated at the sellout LP add (user decision
    // 2026-11-26) — no owner call. Season 1 closes 30 days later.
    expect(await token.launched()).to.equal(true);
    expect(await token.launchTime()).to.be.gt(0);
    await increaseTime(30 * DAY + 1);
    await token.closeSeason(1);
    const s = await token.seasons(1);
    // Pool is exactly the 4 BNB seed: season-1 fund = max(4 floor,
    // 50% of 4) = 4 BNB.
    expect(s.fundBNB).to.equal(BNB(4));
    expect(await token.rewardPoolBNB()).to.equal(0);
  });

  it("tier completion: a 0.004 tier accumulates 40 BNB and splits 22 LP / 4 pool / 10 treasury / 4 operatorWallet", async function () {
    this.timeout(300_000);
    await startSale();
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);

    // Fill the whole Tier 2 (10,000 slots x 0.004 = 40 BNB) with 1,000
    // distinct Agent-ID wallets buying 10 slots each (referral cap).
    const sample = await fillTier(1, 10_000);

    expect(await sale.tierCompleted(1)).to.equal(true);
    expect(await sale.tierSold(1)).to.equal(10_000);
    expect(await token.balanceOf(sample.address)).to.equal(TPS * 10n);
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    expect(await token.tierLPBNB(1)).to.equal(BNB(22));
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(10));
    expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(4));
  });

  // --------------------------------- wallet split 2026-11-25 (Addendum 5)
  it("wallets: constructor stores treasury + operator wallets (immutable)", async function () {
    expect(await sale.treasuryWallet()).to.equal(treasury.address);
    expect(await sale.operatorWallet()).to.equal(operatorWallet.address);
    expect(await token.treasuryWallet()).to.equal(treasury.address);
    expect(await token.operatorWallet()).to.equal(operatorWallet.address);
  });

  // ------------------------------------- referral mechanism 2026-11-24
  it("referral: base cap is 10 slots across ALL tiers combined; the 11th slot reverts", async function () {
    await startSale();
    await giveAgentID(buyer);

    expect(await sale.PAID_BASE_LIMIT()).to.equal(10);
    expect(await sale.paidLimitOf(buyer.address)).to.equal(10);

    // A single buy of 11 slots reverts even though the tier has room.
    await expect(
      sale.connect(buyer).buy(0, 11, ethers.ZeroAddress, { value: BNB(0.044) })
    )
      .to.be.revertedWithCustomError(sale, "PaidLimitExceeded")
      .withArgs(buyer.address, 10);

    // 6 in tier 0 + 4 in tier 1 = 10 total: the cap is combined across
    // tiers, not per tier.
    await sale.connect(buyer).buy(0, 6, ethers.ZeroAddress, { value: BNB(0.024) });
    await sale.connect(buyer).buy(1, 4, ethers.ZeroAddress, { value: BNB(0.016) });
    expect(await sale.paidSlotsBought(buyer.address)).to.equal(10);

    // The 11th slot — in any tier — reverts.
    await expect(
      sale.connect(buyer).buy(2, 1, ethers.ZeroAddress, { value: BNB(0.004) })
    )
      .to.be.revertedWithCustomError(sale, "PaidLimitExceeded")
      .withArgs(buyer.address, 10);
  });

  it("referral: a first buy naming a referrer records it once and PAYS 5% BNB immediately", async function () {
    await startSale();
    await giveAgentID(alice);
    await giveAgentID(bob);
    await giveAgentID(carol);

    const aliceBefore = await ethers.provider.getBalance(alice.address);

    // Bob's first paid buy names Alice -> Alice is recorded AND paid
    // 5% of the 0.004 BNB cost (0.0002 BNB) in this same transaction
    // (user decision 2026-11-25, immediate payment FINAL 23:21).
    await expect(
      sale.connect(bob).buy(0, 1, alice.address, { value: BNB(0.004) })
    )
      .to.emit(sale, "ReferralRecorded")
      .withArgs(alice.address, bob.address)
      .to.emit(sale, "ReferralRewardPaid")
      .withArgs(alice.address, bob.address, 0, BNB(0.0002));
    expect(await sale.referrerOf(bob.address)).to.equal(alice.address);
    expect(await sale.referralCount(alice.address)).to.equal(1);
    // The quota bonus is GONE (2026-11-25): Alice's limit stays 10.
    expect(await sale.paidLimitOf(alice.address)).to.equal(10);
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.0002));
    expect(await sale.tierReferrerPaid(0)).to.equal(BNB(0.0002));
    // Paid immediately: Alice's balance grew by the reward and only
    // the net 0.0038 BNB stays in the tier.
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(0.0002));
    expect(await sale.tierBNB(0)).to.equal(BNB(0.0038));

    // Alice can buy only her fixed 10 slots — and no more.
    await sale.connect(alice).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    expect(await sale.paidSlotsBought(alice.address)).to.equal(10);
    await expect(
      sale.connect(alice).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) })
    )
      .to.be.revertedWithCustomError(sale, "PaidLimitExceeded")
      .withArgs(alice.address, 10);

    // Record-once: Bob's second buy names Carol — nobody new is credited
    // and Bob's recorded referrer stays Alice; Alice is PAID another 5%
    // of the second purchase (0.0004 BNB) in that same transaction.
    const aliceBefore2 = await ethers.provider.getBalance(alice.address);
    await expect(
      sale.connect(bob).buy(0, 2, carol.address, { value: BNB(0.008) })
    )
      .to.emit(sale, "ReferralRewardPaid")
      .withArgs(alice.address, bob.address, 0, BNB(0.0004));
    expect(await sale.referrerOf(bob.address)).to.equal(alice.address);
    expect(await sale.referralCount(alice.address)).to.equal(1);
    expect(await sale.referralCount(carol.address)).to.equal(0);
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.0006));
    expect(await sale.tierReferrerPaid(0)).to.equal(BNB(0.0006));
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore2).to.equal(BNB(0.0004));
  });

  it("referral: self-referral and zero referrer are ignored, buys still succeed", async function () {
    await startSale();
    await giveAgentID(buyer);
    await giveAgentID(alice);

    // Self-referral: the buy succeeds, nothing is recorded, no reward.
    await sale.connect(buyer).buy(0, 2, buyer.address, { value: BNB(0.008) });
    expect(await sale.referrerOf(buyer.address)).to.equal(ethers.ZeroAddress);
    expect(await sale.referralCount(buyer.address)).to.equal(0);
    expect(await sale.referralRewardsEarned(buyer.address)).to.equal(0);
    expect(await sale.paidSlotsBought(buyer.address)).to.equal(2);

    // Zero referrer: the buy succeeds, nothing is recorded, no reward.
    await sale.connect(alice).buy(0, 2, ethers.ZeroAddress, { value: BNB(0.008) });
    expect(await sale.referrerOf(alice.address)).to.equal(ethers.ZeroAddress);
    expect(await sale.referralCount(alice.address)).to.equal(0);
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(0);
    expect(await sale.paidLimitOf(alice.address)).to.equal(10);
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
  });

  it("referral: 3 direct invitees do NOT raise the limit — it stays a fixed 10", async function () {
    await startSale();
    for (const w of [alice, bob, carol, dave]) await giveAgentID(w);

    const aliceBefore = await ethers.provider.getBalance(alice.address);

    // Bob, Carol and Dave each make their first paid buy naming Alice.
    for (const w of [bob, carol, dave]) {
      await sale.connect(w).buy(0, 1, alice.address, { value: BNB(0.004) });
    }
    expect(await sale.referralCount(alice.address)).to.equal(3);
    // Quota bonus removed 2026-11-25: the limit stays 10.
    expect(await sale.paidLimitOf(alice.address)).to.equal(10);
    // Alice was PAID 5% of each 1-slot buy immediately: 3 x 0.0002 BNB.
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.0006));
    expect(await sale.tierReferrerPaid(0)).to.equal(BNB(0.0006));
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(0.0006));

    // Alice can buy only 10 slots; the 11th reverts at limit 10.
    await sale.connect(alice).buy(1, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    expect(await sale.paidSlotsBought(alice.address)).to.equal(10);
    await expect(
      sale.connect(alice).buy(1, 1, ethers.ZeroAddress, { value: BNB(0.004) })
    )
      .to.be.revertedWithCustomError(sale, "PaidLimitExceeded")
      .withArgs(alice.address, 10);
  });

  it("referral: whitelist claims stay outside the system — no limit consumed, first paid buy still records referrer", async function () {
    const guaranteeTree = buildTree([guaranteeLeaf(dave.address, 5)]);
    await sale.setGuaranteeRoot(guaranteeTree.root);
    await startSale();

    // Dave claims 1 Guarantee slot (no Agent ID / NFT needed for Guarantee;
    // GUARANTEE_MAX_PER_WALLET = 1 since user decision 2026-11-25).
    await sale.connect(dave).claimGuarantee(1, 5, getProof(guaranteeTree, 0));
    // Erin claims her FCFS slot (NFT + Agent ID set for the claim;
    // no Merkle proof, no registration — user decision 2026-11-25).
    await loginPass.setHasLoginPass(erin.address, true);
    await giveAgentID(erin);
    await sale.connect(erin).claimFCFS();

    // Neither claim touched the paid / referral state.
    for (const w of [dave, erin]) {
      expect(await sale.paidSlotsBought(w.address)).to.equal(0);
      expect(await sale.referrerOf(w.address)).to.equal(ethers.ZeroAddress);
      expect(await sale.paidLimitOf(w.address)).to.equal(10);
    }
    expect(await sale.referralCount(bob.address)).to.equal(0);

    // Their first PAID buys still record the referrer and start from the
    // full base limit — the whitelist mints did not count as a first
    // paid purchase and did not consume any paid limit.
    await giveAgentID(dave);
    await expect(
      sale.connect(dave).buy(0, 10, bob.address, { value: BNB(0.04) })
    )
      .to.emit(sale, "ReferralRecorded")
      .withArgs(bob.address, dave.address);
    await sale.connect(erin).buy(0, 10, bob.address, { value: BNB(0.04) });
    expect(await sale.referrerOf(dave.address)).to.equal(bob.address);
    expect(await sale.referrerOf(erin.address)).to.equal(bob.address);
    expect(await sale.referralCount(bob.address)).to.equal(2);
    // Bob earned 5% of each 10-slot first buy: 2 x 0.002 BNB.
    expect(await sale.referralRewardsEarned(bob.address)).to.equal(BNB(0.004));
    expect(await sale.paidSlotsBought(dave.address)).to.equal(10);
    expect(await sale.paidSlotsBought(erin.address)).to.equal(10);
  });

  it("referral leaderboard: referrers list appends once per referrer; getReferrers pages with counts", async function () {
    await startSale();
    expect(await sale.totalReferrers()).to.equal(0);
    let page = await sale.getReferrers(0, 10);
    expect(page.total).to.equal(0);
    expect(page.wallets.length).to.equal(0);
    expect(page.rewards.length).to.equal(0);

    // Bob and Carol make their first paid buys naming Alice; Dave names Bob.
    for (const w of [bob, carol, dave]) await giveAgentID(w);
    await sale.connect(bob).buy(0, 1, alice.address, { value: BNB(0.004) });
    await sale.connect(carol).buy(0, 1, alice.address, { value: BNB(0.004) });
    await sale.connect(dave).buy(0, 1, bob.address, { value: BNB(0.004) });

    // Alice is listed once despite two credits; order = first credit.
    expect(await sale.totalReferrers()).to.equal(2);
    expect(await sale.referrers(0)).to.equal(alice.address);
    expect(await sale.referrers(1)).to.equal(bob.address);

    page = await sale.getReferrers(0, 10);
    expect(page.total).to.equal(2);
    expect(page.wallets).to.deep.equal([alice.address, bob.address]);
    expect(page.counts.map(Number)).to.deep.equal([2, 1]);
    // Rewards: Alice 2 x 0.0002, Bob 1 x 0.0002 BNB.
    expect(page.rewards.map((r) => r.toString())).to.deep.equal([
      BNB(0.0004).toString(),
      BNB(0.0002).toString(),
    ]);

    // Pagination: second page of size 1; offset past the end is empty.
    page = await sale.getReferrers(1, 1);
    expect(page.total).to.equal(2);
    expect(page.wallets).to.deep.equal([bob.address]);
    expect(page.counts.map(Number)).to.deep.equal([1]);
    expect(page.rewards.map((r) => r.toString())).to.deep.equal([BNB(0.0002).toString()]);
    page = await sale.getReferrers(5, 10);
    expect(page.total).to.equal(2);
    expect(page.wallets.length).to.equal(0);
    expect(page.counts.length).to.equal(0);
    expect(page.rewards.length).to.equal(0);
  });

  it("referral reward: fully-referred tier completes 26/4/8; referrers already paid 2 BNB during the buys", async function () {
    this.timeout(300_000); // fills a full 10,000-slot tier via 1,000 wallets
    await startSale();
    const saleAddr = await sale.getAddress();
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    const aliceBefore = await ethers.provider.getBalance(alice.address);

    // Every one of the 1,000 filler wallets names Alice: 10,000 slots,
    // 40 BNB gross, 5% = 2 BNB paid to Alice during the buys.
    await fillTierAs(0, 10_000, alice.address);

    expect(await sale.tierCompleted(0)).to.equal(true);
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
    expect(await sale.tierBNB(0)).to.equal(0);
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(2));
    // Alice was already paid the 2 BNB during the buys — nothing is
    // left sitting in the contract for referrers.
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(2));
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(0);
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    // Tier 1 auto-added its LP in the completing buy (2026-11-26):
    // the 22 BNB left the LP bucket for the router.
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(87_500_000));
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(8));
    expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(4));
  });

  it("referral reward: mixed tier — Treasury is 25% of gross minus rewards already paid", async function () {
    this.timeout(300_000); // fills a full 10,000-slot tier via 1,000 wallets
    await startSale();
    const saleAddr = await sale.getAddress();
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    const aliceBefore = await ethers.provider.getBalance(alice.address);

    // Half the tier referred (5,000 slots -> 20 BNB -> 1 BNB paid to
    // Alice during the buys), half not referred.
    await fillTierAs(0, 5_000, alice.address);
    await fillTierAs(0, 5_000, ethers.ZeroAddress);

    expect(await sale.tierCompleted(0)).to.equal(true);
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(1));
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(1));
    // LP 55% and pool 10% of the 40 BNB gross; operatorWallet 10% of gross.
    // Tier 1 auto-added its LP in the completing buy (2026-11-26).
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    // Treasury = 25% of gross (10) minus rewards already paid (1) = 9;
    // nothing is left sitting in the contract.
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(9));
    expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(4));
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(0);
  });

  it("referral reward: a referrer paid in two tiers — per-tier paid totals tracked separately", async function () {
    this.timeout(300_000); // fills two tiers via ~2,000 wallets
    await startSale();
    await giveAgentID(bob);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);

    // Bob buys 5 slots in tier 0 and 5 in tier 1 (his fixed 10-slot
    // cap), both naming Alice: Alice is paid 0.001 BNB in each buy.
    const aliceBefore = await ethers.provider.getBalance(alice.address);
    await sale.connect(bob).buy(0, 5, alice.address, { value: BNB(0.02) });
    await sale.connect(bob).buy(1, 5, alice.address, { value: BNB(0.02) });
    expect(await sale.tierReferrerPaid(0)).to.equal(BNB(0.001));
    expect(await sale.tierReferrerPaid(1)).to.equal(BNB(0.001));
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.002));
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(0.002));

    // Complete tier 0 only; tier 1 stays open.
    await fillTierAs(0, 9_995, ethers.ZeroAddress);
    expect(await sale.tierCompleted(0)).to.equal(true);
    expect(await sale.tierCompleted(1)).to.equal(false);

    // Tier 0's paid total is zeroed at completion; tier 1's still stands.
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
    expect(await sale.tierReferrerPaid(1)).to.equal(BNB(0.001));
    // Tier 0 gross is 40 BNB: LP 22 (auto-added in the completing buy),
    // pool 4, Treasury = 25% of gross (10) minus the 0.001 already paid
    // to Alice = 9.999. Tier 1's per-purchase routing already moved its
    // own 0.004 to the treasury (20% of Bob's 0.02 buy), 0.002 to the
    // pool and 0.011 to its LP bucket — so the totals are 10.003
    // treasury and a 4.002 pool.
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await token.tierLPBNB(1)).to.equal(BNB(0.011));
    expect(await token.rewardPoolBNB()).to.equal(BNB(4.002));
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(10.003));
  });

  it("referral reward: a referrer that cannot receive BNB never bricks the buy — the 5% stays in the tier", async function () {
    this.timeout(300_000); // fills 9,999 tier-1 slots via ~1,000 wallets
    await startSale();
    const MockReceiver = await ethers.getContractFactory("MockRevertingReceiver");
    const receiver = await MockReceiver.deploy();
    const receiverAddr = await receiver.getAddress();
    await giveAgentID(buyer);

    // The buy succeeds even though the referrer cannot receive BNB:
    // ReferralRewardFailed is emitted and the 5% stays in the tier.
    await expect(
      sale.connect(buyer).buy(0, 1, receiverAddr, { value: BNB(0.004) })
    )
      .to.emit(sale, "ReferralRewardFailed")
      .withArgs(receiverAddr, buyer.address, 0, BNB(0.0002));
    expect(await sale.referrerOf(buyer.address)).to.equal(receiverAddr);
    expect(await sale.referralCount(receiverAddr)).to.equal(1);
    expect(await token.balanceOf(buyer.address)).to.equal(TPS);
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
    expect(await sale.referralRewardsEarned(receiverAddr)).to.equal(0);
    expect(await sale.tierBNB(0)).to.equal(BNB(0.004));

    // Fill the rest of the tier naming the same mock referrer: every
    // reward attempt fails, so the full 40 BNB gross stays in the tier
    // and the treasury gets the whole 25% at completion.
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    await fillTierAs(0, 9_999, receiverAddr);
    expect(await sale.tierCompleted(0)).to.equal(true);
    expect(await sale.tierReferrerPaid(0)).to.equal(0);
    // Tier 1 auto-added its LP in the completing buy (2026-11-26).
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));
    const treasuryAfter = await ethers.provider.getBalance(treasury.address);
    expect(treasuryAfter - treasuryBefore).to.equal(BNB(10));
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
  });

    // FCFS: needs NFT + Agent ID ONLY — no Merkle proof, no
    // pre-registration (user decision 2026-11-25). Any wallet with
    // both on-chain conditions may claim, first-come-first-served.
  it("FCFS: needs NFT + Agent ID only, no proof, no list; double claim reverts", async function () {
    await startSale();

    // Missing NFT reverts, then missing Agent ID reverts, then success.
    await giveAgentID(alice);
    await expect(
      sale.connect(alice).claimFCFS()
    ).to.be.revertedWithCustomError(sale, "LoginPassRequired");
    await loginPass.setHasLoginPass(alice.address, true);
    await registry.setBalance(alice.address, 0);
    await expect(
      sale.connect(alice).claimFCFS()
    ).to.be.revertedWithCustomError(sale, "AgentIDRequired");
    await giveAgentID(alice);
    await sale.connect(alice).claimFCFS();
    expect(await token.balanceOf(alice.address)).to.equal(TPS);

    // Second claim by the same wallet reverts.
    await expect(
      sale.connect(alice).claimFCFS()
    ).to.be.revertedWithCustomError(sale, "FcfsAlreadyClaimed");

    // A wallet with NFT + Agent ID but on NO list at all can claim —
    // there is no FCFS list anymore.
    await loginPass.setHasLoginPass(bob.address, true);
    await giveAgentID(bob);
    await sale.connect(bob).claimFCFS();
    expect(await token.balanceOf(bob.address)).to.equal(TPS);
    expect(await sale.fcfsClaimedCount()).to.equal(2);
  });

  // ---------------------------------------------------------- brief item 6
  it("Guarantee: (wallet, maxSlots) leaves cap claims; no NFT / Agent ID needed; wrong proof reverts", async function () {
    const guaranteeTree = buildTree([
      guaranteeLeaf(dave.address, 5),
      guaranteeLeaf(erin.address, 2),
      guaranteeLeaf(frank.address, 7),
    ]);
    await sale.setGuaranteeRoot(guaranteeTree.root);
    await startSale();

    // Dave and Erin hold neither a Login Pass nor an Agent ID (mocks default
    // to false/0) — Guarantee claims must still work.
    // Dave's leaf says maxSlots 5, but GUARANTEE_MAX_PER_WALLET = 1 (user
    // decision 2026-11-25) — effective cap = min(5, 1) = 1: a single
    // claim of 2 reverts, 1 claims fine, and any further claim reverts.
    await expect(
      sale.connect(dave).claimGuarantee(2, 5, getProof(guaranteeTree, 0))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");
    await sale.connect(dave).claimGuarantee(1, 5, getProof(guaranteeTree, 0));
    expect(await token.balanceOf(dave.address)).to.equal(TPS * 1n);

    // Beyond the leaf cap reverts (already claimed the 1 slot).
    await expect(
      sale.connect(dave).claimGuarantee(1, 5, getProof(guaranteeTree, 0))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");

    // A cap that is not the one in the leaf fails the proof.
    await expect(
      sale.connect(dave).claimGuarantee(1, 4, getProof(guaranteeTree, 0))
    ).to.be.revertedWithCustomError(sale, "InvalidMerkleProof");

    // Erin's own cap works independently (leaf maxSlots 2, effective 1).
    await expect(
      sale.connect(erin).claimGuarantee(2, 2, getProof(guaranteeTree, 1))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");
    await sale.connect(erin).claimGuarantee(1, 2, getProof(guaranteeTree, 1));
    expect(await token.balanceOf(erin.address)).to.equal(TPS * 1n);
    await expect(
      sale.connect(erin).claimGuarantee(1, 2, getProof(guaranteeTree, 1))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");

    // Hard contract cap: Frank's leaf says maxSlots 7, but
    // GUARANTEE_MAX_PER_WALLET = 1 wins — a single claim of 2 reverts, 1 claims
    // fine, and any further claim reverts (effective cap = min(7, 1) = 1).
    await expect(
      sale.connect(frank).claimGuarantee(2, 7, getProof(guaranteeTree, 2))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");
    await sale.connect(frank).claimGuarantee(1, 7, getProof(guaranteeTree, 2));
    expect(await token.balanceOf(frank.address)).to.equal(TPS * 1n);
    await expect(
      sale.connect(frank).claimGuarantee(1, 7, getProof(guaranteeTree, 2))
    ).to.be.revertedWithCustomError(sale, "GuaranteeCapExceeded");
  });

  // --------------------------------------- Guarantee cap 1, 2026-11-25
  it("Guarantee: 300 distinct wallets can each claim 1 slot; the 301st claim reverts GuaranteeSoldOut", async function () {
    this.timeout(300_000);
    const N = 301;
    const wallets = [];
    for (let i = 0; i < N; i++) {
      wallets.push(ethers.Wallet.createRandom().connect(ethers.provider));
    }
    const guaranteeTree = buildTree(wallets.map((w) => guaranteeLeaf(w.address, 5)));
    await sale.setGuaranteeRoot(guaranteeTree.root);
    await startSale();

    for (let i = 0; i < N; i++) {
      await owner.sendTransaction({ to: wallets[i].address, value: BNB(0.01) });
    }
    for (let i = 0; i < 300; i++) {
      await sale
        .connect(wallets[i])
        .claimGuarantee(1, 5, getProof(guaranteeTree, i));
    }
    expect(await sale.guaranteeClaimedCount()).to.equal(300);
    expect(await token.balanceOf(wallets[0].address)).to.equal(TPS);

    await expect(
      sale.connect(wallets[300]).claimGuarantee(1, 5, getProof(guaranteeTree, 300))
    ).to.be.revertedWithCustomError(sale, "GuaranteeSoldOut");
  });

  // --------------------------------------- whitelist compression 2026-11-23
  it("FCFS: pool exhausts at exactly 200 claims; the 201st claim reverts FcfsSoldOut", async function () {
    this.timeout(300_000);
    const N = 201;
    const wallets = [];
    for (let i = 0; i < N; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      wallets.push(w);
    }
    // No Merkle list for FCFS anymore (user decision 2026-11-25):
    // every wallet just needs NFT + Agent ID, claimed on-chain.
    await startSale(30 * DAY);

    for (const w of wallets) {
      await owner.sendTransaction({ to: w.address, value: BNB(0.01) });
      await registry.setBalance(w.address, 1);
      await loginPass.setHasLoginPass(w.address, true);
    }

    for (let i = 0; i < 200; i++) {
      await sale.connect(wallets[i]).claimFCFS();
    }
    expect(await sale.fcfsClaimedCount()).to.equal(200);
    expect(await token.balanceOf(wallets[0].address)).to.equal(TPS);

    await expect(
      sale.connect(wallets[200]).claimFCFS()
    ).to.be.revertedWithCustomError(sale, "FcfsSoldOut");
  });

  // ---------------------------------------------------------- brief item 9
  it("auto-burn: the first post-end touch (a refund claim) burns the Sale's leftover LOA + unpaired LP reserve", async function () {
    await startSale(100); // short sale: ends 100s after it opens
    await giveAgentID(buyer);
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });

    const saleBefore = await token.balanceOf(await sale.getAddress());
    // Everything except the 10 sold slots is still sitting in the Sale.
    expect(saleBefore).to.equal(LOA(650_000_000) - TPS * 10n);
    const deadBefore = await token.balanceOf(DEAD);

    await increaseTime(101); // sale ended — refunds open, lazy burn armed
    await token.connect(buyer).approve(await sale.getAddress(), TPS * 10n);
    // The refund itself burns the returned 10 slots' tokens straight
    // to DEAD, and the lazy burn fires in the same transaction: the
    // Sale's leftover LOA (unminted slots + dust) also goes to DEAD.
    await sale.connect(buyer).claimRefund(0);
    expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
    expect(await sale.leftoverBurned()).to.equal(true);
    // DEAD also receives the LP reserve that can never be paired,
    // burned by the lazy burn (user decision 2026-11-26): ALL FOUR
    // tiers' reserves (350M). Tier 0 sold 10 slots, but its revenue
    // never reached the Token — tier 1's escrow only splits at
    // sellout / early open, both impossible after the sale ends — so
    // from the Token's view tier 0 never received revenue and its
    // 87.5M reserve is unpaired, exactly like tiers 1-3, which never
    // got revenue at all. Plus the 10 refunded slots' tokens, burned
    // in the refund itself.
    expect(await token.balanceOf(DEAD)).to.equal(
      deadBefore + saleBefore + TPS * 10n + LOA(350_000_000)
    );
    // Every tier's reserve burned: the Token holds no LOA anymore.
    expect(await token.balanceOf(await token.getAddress())).to.equal(0);
  });

  // --------------------------------------- tier-1 auto-add 2026-11-26
  it("tier 1 auto-add: the sellout buy adds LP in the same tx; no manual call needed", async function () {
    this.timeout(300_000);
    await startSale();
    await fillTier(0, 9_990);
    expect(await token.tierLiquidityDone(0)).to.equal(false);

    // The final 10 slots complete the tier — TierLiquidityAdded fires
    // in THIS buy transaction, straight from the Sale.
    await giveAgentID(buyer);
    await expect(
      sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) })
    )
      .to.emit(token, "TierLiquidityAdded")
      .withArgs(0, LOA(87_500_000), BNB(22))
      .to.emit(sale, "TierCompleted")
      .withArgs(0, BNB(40));
    expect(await token.tierLiquidityDone(0)).to.equal(true);
    expect(await token.tierLPBNB(0)).to.equal(0);
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(87_500_000));
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(22));
    expect(await router.lastLiquidityTo()).to.equal(DEAD);
    expect(await pair.balanceOf(DEAD)).to.equal(BNB(22)); // mock LP: liquidity = msg.value
    await expect(token.addTierLiquidity(0)).to.be.revertedWithCustomError(
      token,
      "TierLiquidityAlreadyDone"
    );
  });

  it("addTierLiquidityFromSale reverts for non-Sale callers", async function () {
    await expect(token.connect(alice).addTierLiquidityFromSale(0)).to.be.revertedWithCustomError(
      token,
      "NotSaleContract"
    );
  });

  // --------------------------------------- tier-1 refund 2026-11-26
  it("refund: tier-1 buyer gets exactly 90% back after sale end by returning all tokens", async function () {
    await startSale(100);
    await giveAgentID(buyer);
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    expect(await token.balanceOf(buyer.address)).to.equal(TPS * 10n);
    expect(await sale.tier1RefundLiability()).to.equal(BNB(0.036));

    // Before the sale ends, refunds are closed.
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "SaleNotEnded"
    );

    await increaseTime(101); // past sale end — refunds open IMMEDIATELY
    // Without approval the token pull reverts.
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientAllowance"
    );
    const saleAddr = await sale.getAddress();
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(BNB(0.04));
    await token.connect(buyer).approve(saleAddr, TPS * 10n);
    await expect(sale.connect(buyer).claimRefund(0))
      .to.emit(sale, "RefundClaimed")
      .withArgs(buyer.address, 0, BNB(0.036), TPS * 10n);
    // 90% of the 0.04 BNB paid; the retained 10% stays in the Sale.
    expect(await token.balanceOf(buyer.address)).to.equal(0);
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(BNB(0.004));
    expect(await sale.tierRefunded(0, buyer.address)).to.equal(true);
    expect(await sale.tier1RefundLiability()).to.equal(0);

    // Double-claim reverts.
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "AlreadyRefunded"
    );
  });

  it("refund: claims revert for other tiers, after a tier-1 sellout, and after the window", async function () {
    this.timeout(300_000);
    await startSale(30 * DAY);
    await giveAgentID(buyer);
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });

    // Other tiers never have refunds.
    await expect(sale.connect(buyer).claimRefund(1)).to.be.revertedWithCustomError(
      sale,
      "RefundTierNotSupported"
    );

    // Sell tier 1 out, then end the sale: no refunds for a sold-out tier.
    await fillTier(0, 9_990);
    await increaseTime(30 * DAY + 1);
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "RefundNotAvailable"
    );

    // And the window itself: a fresh unsold-tier buyer claiming late.
    // (Covered in the window test below; here the sellout case is enough.)
  });

  it("refund: claims close 7 days after sale end", async function () {
    await startSale(100);
    await giveAgentID(buyer);
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    await token.connect(buyer).approve(await sale.getAddress(), TPS * 10n);

    await increaseTime(101 + 7 * DAY + 1); // past end + 7 days
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "RefundWindowClosed"
    );
  });

  it("refund: claim reverts if the buyer spent the tokens or approved too little", async function () {
    await startSale(100);
    await giveAgentID(buyer);
    await giveAgentID(alice);
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    await increaseTime(101);

    // Approved too little: the pull reverts.
    await token.connect(buyer).approve(await sale.getAddress(), TPS * 5n);
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientAllowance"
    );

    // Spent the tokens: approved enough, balance too low.
    await token.connect(buyer).approve(await sale.getAddress(), TPS * 10n);
    await token.connect(buyer).transfer(alice.address, TPS * 10n);
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      token,
      "ERC20InsufficientBalance"
    );
  });

  it("refund: fully-referred tier 1 stays solvent — every buyer can claim their 90%", async function () {
    this.timeout(300_000);
    await startSale(30 * DAY);
    // 100 wallets x 10 slots = 1,000 slots (4 BNB gross), every buy
    // naming Alice: 5% (0.2 BNB) is paid to Alice during the buys,
    // so the Sale holds 3.8 BNB against 3.6 BNB of 90% refunds.
    const wallets = [];
    for (let i = 0; i < 100; i++) {
      const w = ethers.Wallet.createRandom().connect(ethers.provider);
      wallets.push(w);
      await ethers.provider.send("hardhat_setBalance", [
        w.address,
        "0xDE0B6B3A7640000", // 1 BNB
      ]);
      await registry.setBalance(w.address, 1);
    }
    for (const w of wallets) {
      const cost = await sale.quoteCost(0, 10);
      await sale.connect(w).buy(0, 10, alice.address, { value: cost });
    }
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.2));
    const saleAddr = await sale.getAddress();
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(BNB(3.8));
    expect(await sale.tier1RefundLiability()).to.equal(BNB(3.6));

    await increaseTime(30 * DAY + 1); // sale ended — refunds open
    for (const w of wallets) {
      await token.connect(w).approve(saleAddr, TPS * 10n);
      await sale.connect(w).claimRefund(0);
    }
    // Every refund paid; the Sale keeps exactly the retained 10%
    // (0.4 BNB) minus the 0.2 BNB already paid to the referrer.
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(BNB(0.2));
    expect(await sale.tier1RefundLiability()).to.equal(0);
    // Alice kept her full 5% — referrer rewards are never clawed back.
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(0.2));
  });

  it("refund: buyer with no tier-1 purchase has nothing to refund", async function () {
    await startSale(100);
    await giveAgentID(buyer);
    await increaseTime(101);
    await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "NoPurchaseToRefund"
    );
  });

  // --------------------------------- partial tiers 2026-11-26
  it("partial tier: tier 2 at 5,000/10,000 splits per purchase (13 Token / 2 ops / 5 treasury); LP pairs 43.75M; sweep after the window burns the leftover and moves nothing further", async function () {
    this.timeout(300_000);
    await startSale(30 * DAY);
    const saleAddr = await sale.getAddress();
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);

    await fillTier(1, 5_000); // 5,000 slots = 20 BNB, no referrers
    expect(await sale.tierSold(1)).to.equal(5_000);
    expect(await sale.tierCompleted(1)).to.equal(false);
    // Already split per purchase: LP 11 / pool 2 / ops 2 / treasury 5.
    expect(await token.tierLPBNB(1)).to.equal(BNB(11));
    expect(await token.rewardPoolBNB()).to.equal(BNB(2));
    expect(await ethers.provider.getBalance(treasury.address) - treasuryBefore).to.equal(BNB(5));
    expect(await ethers.provider.getBalance(operatorWallet.address) - operatorWalletBefore).to.equal(BNB(2));
    expect(await ethers.provider.getBalance(saleAddr)).to.equal(0);

    // Mid-sale, a partial tier's liquidity is too early (sold count
    // not final yet — an early add would strand later LP BNB).
    await expect(token.addTierLiquidity(1)).to.be.revertedWithCustomError(
      token,
      "TierLiquidityTooEarly"
    );

    await increaseTime(30 * DAY + 1); // sale ended
    await token.addTierLiquidity(1); // anyone may call
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(43_750_000));
    expect(await router.lastLiquidityETHAmount()).to.equal(BNB(11));
    expect(await router.lastLiquidityTo()).to.equal(DEAD);
    expect(await token.tierLPPaired(1)).to.equal(LOA(43_750_000));
    expect(await token.tierLiquidityDone(1)).to.equal(true);

    // Burn the unpaired reserve directly (permissionless, idempotent):
    // tier 0 never got revenue (87.5M), tier 1 paired 43.75M of its
    // 87.5M (43.75M unpaired), tiers 2-3 never got revenue (87.5M each).
    const deadBefore = await token.balanceOf(DEAD);
    await token.burnUnpairedLPReserve();
    expect(await token.balanceOf(DEAD)).to.equal(deadBefore + LOA(306_250_000));
    expect(await token.balanceOf(await token.getAddress())).to.equal(0);
    // Repeat call burns nothing more.
    await token.burnUnpairedLPReserve();
    expect(await token.balanceOf(DEAD)).to.equal(deadBefore + LOA(306_250_000));

    // The Sale's leftover LOA (unminted slots + dust) burns on the
    // first post-end touch — here the sweep after the refund window.
    // The sweep itself moves no BNB (the Sale holds none: tier 2 split
    // per purchase) and does not revert on the already-burned reserve.
    const deadBefore2 = await token.balanceOf(DEAD);
    const leftoverBefore = await token.balanceOf(await sale.getAddress());
    expect(leftoverBefore).to.equal(LOA(650_000_000) - TPS * 5_000n);
    await increaseTime(7 * DAY); // past the refund window
    const treasuryBefore2 = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore2 = await ethers.provider.getBalance(operatorWallet.address);
    await expect(sale.sweepExpiredRefunds())
      .to.emit(sale, "ExpiredRefundsSwept")
      .withArgs(0);
    expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
    expect(await token.balanceOf(DEAD)).to.equal(deadBefore2 + leftoverBefore);
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore2);
    expect(await ethers.provider.getBalance(operatorWallet.address)).to.equal(operatorWalletBefore2);
    expect(await token.rewardPoolBNB()).to.equal(BNB(2));
  });

  it("partial tier: fully-referred tier 2 at 5,000 slots routes Treasury 4 (19 - 13 - 2)", async function () {
    this.timeout(300_000);
    await startSale(30 * DAY);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    const aliceBefore = await ethers.provider.getBalance(alice.address);

    await fillTierAs(1, 5_000, alice.address); // 20 BNB gross, all referred
    expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(1));
    expect(await token.tierLPBNB(1)).to.equal(BNB(11));
    expect(await token.rewardPoolBNB()).to.equal(BNB(2));
    expect(await ethers.provider.getBalance(treasury.address) - treasuryBefore).to.equal(BNB(4));
    expect(await ethers.provider.getBalance(operatorWallet.address) - operatorWalletBefore).to.equal(BNB(2));
    expect(await ethers.provider.getBalance(alice.address) - aliceBefore).to.equal(BNB(1));
  });

  it("sold-out tier 2: no lump split at completion; sweep after the window burns the leftover and moves nothing else", async function () {
    this.timeout(300_000);
    await startSale(30 * DAY);
    await fillTier(1, 10_000);
    expect(await sale.tierCompleted(1)).to.equal(true);
    expect(await token.tierLPBNB(1)).to.equal(BNB(22));
    expect(await token.rewardPoolBNB()).to.equal(BNB(4));

    // Manual LP add still works for a completed tier (anyone may call),
    // even mid-sale — the sold count is final at 10,000.
    await token.addTierLiquidity(1);
    expect(await token.tierLiquidityDone(1)).to.equal(true);
    expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(87_500_000));

    await increaseTime(30 * DAY + 1);
    // The sweep after the refund window is the first post-end touch:
    // it burns the Sale's leftover LOA (unminted slots + dust) and the
    // LP reserve of the tiers that never got revenue (tiers 0, 2, 3 —
    // 87.5M each), and moves no BNB for the sold-out tier.
    const deadBefore = await token.balanceOf(DEAD);
    const leftoverBefore = await token.balanceOf(await sale.getAddress());
    expect(leftoverBefore).to.equal(LOA(650_000_000) - TPS * 10_000n);
    await increaseTime(7 * DAY);
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
    const poolBefore = await token.rewardPoolBNB();
    await expect(sale.sweepExpiredRefunds())
      .to.emit(sale, "ExpiredRefundsSwept")
      .withArgs(0);
    expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
    expect(await token.balanceOf(DEAD)).to.equal(
      deadBefore + leftoverBefore + LOA(262_500_000)
    );
    expect(await ethers.provider.getBalance(treasury.address)).to.equal(treasuryBefore);
    expect(await ethers.provider.getBalance(operatorWallet.address)).to.equal(operatorWalletBefore);
    expect(await token.rewardPoolBNB()).to.equal(poolBefore);
  });

  it("burnUnpairedLPReserve reverts before the sale ends", async function () {
    await startSale(100);
    await expect(token.burnUnpairedLPReserve()).to.be.revertedWithCustomError(
      token,
      "SaleNotEnded"
    );
  });

  it("no partial sweep during the refund window; sweepExpiredRefunds sends everything after the window", async function () {
    await startSale(100);
    await giveAgentID(buyer);
    await giveAgentID(alice);
    // Two buyers, 10 slots each in tier 1 (0.04 BNB each, 0.08 total).
    await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    await sale.connect(alice).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
    expect(await sale.tier1RefundLiability()).to.equal(BNB(0.072));

    await increaseTime(101); // sale ended, window open
    // No finalize step anymore (user decision 2026-11-26): the full
    // 0.08 BNB stays in the Sale while the window is open — nothing
    // sweeps early, not even the part above the liability.
    const treasuryBefore = await ethers.provider.getBalance(treasury.address);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(BNB(0.08));

    // The buyer's refund works — and burns the returned tokens
    // immediately (straight to DEAD) plus the Sale's leftover LOA
    // via the lazy burn in the same transaction.
    await token.connect(buyer).approve(await sale.getAddress(), TPS * 10n);
    await sale.connect(buyer).claimRefund(0);
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(BNB(0.044));
    expect(await token.balanceOf(await sale.getAddress())).to.equal(0);

    // Alice never claims; the sweep is locked until the window closes.
    await expect(sale.sweepExpiredRefunds()).to.be.revertedWithCustomError(
      sale,
      "RefundWindowStillOpen"
    );
    await increaseTime(7 * DAY);
    await expect(sale.sweepExpiredRefunds())
      .to.emit(sale, "ExpiredRefundsSwept")
      .withArgs(BNB(0.044));
    expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
    expect(await ethers.provider.getBalance(treasury.address) - treasuryBefore).to.equal(BNB(0.044));

    // Alice's late claim now reverts.
    await token.connect(alice).approve(await sale.getAddress(), TPS * 10n);
    await expect(sale.connect(alice).claimRefund(0)).to.be.revertedWithCustomError(
      sale,
      "RefundWindowClosed"
    );
  });

  it("constants: 40,500 slots, per-slot floor of 650M/40,500, whitelist sizes, tier prices", async function () {
    expect(await sale.TOTAL_SLOTS()).to.equal(40_500);
    expect(await sale.FCFS_SLOTS()).to.equal(200);
    expect(await sale.GUARANTEE_SLOTS()).to.equal(300);
    expect(await sale.GUARANTEE_MAX_PER_WALLET()).to.equal(1);
    // Referral mechanism: fixed paid limit 10 slots; referrals pay a
    // 5% BNB reward instead of a quota bonus (user decision 2026-11-25).
    expect(await sale.PAID_BASE_LIMIT()).to.equal(10);
    expect(await sale.REFERRAL_REWARD_BPS()).to.equal(500);
    expect(TPS).to.equal((LOA(650_000_000) * 1n) / 40_500n);
    expect(TPS).to.equal(16049382716049382716049n); // ≈ 16,049.382716 LOA
    // Pricing 2026-11-23 22:45 (FINAL): ALL tiers flat 0.004 ->
    // per-tier revenue 40 BNB each, max raise 160 BNB.
    expect(await sale.tierPrices(0)).to.equal(BNB(0.004));
    expect(await sale.tierPrices(1)).to.equal(BNB(0.004));
    expect(await sale.tierPrices(2)).to.equal(BNB(0.004));
    expect(await sale.tierPrices(3)).to.equal(BNB(0.004));
  });

  // --------------------------------------- tier-1 early pool open 2026-11-26
  // "Mở pool sớm" (user correction 01:45): the Treasury opens tier 1's
  // liquidity pool BEFORE it sells out — NOT changing sale times (the
  // saleTimeSetter role built on that misreading is REMOVED).
  describe("tier-1 early pool open (Treasury)", function () {
    it("treasury opens tier 1 early at 5,000/10,000: partial split 13/2/5, LP pairs 43.75M, tier 1 closes, refund cancelled", async function () {
      this.timeout(300_000);
      await startSale();
      const sampleWallet = await fillTier(0, 5_000);
      expect(await sale.tierSold(0)).to.equal(5_000);
      expect(await sale.tier1RefundLiability()).to.equal(BNB(18)); // 90% of 20 BNB

      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
      const tx = await sale.connect(treasury).openTier1PoolEarly();
      await expect(tx)
        .to.emit(sale, "TierCompleted")
        .withArgs(0, BNB(20))
        .to.emit(sale, "Tier1PoolOpenedEarly")
        .withArgs(5_000, BNB(20))
        .to.emit(token, "TierLiquidityAdded")
        .withArgs(0, LOA(43_750_000), BNB(11));
      // The treasury paid the gas for the early-open call itself, so its
      // balance delta is the 5 BNB slice minus that gas.
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      expect(await token.tierLiquidityDone(0)).to.equal(true);
      expect(await token.tierLPBNB(0)).to.equal(0);
      expect(await token.rewardPoolBNB()).to.equal(BNB(2));
      expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(43_750_000));
      expect(await router.lastLiquidityETHAmount()).to.equal(BNB(11));
      expect(await router.lastLiquidityTo()).to.equal(DEAD);
      // Split of the 20 BNB gross: 13 Token / 2 Operator / 5 Treasury.
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
      expect(treasuryAfter - treasuryBefore + gasCost).to.equal(BNB(5));
      expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(2));
      // The pair is set automatically by the liquidity add (tax auto-on),
      // and launch auto-activates at the same first add (user decision
      // 2026-11-26).
      expect(await token.pair()).to.equal(await pair.getAddress());
      expect(await token.launched()).to.equal(true);
      expect(await token.launchTime()).to.be.gt(0);
      // Tier 1 is closed and the refund liability is gone.
      expect(await sale.tier1RefundLiability()).to.equal(0);
      await giveAgentID(buyer);
      await expect(
        sale.connect(buyer).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) })
      ).to.be.revertedWithCustomError(sale, "TierClosed");
      // Tax is live immediately: a sell to the pair is taxed 3%.
      await token.connect(sampleWallet).transfer(await pair.getAddress(), LOA(100));
      expect(await token.balanceOf(await pair.getAddress())).to.equal(LOA(97));
      expect(await token.balanceOf(treasury.address)).to.equal(LOA(1.5));
      expect(await token.rewardTokenBucket()).to.equal(LOA(1.5));

      // After the sale ends the refund stays cancelled, and the sweep
      // after the window moves nothing for refunds that can never
      // happen (the Sale holds no BNB — the early open split it all).
      await increaseTime(7 * DAY + 1);
      await expect(sale.connect(buyer).claimRefund(0)).to.be.revertedWithCustomError(
        sale,
        "RefundNotAvailable"
      );
      expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
      // The sweep is the first post-end touch: it burns the Sale's
      // leftover LOA (unminted slots + dust) via the lazy burn.
      const deadBefore = await token.balanceOf(DEAD);
      const leftoverBefore = await token.balanceOf(await sale.getAddress());
      expect(leftoverBefore).to.equal(LOA(650_000_000) - TPS * 5_000n);
      await increaseTime(7 * DAY);
      await expect(sale.sweepExpiredRefunds())
        .to.emit(sale, "ExpiredRefundsSwept")
        .withArgs(0);
      expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
      // Tier 0 paired 43.75M (43.75M unpaired) and tiers 1-3 never got
      // revenue (87.5M each) — the lazy burn settles 306.25M of LP
      // reserve on top of the Sale's leftover.
      expect(await token.balanceOf(DEAD)).to.equal(
        deadBefore + leftoverBefore + LOA(306_250_000)
      );
      expect(await ethers.provider.getBalance(await sale.getAddress())).to.equal(0);
    });

    it("treasury opens tier 1 early with full referral: split 13/2/4, referrer keeps 1 BNB", async function () {
      this.timeout(300_000);
      await startSale();
      await fillTierAs(0, 5_000, alice.address);
      const treasuryBefore = await ethers.provider.getBalance(treasury.address);
      const operatorWalletBefore = await ethers.provider.getBalance(operatorWallet.address);
      const tx = await sale.connect(treasury).openTier1PoolEarly();
      await expect(tx)
        .to.emit(sale, "Tier1PoolOpenedEarly")
        .withArgs(5_000, BNB(20));
      // The treasury paid the gas for the early-open call itself, so its
      // balance delta is the 4 BNB slice minus that gas.
      const receipt = await tx.wait();
      const gasCost = receipt.gasUsed * receipt.gasPrice;
      // Referrers already took 5% (1 BNB) at mint; the split is 13/2/4.
      expect(await sale.referralRewardsEarned(alice.address)).to.equal(BNB(1));
      const treasuryAfter = await ethers.provider.getBalance(treasury.address);
      const operatorWalletAfter = await ethers.provider.getBalance(operatorWallet.address);
      expect(treasuryAfter - treasuryBefore + gasCost).to.equal(BNB(4));
      expect(operatorWalletAfter - operatorWalletBefore).to.equal(BNB(2));
      expect(await token.rewardPoolBNB()).to.equal(BNB(2));
      expect(await router.lastLiquidityTokenAmount()).to.equal(LOA(43_750_000));
      expect(await router.lastLiquidityETHAmount()).to.equal(BNB(11));
    });

    it("only the treasury wallet can open tier 1 early (owner included)", async function () {
      await startSale();
      await fillTier(0, 10);
      await expect(
        sale.connect(owner).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "NotTreasury");
      await expect(
        sale.connect(buyer).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "NotTreasury");
      await expect(
        sale.connect(alice).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "NotTreasury");
    });

    it("early open reverts before sale start, after sale end, and with 0 slots sold", async function () {
      // Before the sale starts.
      await expect(
        sale.connect(treasury).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "SaleNotStarted");

      // With 0 slots sold, during the sale.
      await startSale(100);
      await expect(
        sale.connect(treasury).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "Tier1NoSales");

      // After the sale ends.
      await fillTier(0, 10);
      await increaseTime(101);
      await expect(
        sale.connect(treasury).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "SaleEnded");
    });

    it("early open reverts after a tier-1 sellout", async function () {
      this.timeout(300_000);
      await startSale();
      await fillTier(0, 10_000); // sells out: the auto-add already ran
      await expect(
        sale.connect(treasury).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "TierClosed");
    });

    it("early open twice reverts", async function () {
      await startSale();
      await fillTier(0, 10);
      await sale.connect(treasury).openTier1PoolEarly();
      await expect(
        sale.connect(treasury).openTier1PoolEarly()
      ).to.be.revertedWithCustomError(sale, "TierClosed");
    });

    it("tiers 2-4: manual addTierLiquidity after sale end still pairs proportional tokens", async function () {
      await startSale(100);
      await fillTier(1, 100); // 100 slots = 0.4 BNB; splits per purchase
      expect(await token.tierLPBNB(1)).to.equal(BNB(0.22)); // 55% of 0.4
      // Before the sale ends a partial manual add is still too early.
      await expect(token.addTierLiquidity(1)).to.be.revertedWithCustomError(
        token,
        "TierLiquidityTooEarly"
      );
      await increaseTime(101); // past sale end
      await expect(token.addTierLiquidity(1))
        .to.emit(token, "TierLiquidityAdded")
        .withArgs(1, LOA(875_000), BNB(0.22));
      expect(await token.tierLiquidityDone(1)).to.equal(true);
      expect(await token.pair()).to.equal(await pair.getAddress());
    });
  });

  // --------------------------- owner cut + auto-renounce 2026-11-26
  // User decision 2026-11-26: the owner keeps ONLY setGuaranteeRoot
  // (add whitelist), and ownership of BOTH contracts renounces
  // automatically at the first mint after the sale opens. finalizeSale
  // and finalizeLaunch are gone; the burn is automatic (lazy, on the
  // first post-sale-end touch); launch activates automatically at the
  // first liquidity add.
  describe("owner cut + auto-renounce (2026-11-26)", function () {
    it("first buy renounces both Sale and Token ownership; later buys still work", async function () {
      await startSale();
      await giveAgentID(buyer);
      await giveAgentID(alice);
      expect(await sale.owner()).to.equal(owner.address);
      expect(await token.owner()).to.equal(owner.address);
      expect(await sale.ownershipRenounced()).to.equal(false);

      await sale.connect(buyer).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) });
      expect(await sale.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await sale.ownershipRenounced()).to.equal(true);
      expect(await token.balanceOf(buyer.address)).to.equal(TPS);

      // Ownership is gone, but the sale keeps working: a second buy
      // distributes tokens exactly as before.
      await sale.connect(alice).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) });
      expect(await token.balanceOf(alice.address)).to.equal(TPS);
      expect(await sale.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
    });

    it("first FCFS claim renounces both contracts", async function () {
      await startSale();
      await loginPass.setHasLoginPass(alice.address, true);
      await giveAgentID(alice);
      await sale.connect(alice).claimFCFS();
      expect(await sale.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.balanceOf(alice.address)).to.equal(TPS);
    });

    it("first Guarantee claim renounces both contracts", async function () {
      const guaranteeTree = buildTree([guaranteeLeaf(dave.address, 5)]);
      await sale.setGuaranteeRoot(guaranteeTree.root);
      await startSale();
      await sale.connect(dave).claimGuarantee(1, 5, getProof(guaranteeTree, 0));
      expect(await sale.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.balanceOf(dave.address)).to.equal(TPS);
    });

    it("setGuaranteeRoot works before the first mint, reverts after renounce", async function () {
      const tree1 = buildTree([guaranteeLeaf(dave.address, 5)]);
      const tree2 = buildTree([guaranteeLeaf(erin.address, 5)]);
      // Before the sale starts the owner may still update the root.
      await sale.setGuaranteeRoot(tree1.root);
      expect(await sale.guaranteeRoot()).to.equal(tree1.root);
      await sale.setGuaranteeRoot(tree2.root);
      expect(await sale.guaranteeRoot()).to.equal(tree2.root);

      await startSale();
      await giveAgentID(buyer);
      await sale.connect(buyer).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) });
      // After the first mint the owner is gone: the root is frozen.
      await expect(
        sale.setGuaranteeRoot(tree1.root)
      ).to.be.revertedWithCustomError(sale, "OwnableUnauthorizedAccount");
      expect(await sale.guaranteeRoot()).to.equal(tree2.root);
      // Sale times freeze the same way.
      await expect(
        sale.setSaleTimes(1, 2)
      ).to.be.revertedWithCustomError(sale, "OwnableUnauthorizedAccount");
    });

    it("removed functions are gone from the ABIs (Sale finalizeSale; Token launch/wallet/tax/operator setters)", async function () {
      const saleNames = sale.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      expect(saleNames).to.not.include("finalizeSale");
      const tokenNames = token.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      for (const removed of [
        "finalizeLaunch",
        "activateLaunch",
        "setTreasuryWallet",
        "setOperatorWallet",
        "setTaxExempt",
        "setSeasonOperator",
        "taxExempt",
      ]) {
        expect(tokenNames).to.not.include(removed);
      }
      // The renounce entry point the Sale uses is Sale-only.
      expect(tokenNames).to.include("renounceOwnershipFromSale");
    });

    it("season operator survives renounce; only the operator passes the root gate", async function () {
      await startSale();
      await giveAgentID(buyer);
      await sale.connect(buyer).buy(0, 1, ethers.ZeroAddress, { value: BNB(0.004) });
      expect(await token.owner()).to.equal(ethers.ZeroAddress);
      expect(await token.seasonOperator()).to.equal(operator.address);
      // A non-operator fails the operator gate (checked first).
      await expect(
        token.connect(alice).submitClaimRoot(1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(token, "NotOwnerOrOperator");
      // The operator passes the gate and reaches the season check.
      await expect(
        token.connect(operator).submitClaimRoot(1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(token, "SeasonNotClosed");
    });

    it("lazy auto-burn: the second post-end touch burns nothing more", async function () {
      await startSale(100);
      await giveAgentID(buyer);
      await sale.connect(buyer).buy(0, 10, ethers.ZeroAddress, { value: BNB(0.04) });
      await increaseTime(101); // sale ended
      await token.connect(buyer).approve(await sale.getAddress(), TPS * 10n);
      const deadBefore = await token.balanceOf(DEAD);
      // First touch (the refund): leftover + refunded tokens + LP
      // reserve burn land in DEAD; the Sale's LOA is gone.
      await sale.connect(buyer).claimRefund(0);
      expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
      const deadAfterFirst = await token.balanceOf(DEAD);
      expect(deadAfterFirst).to.be.gt(deadBefore);
      // Second touch (the sweep after the window): no LOA left to
      // burn — DEAD does not move; only the retained 0.004 BNB sweeps.
      await increaseTime(7 * DAY);
      await expect(sale.sweepExpiredRefunds())
        .to.emit(sale, "ExpiredRefundsSwept")
        .withArgs(BNB(0.004));
      expect(await token.balanceOf(DEAD)).to.equal(deadAfterFirst);
      expect(await token.balanceOf(await sale.getAddress())).to.equal(0);
    });
  });
});
