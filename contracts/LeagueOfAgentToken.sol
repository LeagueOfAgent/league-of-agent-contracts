// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./interfaces/IPancakeV2Router.sol";

/// @notice Minimal Sale surface the Token reads: when the sale ended.
///         Partial-tier liquidity adds and LP-reserve burns only run
///         after the sale ends, when sold counts and revenue are final.
///         (Read via staticcall so a Sale that does not answer counts
///         as "not ended" instead of reverting.)
interface ISaleMinimal {
    function saleEndTime() external view returns (uint256);
}

/// @title League Of Agent — LOA token (ERC-20)
/// @notice The project's single main contract. It holds THREE things in one
///         address (user decision 2026-11-18: reward pool + season logic live
///         INSIDE the main contract, no separate RewardPool contract):
///           1. the LOA ERC-20 token (hard cap 1,000,000,000, 3% tax),
///           2. the Reward Pool — a BNB bucket with NO withdraw function;
///              its only outflow is the season buyback below,
///           3. the ranked-season engine (30-day seasons, 50%-of-pool fund
///              — season 1 special: the whole pool when it is at or below
///              the 4 BNB seed — 24h tranche buyback, Merkle-root claims,
///              7-day window).
/// @dev    Supply is minted ONCE in the constructor and there is no mint
///         function anywhere — the 1B cap is hard. Ownership is renounced
///         AUTOMATICALLY at the first mint after the sale opens (user
///         decision 2026-11-26: the Sale renounces both contracts in
///         that mint transaction); the season operator role is a
///         constructor argument that survives the renounce.
contract LeagueOfAgentToken is ERC20, Ownable, ReentrancyGuard {
    // ------------------------------------------------------------ constants

    /// @notice Hard cap: 1,000,000,000 LOA, minted once at construction
    ///         (user decision 2026-11-19).
    uint256 public constant TOTAL_CAP = 1_000_000_000 * 1e18;
    /// @notice 65% of supply — the mint share, held by the Sale contract and
    ///         distributed per slot (user decision 2026-11-19).
    uint256 public constant MINT_SHARE = 650_000_000 * 1e18;
    /// @notice 35% of supply — LP reserve, held by THIS contract and paired
    ///         per tier as tiers complete (user decision 2026-11-19).
    uint256 public constant LP_RESERVE = 350_000_000 * 1e18;
    /// @notice LOA paired with each completed tier's 55% BNB slice:
    ///         350,000,000 / 4 = 87,500,000 per tier.
    uint256 public constant LP_TOKENS_PER_TIER = 87_500_000 * 1e18;
    uint8 public constant TIER_COUNT = 4;
    /// @notice Slots per paid tier (10,000). The token tracks how many
    ///         slots of each tier were actually sold (see tierSoldSlots)
    ///         so partial-tier liquidity adds pair a proportional amount
    ///         of the LP reserve (user decision 2026-11-26).
    uint256 public constant SLOTS_PER_TIER = 10_000;

    /// @notice Transfer tax: 3% total, taken in LOA (user decision
    ///         2026-11-18) — 1.5% to the treasury wallet, 1.5% retained by
    ///         this contract in the reward-token bucket for season prizes.
    ///         PAIR-ONLY (user decision 2026-11-25): the tax applies ONLY
    ///         to transfers where one side is the LP pair (buys and sells
    ///         on the DEX); wallet-to-wallet transfers are tax-free.
    uint256 public constant TAX_BPS = 300; // 3%
    uint256 public constant TAX_TREASURY_BPS = 150; // 1.5%

    /// @notice LP tokens are burned to this address — locked forever
    ///         (user decision 2026-11-19).
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // Season constants (user decisions 2026-11-17 → 2026-11-19).
    uint256 public constant SEASON_DURATION = 30 days;
    /// @notice Season fund = 50% of the reward pool at close; the other 50%
    ///         stays reserved for the next season. Applies to every season,
    ///         with one season-1 exception keyed to SEASON_ONE_FUND_FLOOR
    ///         below.
    uint256 public constant SEASON_FUND_BPS = 5000; // 50%
    /// @notice Season 1 exception — FINAL form (user decision 2026-11-23
    ///         23:02–23:04, "sàn 4 BNB" — a 4 BNB floor): the season-1 fund
    ///         is max(this floor, 50% of the pool), capped at the pool
    ///         balance itself. So the fund is never below 4 BNB while the
    ///         pool holds at least 4 BNB, and if the pool holds less than
    ///         4 BNB the whole pool is the fund. Examples: pool 3 → 3,
    ///         pool 4 → 4, pool 6 → 4 (floor bites), pool 10 → 5,
    ///         pool 18 → 9. Seasons 2+ have no floor — plain 50%.
    uint256 public constant SEASON_ONE_FUND_FLOOR = 4 ether;
    /// @notice Buyback is split into tranches over 24h to reduce slippage /
    ///         front-running (user decision 2026-11-19): 8 tranches,
    ///         minimum 3 hours between tranches.
    uint8 public constant TRANCHE_COUNT = 8;
    uint256 public constant TRANCHE_INTERVAL = 3 hours;
    /// @notice Off-chain anti-cheat review window: a claim root may not be
    ///         submitted before close + 48h.
    uint256 public constant REVIEW_PERIOD = 48 hours;
    /// @notice Winners claim within 7 days of the root being submitted;
    ///         unclaimed prizes return to the reward bucket afterwards.
    uint256 public constant CLAIM_WINDOW = 7 days;

    // --------------------------------------------------------------- errors

    error ZeroAddress();
    error NotSaleContract();
    error SaleAlreadySet();
    error TierOutOfRange(uint8 tier);
    error TierSplitAlreadyReceived(uint8 tier);
    error TierSplitNotReceived(uint8 tier);
    error TierLiquidityAlreadyDone(uint8 tier);
    error TierLiquidityTooEarly(uint8 tier);
    error SaleNotEnded();
    error NotLaunched();
    error SeasonNotEnded(uint256 seasonId);
    error SeasonAlreadyClosed(uint256 seasonId);
    error SeasonNotClosed(uint256 seasonId);
    error BuybackComplete(uint256 seasonId);
    error TrancheTooEarly(uint256 seasonId, uint256 nextAllowedTime);
    error RootTooEarly(uint256 seasonId, uint256 earliestTime);
    error RootAlreadySubmitted(uint256 seasonId);
    error BuybackNotComplete(uint256 seasonId);
    error NoClaimRoot(uint256 seasonId);
    error ClaimWindowClosed(uint256 seasonId);
    error AlreadyClaimed(uint256 seasonId, address winner);
    error InvalidClaimProof();
    error AlreadySwept(uint256 seasonId);
    error ClaimWindowStillOpen(uint256 seasonId);
    error BnbTransferFailed();
    error NotOwnerOrOperator();

    // --------------------------------------------------------------- events

    event PairSet(address indexed pair);
    event SaleContractSet(address indexed sale);
    event RewardDeposited(address indexed from, uint256 amount);
    event RevenueDeposited(address indexed from, uint256 poolPart, uint256 operatorPart);
    event TierSplitReceived(uint8 indexed tier, uint256 lpPart, uint256 poolPart);
    event TierLiquidityAdded(uint8 indexed tier, uint256 tokenAmount, uint256 bnbAmount);
    event TierRevenueReceived(uint8 indexed tier, uint256 lpPart, uint256 poolPart);
    event LPReserveBurned(uint256 amount);
    event Launched(uint256 launchTime);
    event SeasonClosed(uint256 indexed seasonId, uint256 fundBNB, uint256 prizeSnapshotLOA);
    event BuybackTrancheExecuted(uint256 indexed seasonId, uint8 trancheIndex, uint256 bnbIn, uint256 loaOut);
    event ClaimRootSubmitted(uint256 indexed seasonId, bytes32 root, uint256 claimDeadline);
    event PrizeClaimed(uint256 indexed seasonId, address indexed winner, uint256 amount);
    event UnclaimedSwept(uint256 indexed seasonId, uint256 amount);

    // ---------------------------------------------------------------- state

    /// @notice The treasury wallet (marketing): receives the 1.5% tax
    ///         slice and the 25% tier-revenue slice (sent by Sale).
    ///         Split from the old single shared wallet by user decision
    ///         2026-11-25: treasury = marketing, operator is separate.
    ///         IMMUTABLE after deploy (user decision 2026-11-26: owner
    ///         keeps no wallet-repointing power — only the Guarantee
    ///         root stays owner-settable, and only until the first mint).
    address public immutable treasuryWallet;
    /// @notice The operator wallet: receives the 10% tier-revenue slice
    ///         (sent by Sale) and the 20% revenue slice of
    ///         depositRevenue(). Split from the old single shared wallet
    ///         by user decision 2026-11-25. IMMUTABLE after deploy (see
    ///         treasuryWallet above).
    address public immutable operatorWallet;

    /// @notice The Sale contract — the only caller of receiveTierSplit().
    address public saleContract;

    /// @notice PancakeSwap V2 router (mainnet:
    ///         0x10ED43C718714eb63d5aA57B78B54704E256024E).
    IPancakeV2Router public immutable router;

    /// @notice The PancakeSwap V2 LOA/WBNB pair. Set AUTOMATICALLY by
    ///         _addTierLiquidity() from the Pancake factory (router.
    ///         factory().getPair(token, WETH)) the first time any tier's
    ///         liquidity is added — user decision 2026-11-26 ("còn lại
    ///         tự động bật tax"): there is NO owner setPair anymore, so
    ///         the 3% pair-only tax starts the moment the pool exists.
    ///         While it is address(0) no transfer is taxed. The pair is
    ///         NOT tax-exempt: the tax applies exactly when one side of
    ///         a transfer IS this pair (a buy or a sell); wallet-to-wallet
    ///         transfers never touch it and are tax-free.
    address public pair;

    /// @notice Transfers are untaxed when the sender OR the recipient is
    ///         one of the FIXED exempt addresses (user decision
    ///         2026-11-26: the owner setTaxExempt power is REMOVED —
    ///         the exemption set is now hard-coded): this contract, the
    ///         Sale contract, the treasury and operator wallets,
    ///         address(0). The PancakeSwap pair is NOT exempt — buys
    ///         and sells are taxed (user decision 2026-11-19: the
    ///         contract's own buyback is exempt because the contract
    ///         itself is the recipient).
    function _isTaxExempt(address account) internal view returns (bool) {
        return account == address(this) || account == saleContract || account == treasuryWallet
            || account == operatorWallet || account == address(0);
    }

    /// @notice LOA retained from the 1.5% tax slice, earmarked for season
    ///         prizes. At season close the whole bucket is snapshotted into
    ///         that season's prize pool (it is already LOA — no buyback
    ///         needed for this portion).
    uint256 public rewardTokenBucket;

    // Reward Pool — BNB bucket. There is deliberately NO function that can
    // move BNB out of this bucket except the season buyback flow
    // (user decision 2026-11-19: "no withdraw function, owner included").
    /// @notice BNB accounted to the reward pool. The contract's raw BNB
    ///         balance also covers the tier-LP buckets and unallocated
    ///         plain transfers; this variable is the pool's share.
    uint256 public rewardPoolBNB;

    /// @notice Per-tier LP BNB delivered by Sale via receiveTierSplit(),
    ///         waiting for addTierLiquidity().
    uint256[TIER_COUNT] public tierLPBNB;
    bool[TIER_COUNT] public tierSplitReceived;
    bool[TIER_COUNT] public tierLiquidityDone;
    /// @notice Slots actually sold per tier, as reported by the Sale:
    ///         receiveTierRevenue() adds each purchase's slots, and
    ///         receiveTierSplit() records the count passed in (full on a
    ///         sellout, partial on a Treasury early pool open). Used to
    ///         size partial-tier liquidity adds proportionally (user
    ///         decision 2026-11-26).
    mapping(uint8 => uint256) public tierSoldSlots;
    /// @notice LOA actually paired per tier by _addTierLiquidity().
    ///         A partial tier pairs less than LP_TOKENS_PER_TIER; the
    ///         difference is unpaired reserve, burned by
    ///         burnUnpairedLPReserve() (user decision 2026-11-26).
    mapping(uint8 => uint256) public tierLPPaired;
    /// @notice True once a tier's unpaired LP reserve has been burned
    ///         (so burnUnpairedLPReserve() is idempotent).
    mapping(uint8 => bool) public tierLPReserveSettled;

    // Seasons.
    struct Season {
        uint256 closeTime; // 0 = not closed
        uint256 fundBNB; // locked at close (season 1: max(4 BNB floor, 50% of the pool), capped at the pool; seasons 2+: 50% of the pool)
        uint8 tranchesDone;
        uint256 lastTrancheTime;
        uint256 prizeLOA; // total LOA available for claims
        uint256 claimedLOA;
        bytes32 claimRoot; // 0 = not submitted
        uint256 claimDeadline;
        bool swept;
    }

    bool public launched;
    uint256 public launchTime;
    /// @notice Only this address may submit a season's claim Merkle root.
    ///         Set ONCE as a constructor argument (user decision
    ///         2026-11-26: the owner setSeasonOperator power is
    ///         REMOVED); the role survives the automatic renounce at
    ///         the first mint.
    address public immutable seasonOperator;
    mapping(uint256 => Season) public seasons;
    mapping(uint256 => mapping(address => bool)) public prizeClaimed;

    // ----------------------------------------------------------- constructor

    /// @param initialOwner_   The contract owner (the deployer EOA). MUST be
    ///                        passed explicitly — NEVER Ownable(msg.sender):
    ///                        a CREATE2 deploy through the deterministic
    ///                        proxy makes msg.sender the PROXY, not the
    ///                        deployer, and an owner nobody controls would
    ///                        brick setSaleContract() forever. OZ Ownable
    ///                        reverts on address(0) itself.
    /// @param saleAddress_   Receives the 650,000,000 LOA mint share. May be
    ///                       address(0) at construction; then the share is
    ///                       held here and setSaleContract() (once) hands it
    ///                       over. The normal deploy order is Sale first,
    ///                       then this contract with the Sale address known.
    /// @param treasuryWallet_   Treasury wallet (marketing): tax 1.5% slice
    ///                          + 25% tier-revenue slice. IMMUTABLE.
    /// @param operatorWallet_ Operator wallet: 10% tier-revenue slice
    ///                          + 20% depositRevenue slice. IMMUTABLE.
    /// @param router_           PancakeSwap V2 router address.
    /// @param seasonOperator_   The season operator: the ONLY address that
    ///                          may submit a season's claim Merkle root
    ///                          (and co-sign depositRevenue). Set once
    ///                          here, never changeable, survives the
    ///                          automatic renounce at the first mint.
    constructor(
        address initialOwner_,
        address saleAddress_,
        address treasuryWallet_,
        address operatorWallet_,
        address router_,
        address seasonOperator_
    ) ERC20("League Of Agent", "LOA") Ownable(initialOwner_) {
        if (
            treasuryWallet_ == address(0) || operatorWallet_ == address(0) || router_ == address(0)
                || seasonOperator_ == address(0)
        ) {
            revert ZeroAddress();
        }
        treasuryWallet = treasuryWallet_;
        operatorWallet = operatorWallet_;
        router = IPancakeV2Router(router_);
        seasonOperator = seasonOperator_;

        // LP reserve stays in this contract for the per-tier liquidity adds.
        _mint(address(this), LP_RESERVE);
        if (saleAddress_ != address(0)) {
            _setSaleContract(saleAddress_);
            _mint(saleAddress_, MINT_SHARE);
        } else {
            // Held here until setSaleContract() is called once.
            _mint(address(this), MINT_SHARE);
        }
    }

    // ------------------------------------------------------------ owner admin
    // The only owner power left in this contract is the one-time
    // setSaleContract() setup (dead after its first call). Everything
    // else the owner used to do is gone (user decision 2026-11-26):
    // wallets are immutable constructor args, the tax-exemption set is
    // fixed in code, the season operator is a constructor arg, launch
    // activates automatically at the first liquidity add, and ownership
    // renounces automatically at the first mint (via the Sale — see
    // renounceOwnershipFromSale()). There is NO owner mint, NO pause,
    // and NO pool withdrawal — by design.

    /// @notice Hand the mint share to the Sale contract. One-time, and only
    ///         when the constructor was given address(0) for the sale.
    function setSaleContract(address sale_) external onlyOwner {
        if (saleContract != address(0)) revert SaleAlreadySet();
        if (sale_ == address(0)) revert ZeroAddress();
        _setSaleContract(sale_);
        _transfer(address(this), sale_, MINT_SHARE);
    }

    function _setSaleContract(address sale_) internal {
        saleContract = sale_;
        emit SaleContractSet(sale_);
    }

    /// @notice Renounce this Token's ownership, callable ONLY by the Sale
    ///         contract — invoked by the Sale's first-mint auto-renounce
    ///         (user decision 2026-11-26: "renounce khi mở mint").
    ///         Ownable's renounceOwnership() is onlyOwner, so the Sale
    ///         cannot call it (msg.sender would be the buyer); this
    ///         Sale-only entry point is the internal path. After this,
    ///         only the season operator retains a privileged role
    ///         (claim roots + depositRevenue).
    function renounceOwnershipFromSale() external {
        if (msg.sender != saleContract) revert NotSaleContract();
        _transferOwnership(address(0));
    }

    // ------------------------------------------------------------------ tax

    /// @dev Central ERC-20 transfer hook. Applies the 3% tax (in LOA) ONLY
    ///      to transfers where one side is the LP pair (a buy or a sell).
    ///      Wallet-to-wallet transfers pass through untaxed, as do mints/
    ///      burns and exempt-side transfers. Sale distributions and prize
    ///      claims originate from exempt addresses, so they are never taxed.
    ///      While pair is unset (address(0)) the pair check can never
    ///      match, so nothing is taxed.
    function _update(address from, address to, uint256 value) internal override {
        if (
            from == address(0) || to == address(0) || value == 0 || _isTaxExempt(from) || _isTaxExempt(to)
            || (from != pair && to != pair)
        ) {
            super._update(from, to, value);
            return;
        }
        uint256 taxTotal = (value * TAX_BPS) / 10_000;
        uint256 treasuryPart = (value * TAX_TREASURY_BPS) / 10_000;
        uint256 rewardPart = taxTotal - treasuryPart;
        super._update(from, to, value - taxTotal);
        if (treasuryPart > 0) {
            super._update(from, treasuryWallet, treasuryPart);
        }
        if (rewardPart > 0) {
            super._update(from, address(this), rewardPart);
            rewardTokenBucket += rewardPart;
        }
    }

    // ------------------------------------------------------------ reward pool

    /// @notice Anyone may top up the reward pool. This is THE dedicated
    ///         deposit function — the bucket a transfer lands in is decided
    ///         by the function called, never by the sender (user decision
    ///         2026-11-19).
    function depositReward() external payable {
        rewardPoolBNB += msg.value;
        emit RewardDeposited(msg.sender, msg.value);
    }

    /// @notice Deposit game revenue (ad packages + new-hero sales, already
    ///         swapped to BNB off-chain if collected in another token).
    ///         Split automatically: 80% to the reward pool, 20% to the
    ///         operator wallet (user decisions 2026-11-18, destination
    ///         split 2026-11-25). Callable by the owner or the season
    ///         operator, so revenue deposits keep working after ownership
    ///         is renounced.
    function depositRevenue() external payable {
        if (msg.sender != owner() && msg.sender != seasonOperator) {
            revert NotOwnerOrOperator();
        }
        uint256 poolPart = (msg.value * 80) / 100;
        uint256 operatorPart = msg.value - poolPart;
        rewardPoolBNB += poolPart;
        emit RevenueDeposited(msg.sender, poolPart, operatorPart);
        if (operatorPart > 0) {
            (bool ok,) = payable(operatorWallet).call{value: operatorPart}("");
            if (!ok) revert BnbTransferFailed();
        }
    }

    /// @notice Plain BNB transfers are accepted (router refunds land here)
    ///         but are NEVER allocated to any bucket — a plain transfer
    ///         credits neither the pool nor a tier (user decision
    ///         2026-11-19).
    receive() external payable {}

    // ------------------------------------------------------------- tier split

    /// @notice Called by the Sale contract with 65% of a tier-1 revenue
    ///         slice. Routes 55% (of the tier total) into the tier's LP
    ///         bucket and 10% into the reward pool. Sale sends the
    ///         remaining 35% straight to the treasury (25%) and operator
    ///         (10%) wallets itself.
    ///         Only tier 1 (index 0) uses this path — tiers 2-4 stream
    ///         revenue per purchase via receiveTierRevenue() (user
    ///         decision 2026-11-26). `slots` is how many of the tier's
    ///         slots were sold when the split happens: full (10,000) on
    ///         a sellout, partial on a Treasury early pool open (user
    ///         decision 2026-11-26) — the sold count sizes the liquidity
    ///         add proportionally, so it is recorded exactly, never
    ///         assumed to be full.
    /// @param tier Tier index 0–3.
    /// @param slots Slots sold in this tier at split time.
    function receiveTierSplit(uint8 tier, uint256 slots) external payable {
        if (msg.sender != saleContract) revert NotSaleContract();
        if (tier >= TIER_COUNT) revert TierOutOfRange(tier);
        if (tierSplitReceived[tier]) revert TierSplitAlreadyReceived(tier);
        tierSplitReceived[tier] = true;
        tierSoldSlots[tier] = slots;
        uint256 lpPart = (msg.value * 55) / 65;
        uint256 poolPart = msg.value - lpPart;
        tierLPBNB[tier] = lpPart;
        rewardPoolBNB += poolPart;
        emit TierSplitReceived(tier, lpPart, poolPart);
    }

    /// @notice Per-purchase revenue stream for tiers 2-4 (user decision
    ///         2026-11-26, refined 00:38): the Sale forwards 65% of
    ///         EVERY purchase in tiers 1-3 (indexes) as it happens, so
    ///         those tiers split "as they sell" instead of in one lump
    ///         at completion. Routes exactly like receiveTierSplit —
    ///         55/65 of the received value into the tier's LP bucket,
    ///         10/65 into the reward pool — and records the slots sold
    ///         so partial-tier liquidity adds pair proportionally.
    ///         Callable only by the Sale; callable many times per tier.
    function receiveTierRevenue(uint8 tier, uint256 slots) external payable {
        if (msg.sender != saleContract) revert NotSaleContract();
        if (tier >= TIER_COUNT) revert TierOutOfRange(tier);
        tierSplitReceived[tier] = true;
        tierSoldSlots[tier] += slots;
        uint256 lpPart = (msg.value * 55) / 65;
        uint256 poolPart = msg.value - lpPart;
        tierLPBNB[tier] += lpPart;
        rewardPoolBNB += poolPart;
        emit TierRevenueReceived(tier, lpPart, poolPart);
    }

    /// @notice Pair a tier's reserved LOA with its BNB slice on
    ///         PancakeSwap V2. Callable by anyone once the tier's
    ///         split has been delivered. LP tokens are sent to the burn
    ///         address — locked forever (user decision 2026-11-19).
    ///         A COMPLETED tier pairs the full 87,500,000 LOA. A
    ///         PARTIAL tier pairs proportionally — LP_TOKENS_PER_TIER
    ///         x sold / 10,000 — and only after the sale has ended,
    ///         when the sold count is final (calling earlier would
    ///         strand later purchases' LP BNB in a tier whose
    ///         liquidity is already marked done). The unpaired
    ///         remainder of a partial tier's reserve is burned by
    ///         burnUnpairedLPReserve() (user decision 2026-11-26).
    ///         The Sale-only path (addTierLiquidityFromSale) is exempt
    ///         from the sale-end gate: the Sale only calls it when the
    ///         tier is complete (sellout) or CLOSED (Treasury early
    ///         pool open, user decision 2026-11-26), so the sold count
    ///         is final either way.
    /// @dev    Min amounts are 0 for v1 (testnet first; the pre-mainnet
    ///         audit is expected to tighten this — build brief 2026-11-23).
    function addTierLiquidity(uint8 tier) external nonReentrant {
        _addTierLiquidity(tier, false);
    }

    /// @notice Tier 1 (index 0) auto-add: called by the Sale from the
    ///         tier-completing buy() so tier 1's liquidity is added in
    ///         the SAME transaction as its sellout (user decision
    ///         2026-11-26), and from openTier1PoolEarly() so the
    ///         Treasury can open tier 1's pool BEFORE it sells out
    ///         (user decision 2026-11-26, corrected 01:45). Sale-only;
    ///         shares the internal implementation with the manual call.
    ///         (A separate nonReentrant guard lives on each contract,
    ///         so calling this from the Sale's nonReentrant buy() is
    ///         safe.)
    function addTierLiquidityFromSale(uint8 tier) external nonReentrant {
        if (msg.sender != saleContract) revert NotSaleContract();
        _addTierLiquidity(tier, true);
    }

    /// @notice Set the LP pair from the Pancake factory after a liquidity
    ///         add, so the pair-only tax turns on automatically (user
    ///         decision 2026-11-26, "còn lại tự động bật tax"). Set
    ///         ONCE — never overwritten. FAIL-SAFE: if the factory cannot
    ///         be read (a non-standard router, an EOA stand-in, or the
    ///         pair not yet created), the pair stays unset and the
    ///         liquidity add still succeeds; tax simply stays off until
    ///         a later add sets it. (The brief's `router.WBNB()` does not
    ///         exist on the V2 router — the pair is queried with
    ///         `WETH()`, which IS WBNB on BSC.)
    function _setPairFromFactory() internal {
        if (pair != address(0)) return;
        address factory_;
        try IPancakeV2Router(router).factory() returns (address f) {
            factory_ = f;
        } catch {
            return;
        }
        address weth_;
        try IPancakeV2Router(router).WETH() returns (address w) {
            weth_ = w;
        } catch {
            return;
        }
        if (factory_ == address(0) || weth_ == address(0)) return;
        (bool ok, bytes memory ret) = factory_.staticcall(
            abi.encodeWithSignature("getPair(address,address)", address(this), weth_)
        );
        if (!ok || ret.length < 32) return;
        address p = abi.decode(ret, (address));
        if (p != address(0)) {
            pair = p;
            emit PairSet(p);
        }
    }

    function _addTierLiquidity(uint8 tier, bool fromSale) internal {
        if (tier >= TIER_COUNT) revert TierOutOfRange(tier);
        if (!tierSplitReceived[tier]) revert TierSplitNotReceived(tier);
        if (tierLiquidityDone[tier]) revert TierLiquidityAlreadyDone(tier);
        uint256 sold = tierSoldSlots[tier];
        if (sold < SLOTS_PER_TIER && !fromSale) {
            if (!_saleEnded()) revert TierLiquidityTooEarly(tier);
        }
        tierLiquidityDone[tier] = true;
        uint256 bnbAmount = tierLPBNB[tier];
        tierLPBNB[tier] = 0;
        uint256 tokenAmount = (LP_TOKENS_PER_TIER * sold) / SLOTS_PER_TIER;
        tierLPPaired[tier] = tokenAmount;

        _approve(address(this), address(router), tokenAmount);
        router.addLiquidityETH{value: bnbAmount}(
            address(this),
            tokenAmount,
            0,
            0,
            DEAD,
            block.timestamp
        );
        _setPairFromFactory();
        // LAUNCH (user decision 2026-11-26): the launch activates
        // AUTOMATICALLY at the first liquidity add — the first pool IS
        // the launch (30-day seasons run back-to-back from this moment,
        // user decision 2026-11-18: seasons count from game release).
        // No owner activateLaunch() call anymore.
        if (!launched) {
            launched = true;
            launchTime = block.timestamp;
            emit Launched(block.timestamp);
        }
        emit TierLiquidityAdded(tier, tokenAmount, bnbAmount);
    }

    /// @notice Has the sale ended? Read from the Sale contract; a Sale
    ///         that does not answer (e.g. the token tests' EOA stand-in
    ///         for the Sale) counts as "not ended" instead of reverting.
    function _saleEnded() internal view returns (bool) {
        (bool ok, bytes memory ret) = saleContract.staticcall(
            abi.encodeWithSignature("saleEndTime()")
        );
        if (!ok || ret.length < 32) return false;
        uint256 end = abi.decode(ret, (uint256));
        return end != 0 && block.timestamp > end;
    }

    /// @notice Burn the LP reserve that can never be paired (user
    ///         decision 2026-11-26). For each tier: if its liquidity is
    ///         done, the unpaired part is LP_TOKENS_PER_TIER minus what
    ///         was actually paired; if it never received any revenue,
    ///         the whole tier reserve is unpaired. Tiers WITH revenue
    ///         but no liquidity call yet are SKIPPED — their reserve
    ///         must stay so addTierLiquidity can still run later.
    ///         Only after the sale has ended (sold counts and revenue
    ///         are final). Permissionless and idempotent: settled tiers
    ///         are marked and skipped on repeat calls. The Sale calls
    ///         it from its lazy post-end burn (_autoBurnLeftover);
    ///         anyone may call it again after a late addTierLiquidity.
    function burnUnpairedLPReserve() external {
        if (!_saleEnded()) revert SaleNotEnded();
        uint256 total;
        for (uint8 t = 0; t < TIER_COUNT; t++) {
            if (tierLPReserveSettled[t]) continue;
            uint256 unpaired;
            if (tierLiquidityDone[t]) {
                unpaired = LP_TOKENS_PER_TIER - tierLPPaired[t];
            } else if (!tierSplitReceived[t]) {
                unpaired = LP_TOKENS_PER_TIER;
            } else {
                continue;
            }
            tierLPReserveSettled[t] = true;
            total += unpaired;
        }
        if (total > 0) {
            _transfer(address(this), DEAD, total);
            emit LPReserveBurned(total);
        }
    }

    // ---------------------------------------------------------------- seasons

    /// @notice End time of a season (seasons run back-to-back from launch).
    function seasonEndTime(uint256 seasonId) public view returns (uint256) {
        return launchTime + seasonId * SEASON_DURATION;
    }

    /// @notice Close a finished season: locks the season fund and snapshots
    ///         the tax reward-token bucket into the season's prize pool.
    ///         The fund is 50% of the current reward pool, EXCEPT season 1,
    ///         which has a 4 BNB floor (SEASON_ONE_FUND_FLOOR): its fund is
    ///         max(4 BNB, 50% of the pool), capped at the pool balance —
    ///         user decision 2026-11-23 23:02–23:04 (Season 1 special:
    ///         "sàn 4 BNB", the full seed is the prize fund, and the fund
    ///         never drops below 4 BNB while the pool holds that much).
    ///         Permissionless — the timestamps rule it.
    function closeSeason(uint256 seasonId) external {
        if (!launched) revert NotLaunched();
        Season storage s = seasons[seasonId];
        if (s.closeTime != 0) revert SeasonAlreadyClosed(seasonId);
        if (seasonId == 0 || block.timestamp < seasonEndTime(seasonId)) {
            revert SeasonNotEnded(seasonId);
        }
        uint256 fund = (rewardPoolBNB * SEASON_FUND_BPS) / 10_000;
        if (seasonId == 1) {
            // Season-1 floor: at least SEASON_ONE_FUND_FLOOR, but never
            // more than the pool actually holds.
            if (fund < SEASON_ONE_FUND_FLOOR) fund = SEASON_ONE_FUND_FLOOR;
            if (fund > rewardPoolBNB) fund = rewardPoolBNB;
        }
        rewardPoolBNB -= fund;
        s.fundBNB = fund;
        s.closeTime = block.timestamp;
        uint256 snapshot = rewardTokenBucket;
        rewardTokenBucket = 0;
        s.prizeLOA += snapshot;
        emit SeasonClosed(seasonId, fund, snapshot);
    }

    /// @notice Execute the next buyback tranche for a closed season: swaps
    ///         ~1/8 of the locked BNB fund for LOA on PancakeSwap.
    ///         Permissionless; tranches are at least 3h apart and the last
    ///         tranche sweeps whatever BNB remains. Received LOA is added
    ///         to the season's prize pool. The swap is untaxed because
    ///         this contract (the recipient) is tax-exempt.
    function executeBuybackTranche(uint256 seasonId) external nonReentrant {
        Season storage s = seasons[seasonId];
        if (s.closeTime == 0) revert SeasonNotClosed(seasonId);
        if (s.tranchesDone >= TRANCHE_COUNT) revert BuybackComplete(seasonId);
        uint256 nextAllowed = s.tranchesDone == 0
            ? s.closeTime
            : s.lastTrancheTime + TRANCHE_INTERVAL;
        if (block.timestamp < nextAllowed) {
            revert TrancheTooEarly(seasonId, nextAllowed);
        }
        uint8 tranchesLeft = TRANCHE_COUNT - s.tranchesDone;
        uint256 bnbIn = s.fundBNB / tranchesLeft;
        s.fundBNB -= bnbIn;
        s.tranchesDone += 1;
        s.lastTrancheTime = block.timestamp;

        address[] memory path = new address[](2);
        path[0] = router.WETH();
        path[1] = address(this);
        uint256 balanceBefore = balanceOf(address(this));
        router.swapExactETHForTokens{value: bnbIn}(0, path, address(this), block.timestamp);
        uint256 loaOut = balanceOf(address(this)) - balanceBefore;
        s.prizeLOA += loaOut;
        emit BuybackTrancheExecuted(seasonId, s.tranchesDone, bnbIn, loaOut);
    }

    /// @notice Submit the winners' Merkle root for a closed season. Only
    ///         the season operator. Requires the buyback to be complete
    ///         and the 48h anti-cheat review period (off-chain) to have
    ///         passed since close. Opens the 7-day claim window.
    function submitClaimRoot(uint256 seasonId, bytes32 root) external {
        if (msg.sender != seasonOperator) revert NotOwnerOrOperator();
        Season storage s = seasons[seasonId];
        if (s.closeTime == 0) revert SeasonNotClosed(seasonId);
        if (s.claimRoot != bytes32(0)) revert RootAlreadySubmitted(seasonId);
        if (s.tranchesDone < TRANCHE_COUNT) revert BuybackNotComplete(seasonId);
        uint256 earliest = s.closeTime + REVIEW_PERIOD;
        if (block.timestamp < earliest) revert RootTooEarly(seasonId, earliest);
        s.claimRoot = root;
        s.claimDeadline = block.timestamp + CLAIM_WINDOW;
        emit ClaimRootSubmitted(seasonId, root, s.claimDeadline);
    }

    /// @notice Claim a season prize. Leaf =
    ///         keccak256(abi.encodePacked(seasonId, winner, amount)).
    ///         The payout transfer is untaxed (sender is this contract,
    ///         which is tax-exempt).
    function claim(uint256 seasonId, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        Season storage s = seasons[seasonId];
        if (s.claimRoot == bytes32(0)) revert NoClaimRoot(seasonId);
        if (block.timestamp > s.claimDeadline) revert ClaimWindowClosed(seasonId);
        if (prizeClaimed[seasonId][msg.sender]) {
            revert AlreadyClaimed(seasonId, msg.sender);
        }
        bytes32 leaf = keccak256(abi.encodePacked(seasonId, msg.sender, amount));
        if (!MerkleProof.verify(proof, s.claimRoot, leaf)) {
            revert InvalidClaimProof();
        }
        prizeClaimed[seasonId][msg.sender] = true;
        s.claimedLOA += amount;
        _transfer(address(this), msg.sender, amount);
        emit PrizeClaimed(seasonId, msg.sender, amount);
    }

    /// @notice After the claim window, return any unclaimed prize LOA to
    ///         the reward-token bucket for future seasons (user decision
    ///         2026-11-17). Permissionless.
    function sweepUnclaimed(uint256 seasonId) external {
        Season storage s = seasons[seasonId];
        if (s.claimRoot == bytes32(0)) revert NoClaimRoot(seasonId);
        if (block.timestamp <= s.claimDeadline) {
            revert ClaimWindowStillOpen(seasonId);
        }
        if (s.swept) revert AlreadySwept(seasonId);
        s.swept = true;
        uint256 unclaimed = s.prizeLOA - s.claimedLOA;
        if (unclaimed > 0) {
            rewardTokenBucket += unclaimed;
        }
        emit UnclaimedSwept(seasonId, unclaimed);
    }
}
