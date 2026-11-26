// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import "./interfaces/IPancakeV2Router.sol"; // IAgentIDRegistry, ILoginPassNFT

/// @notice Minimal surface of LeagueOfAgentToken used by the Sale.
interface ILeagueOfAgentToken {
    function receiveTierSplit(uint8 tier, uint256 slots) external payable;
    function receiveTierRevenue(uint8 tier, uint256 slots) external payable;
    function addTierLiquidityFromSale(uint8 tier) external;
    function burnUnpairedLPReserve() external;
    function renounceOwnershipFromSale() external;
}

/// @title League Of Agent — LOA mint sale (4 paid tiers + 500 whitelist)
/// @notice Sells the 650,000,000 LOA mint share held for it by the token
///         contract: 40,000 paid slots in 4 tiers + 200 FCFS whitelist
///         slots + 300 Guarantee whitelist slots = 40,500 slots, each worth
///         TOKENS_PER_SLOT LOA (user decisions 2026-11-17 → 2026-11-23;
///         whitelist compressed from 800 to 500 on 2026-11-23).
///         All three tranches open at the same mint start.
///         Paid pricing (FINAL — user decision 2026-11-23 22:45,
///         superseding the same-day 18:20/18:23 schemes): ALL 4 tiers
///         flat 0.004 BNB/slot. Per-tier revenue is fixed at 40 BNB,
///         max total raise 160 BNB, and a tier's split (55% LP / 10%
///         reward pool / 25% treasury / 10% operator = 22 / 4 / 10 / 4
///         BNB) applies to its gross BNB. The treasury's 25% share funds
///         the 5% referral rewards already paid out of the tier during
///         the sale (user decision 2026-11-25): a fully-referred tier
///         splits 22 / 4 / 8 / 4 / 2 (LP / pool / treasury / operator /
///         referrers). SPLIT TIMING (user decision 2026-11-26): tier 1
///         splits in one lump at completion and auto-adds its LP in the
///         completing transaction; tiers 2-4 split the same ratios PER
///         PURCHASE, as they sell. The Treasury may ALSO open tier 1's
///         pool EARLY, before it sells out (user decision 2026-11-26,
///         corrected 01:45 — "mở pool sớm" means adding tier-1 liquidity
///         early, NOT changing sale times): the partial split + LP add
///         happen at once and tier 1 closes. If tier 1 never sells out
///         AND is never opened early, its buyers get a 90% refund
///         (tokens returned) from sale end + 7 days — an early open
///         CANCELS the refund (the BNB is in the pool).
/// @dev    Deployment order resolves the Token<->Sale circular dependency:
///         deploy THIS contract first, then the token (whose constructor
///         takes this contract's address and mints the share to it), then
///         call setToken() here once.
contract LeagueOfAgentSale is Ownable, ReentrancyGuard {
    // ------------------------------------------------------------ constants

    uint256 public constant TOTAL_SLOTS = 40_500;
    /// @notice LOA per slot: floor(650,000,000 / 40,500) ≈ 16,049.38 LOA
    ///         (rounding rule — user-open point 2026-11-23, resolved in the
    ///         build brief: integer floor; the division dust stays in this
    ///         contract and is burned automatically by _autoBurnLeftover()
    ///         on the first post-sale-end touch, together with the tokens
    ///         of all unminted slots).
    uint256 public constant TOKENS_PER_SLOT = (650_000_000 * 1e18) / TOTAL_SLOTS;

    uint8 public constant TIER_COUNT = 4;
    uint256 public constant SLOTS_PER_TIER = 10_000;
    uint256 public constant FCFS_SLOTS = 200;
    uint256 public constant GUARANTEE_SLOTS = 300;
    /// @notice Hard per-wallet Guarantee cap (user decision 2026-11-23, cut
    ///         5 -> 1 by user decision 2026-11-25): a Guarantee wallet can
    ///         never claim more than 1 slot, even if its Merkle leaf
    ///         carries a larger maxSlots — the effective cap in
    ///         claimGuarantee() is min(leaf maxSlots, GUARANTEE_MAX_PER_WALLET),
    ///         so a mis-generated Guarantee list cannot over-allocate.
    uint256 public constant GUARANTEE_MAX_PER_WALLET = 1;

    /// @notice Per-wallet paid purchase limit (user decision 2026-11-24):
    ///         PAID_BASE_LIMIT slots across ALL paid tiers combined —
    ///         FIXED. Referrals used to raise it (+10 per direct referral,
    ///         uncapped); that quota bonus was REMOVED by user decision
    ///         2026-11-25 and replaced by a 5% BNB referral reward (see
    ///         REFERRAL_REWARD_BPS). paidLimitOf() always returns this.
    uint256 public constant PAID_BASE_LIMIT = 10;
    /// @notice Referral reward (user decision 2026-11-25): the
    ///         recorded referrer is PAID 5% of the BNB cost of EVERY
    ///         paid purchase the buyer makes, immediately inside the
    ///         same buy() transaction (best-effort — a referrer that
    ///         cannot receive BNB never bricks the buy). Funded out
    ///         of the treasury's 25% share — never the reward pool.
    ///         Single level only. (A deferred/claim variant was
    ///         ordered 2026-11-25 23:16 and REVERSED by the user at
    ///         23:21 — payment is immediate, never waits for the pool.)
    uint256 public constant REFERRAL_REWARD_BPS = 500;

    /// @notice Tier 1 (index 0) refund terms (user decision 2026-11-26):
    ///         if tier 1 has NOT sold out when the sale ends, each tier-1
    ///         buyer may claim back 90% of the BNB they paid — but only
    ///         by returning ALL the LOA they bought in tier 1. Claims
    ///         open IMMEDIATELY at sale end (no waiting period) and close
    ///         7 days later (claimable from saleEndTime until
    ///         saleEndTime + REFUND_WINDOW).
    uint256 public constant REFUND_BPS = 9000; // 90%
    uint256 public constant REFUND_WINDOW = 7 days;

    /// @notice Burn address — the Sale's remaining LOA is sent here by
    ///         _autoBurnLeftover() (unminted slots + rounding dust), and
    ///         tier-1 refund tokens go here directly from the buyer.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // --------------------------------------------------------------- errors

    error ZeroAddress();
    error TokenAlreadySet();
    error TokenNotSet();
    error SaleNotStarted();
    error SaleEnded();
    error TierOutOfRange(uint8 tier);
    error ZeroSlots();
    error TierSoldOut(uint8 tier);
    error WrongPayment(uint256 expected, uint256 actual);
    error AgentIDRequired(address wallet);
    error PaidLimitExceeded(address wallet, uint256 limit);
    error LoginPassRequired(address wallet);
    error InvalidMerkleProof();
    error FcfsAlreadyClaimed(address wallet);
    error FcfsSoldOut();
    error GuaranteeCapExceeded(address wallet);
    error GuaranteeSoldOut();
    error SaleAlreadyStarted();
    error SaleNotEnded();
    error RefundTierNotSupported(uint8 tier);
    error RefundNotAvailable(uint8 tier);
    error RefundWindowClosed();
    error AlreadyRefunded(address wallet);
    error NoPurchaseToRefund(address wallet);
    error RefundWindowStillOpen();
    error BnbTransferFailed();
    error NotTreasury(address caller);
    error Tier1NoSales();
    error TierClosed(uint8 tier);

    // --------------------------------------------------------------- events

    event TokenSet(address indexed token);
    event GuaranteeRootSet(bytes32 guaranteeRoot);
    event SaleTimesSet(uint256 startTime, uint256 endTime);
    event TierPurchase(address indexed buyer, uint8 indexed tier, uint256 slots, uint256 cost);
    event ReferralRecorded(address indexed referrer, address indexed buyer);
    event ReferralRewardPaid(address indexed referrer, address indexed buyer, uint8 indexed tier, uint256 reward);
    event ReferralRewardFailed(address indexed referrer, address indexed buyer, uint8 indexed tier, uint256 reward);
    event TierCompleted(uint8 indexed tier, uint256 totalBNB);
    event Tier1PoolOpenedEarly(uint256 soldSlots, uint256 grossBNB);
    event FcfsClaimed(address indexed wallet);
    event GuaranteeClaimed(address indexed wallet, uint256 slots);
    event RefundClaimed(address indexed buyer, uint8 indexed tier, uint256 refundBNB, uint256 tokensReturned);
    event ExpiredRefundsSwept(uint256 amount);
    event LeftoverBurned(uint256 amount);

    // ---------------------------------------------------------------- state

    /// @notice Per-tier price per slot in wei (BNB): ALL tiers flat
    ///         0.004 (final pricing — user decision 2026-11-23 22:45).
    uint256[TIER_COUNT] public tierPrices = [0.004 ether, 0.004 ether, 0.004 ether, 0.004 ether];

    IERC20 public token;
    /// @notice The treasury wallet (marketing). Receives the 25%
    ///         tier-revenue slice on tier completion. Split from the old
    ///         single shared wallet by user decision 2026-11-25.
    address public immutable treasuryWallet;
    /// @notice The operator wallet. Receives the 10% tier-revenue
    ///         slice on tier completion. Split from the old single
    ///         shared wallet by user decision 2026-11-25.
    address public immutable operatorWallet;
    IAgentIDRegistry public immutable agentIDRegistry;
    ILoginPassNFT public immutable loginPassNFT;

    uint256 public saleStartTime; // 0 = not set
    uint256 public saleEndTime; // 0 = not set
    /// @notice The Guarantee whitelist Merkle root. FCFS has NO Merkle root
    ///         (user decision 2026-11-25): FCFS eligibility is only
    ///         "holds a Login Pass NFT + holds an Agent ID", checked
    ///         on-chain at claim time — no pre-registration, no list.
    bytes32 public guaranteeRoot;

    uint256[TIER_COUNT] public tierSold;
    uint256[TIER_COUNT] public tierBNB;
    bool[TIER_COUNT] public tierCompleted;

    mapping(address => bool) public fcfsClaimed;
    uint256 public fcfsClaimedCount;
    mapping(address => uint256) public guaranteeClaimedSlots;
    uint256 public guaranteeClaimedCount;

    /// @notice Paid slots bought per wallet, summed across ALL paid tiers
    ///         (fixed per-wallet paid cap — user decision 2026-11-24;
    ///         referrals stopped raising it on 2026-11-25).
    ///         Whitelist free mints (FCFS/Guarantee) never touch this counter:
    ///         they sit completely outside the referral system.
    mapping(address => uint256) public paidSlotsBought;
    /// @notice The referrer recorded for a buyer — set exactly once, at
    ///         the buyer's first-ever paid purchase, and never changed.
    mapping(address => address) public referrerOf;
    /// @notice How many direct referrals a wallet has been credited with
    ///         (single level only — invitees' own referrals credit only
    ///         the invitees, never flow up).
    mapping(address => uint256) public referralCount;
    /// @notice Every wallet that has been credited with at least one
    ///         referral, in first-credit order. Exists so the Mint page
    ///         can enumerate referrers for the referral leaderboard
    ///         (a mapping alone cannot be listed).
    address[] public referrers;
    /// @notice BNB already paid out to referrers from a tier (5% of
    ///         the tier's referred purchases, paid immediately in each
    ///         buy). At completion the gross is tierBNB[tier] +
    ///         tierReferrerPaid[tier]; the treasury receives
    ///         tierBNB[tier] minus the 65% token / 10% operator
    ///         slices (i.e. 25% of gross minus rewards already paid).
    mapping(uint8 => uint256) public tierReferrerPaid;
    /// @notice Cumulative BNB PAID to each referrer across all tiers
    ///         — the leaderboard's "BNB earned" column (user decision
    ///         2026-11-25).
    mapping(address => uint256) public referralRewardsEarned;
    /// @notice Gross BNB paid per buyer per tier (before any referrer
    ///         reward left the tier) — the base for tier-1 refunds.
    mapping(uint8 => mapping(address => uint256)) public tierPaidBNB;
    /// @notice LOA bought per buyer per tier — a tier-1 refund requires
    ///         returning exactly this amount.
    mapping(uint8 => mapping(address => uint256)) public tierTokensBought;
    /// @notice 90% of each tier-1 purchase, accumulated per buyer —
    ///         the exact refundable amount (accumulated per purchase so
    ///         the liability total below always matches the sum of
    ///         outstanding refunds exactly).
    mapping(uint8 => mapping(address => uint256)) public tierRefundable;
    /// @notice Whether a buyer already claimed their tier refund
    ///         (one refund per buyer per tier).
    mapping(uint8 => mapping(address => bool)) public tierRefunded;
    /// @notice Total outstanding tier-1 refund liability (90% of all
    ///         tier-1 purchases, net of refunds already paid). The
    ///         contract always holds at least this much tier-1 BNB:
    ///         refunds are 90% while at most 5% left the tier as
    ///         referrer rewards, so solvency holds by construction.
    ///         Unclaimed refunds sweep to the treasury via
    ///         sweepExpiredRefunds() once the window closes.
    uint256 public tier1RefundLiability;

    /// @notice True once ownership of this Sale (and of the Token, via
    ///         the Sale) has been renounced at the first mint after the
    ///         sale opens (user decision 2026-11-26: "renounce khi mở
    ///         mint"). After that, the only owner power left —
    ///         setGuaranteeRoot — is frozen along with everything else.
    bool public ownershipRenounced;

    /// @notice True once the lazy post-sale burn has run
    ///         (_autoBurnLeftover): the Sale's leftover LOA is burned
    ///         exactly once, on the first post-sale-end touch.
    bool public leftoverBurned;

    // ----------------------------------------------------------- constructor

    /// @param initialOwner_   The contract owner (the deployer EOA). MUST be
    ///                        passed explicitly — NEVER Ownable(msg.sender):
    ///                        a CREATE2 deploy through the deterministic
    ///                        proxy makes msg.sender the PROXY, not the
    ///                        deployer, and an owner nobody controls would
    ///                        brick setToken()/setSaleTimes()/
    ///                        setGuaranteeRoot() forever. OZ Ownable reverts
    ///                        on address(0) itself.
    /// @param treasuryWallet_   Treasury wallet (marketing): 25% tier slice.
    /// @param operatorWallet_ Operator wallet: 10% tier slice.
    /// @param agentIDRegistry_ SPACE ID Agent ID registry (mainnet:
    ///                         0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F).
    /// @param loginPassNFT_    The Login Pass NFT contract.
    constructor(
        address initialOwner_,
        address treasuryWallet_,
        address operatorWallet_,
        address agentIDRegistry_,
        address loginPassNFT_
    ) Ownable(initialOwner_) {
        if (
            treasuryWallet_ == address(0) || operatorWallet_ == address(0)
                || agentIDRegistry_ == address(0) || loginPassNFT_ == address(0)
        ) {
            revert ZeroAddress();
        }
        treasuryWallet = treasuryWallet_;
        operatorWallet = operatorWallet_;
        agentIDRegistry = IAgentIDRegistry(agentIDRegistry_);
        loginPassNFT = ILoginPassNFT(loginPassNFT_);
    }

    // ------------------------------------------------------------ owner admin

    /// @notice Point this Sale at its token. Owner-only, one-time; call it
    ///         after the token is deployed (the token constructor mints
    ///         the 650M mint share to this contract's address).
    function setToken(address token_) external onlyOwner {
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (token_ == address(0)) revert ZeroAddress();
        token = IERC20(token_);
        emit TokenSet(token_);
    }

    /// @notice Set the Guarantee whitelist Merkle root. Updatable until mint
    ///         start. Guarantee leaves are (wallet, maxSlots) pairs so each
    ///         Guarantee's allocation stays private and can differ per wallet
    ///         (user decision 2026-11-23: Guarantee list and per-wallet
    ///         conditions are not published — only the root goes
    ///         on-chain). FCFS has no root: it needs no list at all
    ///         (user decision 2026-11-25 — NFT + Agent ID only).
    function setGuaranteeRoot(bytes32 guaranteeRoot_) external onlyOwner {
        _requireNotStarted();
        guaranteeRoot = guaranteeRoot_;
        emit GuaranteeRootSet(guaranteeRoot_);
    }

    /// @notice Set the mint start / end. All tranches open together at the
    ///         start time (user decision 2026-11-17). Owner-only.
    ///         (A narrow saleTimeSetter role existed briefly on 2026-11-26
    ///         and was REMOVED the same day — it was built on a misreading
    ///         of "mở pool sớm", which means opening tier 1's liquidity
    ///         pool early, NOT changing sale times; see
    ///         openTier1PoolEarly().)
    function setSaleTimes(uint256 startTime_, uint256 endTime_) external onlyOwner {
        _requireNotStarted();
        saleStartTime = startTime_;
        saleEndTime = endTime_;
        emit SaleTimesSet(startTime_, endTime_);
    }

    function _requireNotStarted() internal view {
        if (saleStartTime != 0 && block.timestamp >= saleStartTime) {
            revert SaleAlreadyStarted();
        }
    }

    function _requireSaleOpen() internal view {
        if (address(token) == address(0)) revert TokenNotSet();
        if (saleStartTime == 0 || block.timestamp < saleStartTime) {
            revert SaleNotStarted();
        }
        if (saleEndTime != 0 && block.timestamp > saleEndTime) revert SaleEnded();
    }

    /// @dev Agent ID gate — user rule 2026-11-23: paid tiers and the FCFS
    ///      whitelist may only be bought/claimed by wallets that HOLD a
    ///      Binance Agent ID (balanceOf > 0 on the SPACE ID registry).
    function _requireAgentID(address wallet) internal view {
        if (agentIDRegistry.balanceOf(wallet) == 0) {
            revert AgentIDRequired(wallet);
        }
    }

    /// @notice Renounce ownership of BOTH this Sale and the Token at the
    ///         first successful mint after the sale opens (user decision
    ///         2026-11-26: "giữ lại quyền add whitelist thôi, renounce
    ///         khi mở mint"). Called at the END of buy() / claimFCFS() /
    ///         claimGuarantee(), AFTER the tokens have been distributed.
    ///         Runs exactly once (ownershipRenounced flag). Ownable's
    ///         renounceOwnership() is onlyOwner, so it cannot be called
    ///         from a buyer-triggered mint — this uses the internal
    ///         ownership transfer instead, and the Token exposes a
    ///         Sale-only renounce for the same reason. Consequence the
    ///         user accepted: the Guarantee list must be final BEFORE
    ///         the sale opens — after the first mint nobody can change
    ///         the root (setGuaranteeRoot is onlyOwner and the owner is
    ///         address(0) from then on).
    function _autoRenounce() internal {
        if (ownershipRenounced) return;
        ownershipRenounced = true;
        if (address(token) != address(0)) {
            ILeagueOfAgentToken(address(token)).renounceOwnershipFromSale();
        }
        _transferOwnership(address(0));
    }

    /// @notice Burn this contract's leftover LOA automatically (user
    ///         decision 2026-11-26: "burn tự động mà" — no manual
    ///         finalize call). Runs on the FIRST post-sale-end touch
    ///         (claimRefund / sweepExpiredRefunds) and exactly once:
    ///         the tokens of every unminted slot (paid, FCFS and
    ///         Guarantee) plus the per-slot division dust go to DEAD,
    ///         and the Token's unpaired LP reserve burns too (it skips
    ///         tiers with revenue but no liquidity call yet, so a later
    ///         addTierLiquidity is never stranded). A contract cannot
    ///         self-execute on a clock, so "automatic" here means the
    ///         first post-end interaction triggers it; until then the
    ///         leftover LOA sits in this contract and nobody can move
    ///         it (buy/claim are closed after sale end).
    function _autoBurnLeftover() internal {
        if (leftoverBurned) return;
        if (saleEndTime == 0 || block.timestamp <= saleEndTime) return;
        leftoverBurned = true;
        uint256 remaining = token.balanceOf(address(this));
        if (remaining > 0) {
            token.transfer(DEAD, remaining);
            emit LeftoverBurned(remaining);
        }
        ILeagueOfAgentToken(address(token)).burnUnpairedLPReserve();
    }

    // -------------------------------------------------------------- paid tiers

    /// @notice Exact BNB cost of buying `slots` slots in `tier`:
    ///         simply the tier's per-slot price times the slot count.
    ///         The Mint site quotes buys with this view. Tier
    ///         availability is NOT checked here — buy() enforces it.
    function quoteCost(uint8 tier, uint256 slots) public view returns (uint256) {
        if (tier >= TIER_COUNT) revert TierOutOfRange(tier);
        return tierPrices[tier] * slots;
    }

    /// @notice A wallet's paid purchase limit: FIXED at PAID_BASE_LIMIT
    ///         (10 slots across ALL paid tiers combined). Referrals no
    ///         longer raise it (quota bonus removed 2026-11-25; the
    ///         referral reward is now 5% BNB, see REFERRAL_REWARD_BPS).
    function paidLimitOf(address wallet) public view returns (uint256) {
        // `wallet` is intentionally unused: the limit is the same for
        // every wallet (kept in the signature for interface stability).
        wallet;
        return PAID_BASE_LIMIT;
    }

    /// @notice How many wallets have been credited with at least one
    ///         referral (length of the leaderboard list).
    function totalReferrers() public view returns (uint256) {
        return referrers.length;
    }

    /// @notice One page of the referral leaderboard source data:
    ///         referrer wallets with their successful-referral counts
    ///         AND the BNB each has earned in referral rewards
    ///         (PAID — rewards are paid immediately in each buy, see
    ///         buy()), plus the total number of referrers. `limit` is
    ///         clamped to 100; an offset past the end returns empty
    ///         arrays. Ranking itself (sorting by count) is done by
    ///         the reader.
    function getReferrers(uint256 offset, uint256 limit)
        public
        view
        returns (address[] memory wallets, uint256[] memory counts, uint256[] memory rewards, uint256 total)
    {
        total = referrers.length;
        if (offset >= total) {
            return (new address[](0), new uint256[](0), new uint256[](0), total);
        }
        uint256 pageSize = limit > 100 ? 100 : limit;
        uint256 remaining = total - offset;
        if (pageSize > remaining) pageSize = remaining;
        wallets = new address[](pageSize);
        counts = new uint256[](pageSize);
        rewards = new uint256[](pageSize);
        for (uint256 i = 0; i < pageSize; i++) {
            address wallet = referrers[offset + i];
            wallets[i] = wallet;
            counts[i] = referralCount[wallet];
            rewards[i] = referralRewardsEarned[wallet];
        }
        return (wallets, counts, rewards, total);
    }

    /// @notice Buy `slots` slots of a paid tier.
    ///         Per-wallet purchase cap (user decision 2026-11-24): a wallet
    ///         may buy at most paidLimitOf(wallet) = PAID_BASE_LIMIT (10)
    ///         slots across ALL paid tiers combined. The cap is FIXED —
    ///         referrals no longer raise it (quota bonus removed
    ///         2026-11-25). The cap is a purchase limit, not a reservation.
    ///         Referral reward (user decision 2026-11-25, FINAL
    ///         23:21): the `referrer` passed here is recorded exactly
    ///         ONCE per buyer, at the buyer's first-ever paid
    ///         purchase. From then on the recorded referrer is PAID
    ///         5% of the BNB cost of EVERY paid purchase the buyer
    ///         makes (including this first one), immediately inside
    ///         this same buy() transaction, best-effort: if the
    ///         referrer cannot receive BNB the buy still succeeds
    ///         and the 5% stays in the tier (it flows to the treasury
    ///         at completion). The reward is funded out of the
    ///         treasury's 25% share, never the reward pool.
    ///         Self-referral and the zero address are ignored (never
    ///         recorded, never revert the buy); later buys never change
    ///         the recorded referrer. Whitelist free mints (FCFS/Guarantee)
    ///         are completely outside this system — they neither
    ///         consume the paid limit nor count as a first paid
    ///         purchase.
    ///         Requires holding a Binance Agent ID (user rule 2026-11-23).
    ///         msg.value must equal the tier price times the slot count
    ///         exactly; overpaying reverts just like underpaying.
    ///         Tokens are delivered immediately. SPLIT TIMING (user
    ///         decision 2026-11-26): tier 1 (index 0) escrows its BNB in
    ///         this contract and splits in one lump when it completes —
    ///         55% LP / 10% reward pool (both via the token contract),
    ///         10% to operator, remainder to treasury (25% of gross
    ///         minus referrer rewards already paid) — and adds its LP
    ///         in the same completing transaction. Tiers 2-4 split the
    ///         SAME ratios per purchase, as they sell: 65% of each
    ///         purchase to the Token, 10% to operator, remainder to
    ///         the treasury. If tier 1 never sells out, its buyers may
    ///         claim a 90% refund after the sale ends (see claimRefund).
    ///         (User decisions 2026-11-18, split 2026-11-25, referral
    ///         reward 2026-11-25, immediate payment FINAL 2026-11-25
    ///         23:21.)
    /// @dev Split tier 1's escrowed BNB — shared by the sellout path in
    ///      buy() and by openTier1PoolEarly(). Same completion formula on
    ///      the gross (tierBNB[0] + tierReferrerPaid[0]): 65% to the Token
    ///      via receiveTierSplit (55% LP + 10% pool inside), 10% to
    ///      operator, remainder to treasury (25% of gross minus
    ///      referrer rewards already paid at mint). The sold count passed
    ///      to the Token is tierSold[0] — full (10,000) on a sellout,
    ///      partial on an early open — so the liquidity add pairs
    ///      proportional tokens. Zeroes tierBNB[0] and tierReferrerPaid[0].
    ///      Returns the gross BNB split.
    function _splitTier1() internal returns (uint256 gross) {
        gross = tierBNB[0] + tierReferrerPaid[0];
        uint256 toToken = (gross * 65) / 100; // 55% LP + 10% reward pool
        uint256 toOperator = (gross * 10) / 100; // 10% operator
        // Remainder of the tier's NET balance: 25% of gross minus
        // referrer rewards already paid out during the sale — the
        // treasury's share funds the rewards.
        uint256 toTreasury = tierBNB[0] - toToken - toOperator;
        tierBNB[0] = 0;
        tierReferrerPaid[0] = 0;
        ILeagueOfAgentToken(address(token)).receiveTierSplit{value: toToken}(0, tierSold[0]);
        (bool ok,) = payable(treasuryWallet).call{value: toTreasury}("");
        if (!ok) revert BnbTransferFailed();
        (ok,) = payable(operatorWallet).call{value: toOperator}("");
        if (!ok) revert BnbTransferFailed();
    }

    function buy(uint8 tier, uint256 slots, address referrer) external payable nonReentrant {
        _requireSaleOpen();
        if (tier >= TIER_COUNT) revert TierOutOfRange(tier);
        // Tier 1 closes early when the Treasury opens its pool
        // (openTier1PoolEarly) — no further tier-1 buys after that.
        // A sellout still reports TierSoldOut (as before); only an
        // early-open closure reports TierClosed.
        if (tier == 0 && tierCompleted[0]) {
            if (tierSold[0] >= SLOTS_PER_TIER) revert TierSoldOut(0);
            revert TierClosed(0);
        }
        if (slots == 0) revert ZeroSlots();
        _requireAgentID(msg.sender);
        if (tierSold[tier] + slots > SLOTS_PER_TIER) revert TierSoldOut(tier);
        uint256 cost = tierPrices[tier] * slots;
        if (msg.value != cost) revert WrongPayment(cost, msg.value);
        uint256 limit = paidLimitOf(msg.sender);
        if (paidSlotsBought[msg.sender] + slots > limit) {
            revert PaidLimitExceeded(msg.sender, limit);
        }

        bool firstPaid = paidSlotsBought[msg.sender] == 0;
        paidSlotsBought[msg.sender] += slots;
        tierSold[tier] += slots;
        tierBNB[tier] += msg.value;
        // Per-buyer records (tier-1 refunds need them): gross BNB paid,
        // LOA bought, and the 90% refundable amount accumulated per
        // purchase (user decision 2026-11-26).
        tierPaidBNB[tier][msg.sender] += msg.value;
        tierTokensBought[tier][msg.sender] += slots * TOKENS_PER_SLOT;
        if (tier == 0) {
            uint256 refundable = (msg.value * REFUND_BPS) / 10_000;
            tierRefundable[tier][msg.sender] += refundable;
            tier1RefundLiability += refundable;
        }
        emit TierPurchase(msg.sender, tier, slots, cost);

        if (
            firstPaid && referrer != address(0) && referrer != msg.sender
                && referrerOf[msg.sender] == address(0)
        ) {
            referrerOf[msg.sender] = referrer;
            if (referralCount[referrer] == 0) {
                referrers.push(referrer);
            }
            referralCount[referrer] += 1;
            emit ReferralRecorded(referrer, msg.sender);
        }

        // Referral reward (user decision 2026-11-25, FINAL 23:21):
        // the buyer's recorded referrer is PAID 5% of this purchase's
        // BNB cost right here, in this same transaction — best-effort.
        // All purchase state above is already updated, so a referrer
        // that cannot receive BNB can never brick the invitee's buy:
        // on failure only ReferralRewardFailed is emitted and the 5%
        // stays in the tier (it flows to the treasury at completion).
        address ref = referrerOf[msg.sender];
        if (ref != address(0)) {
            uint256 reward = (msg.value * REFERRAL_REWARD_BPS) / 10_000;
            (bool ok,) = payable(ref).call{value: reward}("");
            if (ok) {
                tierBNB[tier] -= reward;
                tierReferrerPaid[tier] += reward;
                referralRewardsEarned[ref] += reward;
                emit ReferralRewardPaid(ref, msg.sender, tier, reward);
            } else {
                emit ReferralRewardFailed(ref, msg.sender, tier, reward);
            }
        }

        token.transfer(msg.sender, slots * TOKENS_PER_SLOT);

        // Tiers 2-4 split PER PURCHASE (user decision 2026-11-26,
        // refined 00:38): this purchase's BNB is routed immediately —
        // 65% to the Token (which buckets 55% LP + 10% pool
        // internally), 10% to operator, the remainder (25% minus
        // any referrer reward already paid) to the treasury. Nothing
        // stays in the tier: tierBNB[tier] returns to 0.
        if (tier != 0) {
            uint256 toToken = (msg.value * 65) / 100;
            uint256 toOperator = (msg.value * 10) / 100;
            uint256 toTreasury = tierBNB[tier] - toToken - toOperator;
            tierBNB[tier] = 0;
            ILeagueOfAgentToken(address(token)).receiveTierRevenue{value: toToken}(tier, slots);
            (bool ok,) = payable(treasuryWallet).call{value: toTreasury}("");
            if (!ok) revert BnbTransferFailed();
            (ok,) = payable(operatorWallet).call{value: toOperator}("");
            if (!ok) revert BnbTransferFailed();
        }

        if (tierSold[tier] == SLOTS_PER_TIER && !tierCompleted[tier]) {
            tierCompleted[tier] = true;
            if (tier == 0) {
                uint256 gross = _splitTier1();
                emit TierCompleted(tier, gross);
                // RULE A (user decision 2026-11-26): tier 1 auto-adds its
                // liquidity in this same transaction — no manual call
                // needed (and no second call possible afterwards).
                ILeagueOfAgentToken(address(token)).addTierLiquidityFromSale(tier);
            } else {
                // Tiers 2-4 already split per purchase; completion just
                // closes the tier. Gross = total collected (sold x price).
                emit TierCompleted(tier, tierSold[tier] * tierPrices[tier]);
            }
        }

        // First mint after the sale opens renounces ownership of both
        // contracts (user decision 2026-11-26) — after the tokens above
        // have been distributed.
        _autoRenounce();
    }

    /// @notice Open tier 1's liquidity pool EARLY (user decision
    ///         2026-11-26, corrected 01:45 — "mở pool sớm" means adding
    ///         tier-1 liquidity BEFORE 10,000 slots sell, NOT changing
    ///         sale times; user tap 01:48: the TREASURY wallet triggers
    ///         it). Callable ONLY by the Treasury wallet, ONLY while the
    ///         sale is running, ONLY if tier 1 has sold at least 1 slot
    ///         and has not sold out. In one transaction: splits tier 1's
    ///         collected BNB so far (same completion formula on the
    ///         partial gross, via _splitTier1), adds its liquidity
    ///         immediately (proportional tokens), and CLOSES tier 1 to
    ///         further purchases. ONE-WAY: the 90% refund is CANCELLED —
    ///         the BNB is in the pool now — claimRefund(0) reverts (it
    ///         already guards on tierCompleted[0]) and the refund
    ///         liability is zeroed so no refund can ever be owed.
    function openTier1PoolEarly() external nonReentrant {
        if (msg.sender != treasuryWallet) revert NotTreasury(msg.sender);
        if (address(token) == address(0)) revert TokenNotSet();
        if (saleStartTime == 0 || block.timestamp < saleStartTime) {
            revert SaleNotStarted();
        }
        if (saleEndTime != 0 && block.timestamp > saleEndTime) revert SaleEnded();
        if (tierCompleted[0]) revert TierClosed(0);
        if (tierSold[0] == 0) revert Tier1NoSales();
        if (tierSold[0] >= SLOTS_PER_TIER) revert TierSoldOut(0);
        tierCompleted[0] = true;
        uint256 gross = _splitTier1();
        // Refunds are cancelled by the early open — close the liability
        // out (claimRefund already reverts on tierCompleted[0]).
        tier1RefundLiability = 0;
        emit TierCompleted(0, gross);
        emit Tier1PoolOpenedEarly(tierSold[0], gross);
        ILeagueOfAgentToken(address(token)).addTierLiquidityFromSale(0);
    }

    // ------------------------------------------------------------------- FCFS

    /// @notice Claim the wallet's single free FCFS whitelist slot.
    ///         Requires ONLY (checked on-chain at claim time, user
    ///         decision 2026-11-25 — the pre-registration requirement
    ///         was REMOVED):
    ///           - it holds a Login Pass NFT,
    ///           - it holds a Binance Agent ID (user rule 2026-11-23).
    ///         NO Merkle proof, NO list, NO priority window: any
    ///         wallet meeting the two on-chain conditions may claim,
    ///         first-come-first-served until the 200 slots run out.
    ///         One slot per wallet (fcfsClaimed), free mint (0 BNB).
    function claimFCFS() external nonReentrant {
        _requireSaleOpen();
        if (fcfsClaimed[msg.sender]) revert FcfsAlreadyClaimed(msg.sender);
        if (fcfsClaimedCount >= FCFS_SLOTS) revert FcfsSoldOut();
        if (!loginPassNFT.hasLoginPass(msg.sender)) {
            revert LoginPassRequired(msg.sender);
        }
        _requireAgentID(msg.sender);

        fcfsClaimed[msg.sender] = true;
        fcfsClaimedCount += 1;
        token.transfer(msg.sender, TOKENS_PER_SLOT);
        emit FcfsClaimed(msg.sender);
        // First mint after the sale opens renounces ownership of both
        // contracts (user decision 2026-11-26).
        _autoRenounce();
    }

    // -------------------------------------------------------------------- Guarantee

    /// @notice Claim free Guarantee whitelist slots. The Merkle leaf binds
    ///         (wallet, maxSlots): the per-wallet cap travels inside the
    ///         leaf, so individual Guarantee allocations are never published and
    ///         can differ per wallet (user decision 2026-11-23).
    ///         The effective cap is min(leaf maxSlots, GUARANTEE_MAX_PER_WALLET):
    ///         the hard contract-level cap of 1 slot per wallet (user
    ///         decision 2026-11-23, cut from 5 to 1 on 2026-11-25)
    ///         applies on top of the leaf, so even a mis-generated list
    ///         can never grant a wallet more than 1 slot.
    ///         NO Login Pass / Agent ID condition for Guarantee (unchanged rule).
    function claimGuarantee(uint256 slots, uint256 maxSlots, bytes32[] calldata proof)
        external
        nonReentrant
    {
        _requireSaleOpen();
        if (slots == 0) revert ZeroSlots();
        bytes32 leaf = keccak256(abi.encodePacked(msg.sender, maxSlots));
        if (!MerkleProof.verify(proof, guaranteeRoot, leaf)) {
            revert InvalidMerkleProof();
        }
        uint256 cap = maxSlots < GUARANTEE_MAX_PER_WALLET ? maxSlots : GUARANTEE_MAX_PER_WALLET;
        if (guaranteeClaimedSlots[msg.sender] + slots > cap) {
            revert GuaranteeCapExceeded(msg.sender);
        }
        if (guaranteeClaimedCount + slots > GUARANTEE_SLOTS) revert GuaranteeSoldOut();

        guaranteeClaimedSlots[msg.sender] += slots;
        guaranteeClaimedCount += slots;
        token.transfer(msg.sender, slots * TOKENS_PER_SLOT);
        emit GuaranteeClaimed(msg.sender, slots);
        // First mint after the sale opens renounces ownership of both
        // contracts (user decision 2026-11-26).
        _autoRenounce();
    }

    // -------------------------------------------------------------- finalization

    /// @notice Claim a 90% refund of tier 1 (index 0) purchases when
    ///         tier 1 did NOT sell out (user decision 2026-11-26).
    ///         Opens IMMEDIATELY at sale end — no waiting period —
    ///         and closes 7 days later (saleEndTime + REFUND_WINDOW).
    ///         The buyer must return ALL LOA they bought in tier 1
    ///         (approve this Sale first; the tokens are pulled via
    ///         transferFrom and burned IMMEDIATELY — straight to DEAD
    ///         in this same transaction, user decision 2026-11-26
    ///         "burn tự động mà"). One refund per buyer. The 10%
    ///         retained per refund stays in the tier and sweeps to the
    ///         treasury via sweepExpiredRefunds() once the window
    ///         closes. Referrer rewards already paid are NOT clawed
    ///         back — solvency holds because refunds are 90% while at
    ///         most 5% left the tier as rewards.
    ///         Tiers 2-4 have no refunds (they split per purchase).
    function claimRefund(uint8 tier) external nonReentrant {
        if (tier != 0) revert RefundTierNotSupported(tier);
        if (tierCompleted[0]) revert RefundNotAvailable(tier);
        if (saleEndTime == 0 || block.timestamp <= saleEndTime) {
            revert SaleNotEnded();
        }
        if (block.timestamp > saleEndTime + REFUND_WINDOW) {
            revert RefundWindowClosed();
        }
        if (tierRefunded[0][msg.sender]) revert AlreadyRefunded(msg.sender);
        uint256 refund = tierRefundable[0][msg.sender];
        if (refund == 0) revert NoPurchaseToRefund(msg.sender);
        uint256 tokensOwed = tierTokensBought[0][msg.sender];

        // First post-sale-end touch: burn the Sale's leftover LOA
        // (unminted slots + dust) and the unpaired LP reserve.
        _autoBurnLeftover();

        tierRefunded[0][msg.sender] = true;
        tierRefundable[0][msg.sender] = 0;
        tier1RefundLiability -= refund;

        token.transferFrom(msg.sender, DEAD, tokensOwed);
        (bool ok,) = payable(msg.sender).call{value: refund}("");
        if (!ok) revert BnbTransferFailed();
        emit RefundClaimed(msg.sender, tier, refund, tokensOwed);
    }

    /// @notice After the refund window closes, send whatever tier-1
    ///         BNB is left in this contract (retained 10% slices and
    ///         unclaimed refunds) to the treasury. Permissionless.
    ///         This is also a post-sale-end touch, so the lazy burn
    ///         runs here too if no refund claimed first: the Sale's
    ///         leftover LOA burns in this same call.
    function sweepExpiredRefunds() external {
        if (saleEndTime == 0 || block.timestamp <= saleEndTime + REFUND_WINDOW) {
            revert RefundWindowStillOpen();
        }
        _autoBurnLeftover();
        uint256 amount = address(this).balance;
        if (amount > 0) {
            (bool ok,) = payable(treasuryWallet).call{value: amount}("");
            if (!ok) revert BnbTransferFailed();
        }
        emit ExpiredRefundsSwept(amount);
    }
}
