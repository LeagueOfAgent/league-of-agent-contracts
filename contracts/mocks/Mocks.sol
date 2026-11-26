// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test double for the SPACE ID Agent ID registry: balanceOf is
///         settable per wallet.
contract MockAgentIDRegistry {
    mapping(address => uint256) private _balances;

    function setBalance(address wallet, uint256 amount) external {
        _balances[wallet] = amount;
    }

    function balanceOf(address wallet) external view returns (uint256) {
        return _balances[wallet];
    }
}

/// @notice Test double for the Login Pass NFT: hasLoginPass is settable.
contract MockLoginPass {
    mapping(address => bool) private _has;

    function setHasLoginPass(address wallet, bool has) external {
        _has[wallet] = has;
    }

    function hasLoginPass(address wallet) external view returns (bool) {
        return _has[wallet];
    }
}

/// @notice LP token minted by MockPancakeRouter on addLiquidityETH —
///         stands in for the PancakeSwap pair / LP token.
contract MockPair is ERC20 {
    constructor() ERC20("Mock LP", "MLP") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Test double for the PancakeSwap V2 factory. getPair returns the
///         configured pair address ONLY when the queried pair matches the
///         configured (token, WETH) in either order — any other query
///         returns address(0), mirroring the real factory (no pair exists
///         for that token pair). Unconfigured, every query returns
///         address(0): the Token's auto pair-set then leaves the pair
///         unset (fail-safe) instead of reverting.
contract MockPancakeFactory {
    address public configuredToken;
    address public configuredWeth;
    address public configuredPair;

    function configure(address token_, address weth_, address pair_) external {
        configuredToken = token_;
        configuredWeth = weth_;
        configuredPair = pair_;
    }

    function getPair(address tokenA, address tokenB) external view returns (address) {
        if (
            (tokenA == configuredToken && tokenB == configuredWeth)
                || (tokenA == configuredWeth && tokenB == configuredToken)
        ) {
            return configuredPair;
        }
        return address(0);
    }
}

/// @notice Test double for the PancakeSwap V2 router.
///         - addLiquidityETH pulls the token amount from the caller and
///           mints mock LP tokens to `to` (the token contract passes the
///           burn address, so tests can assert LP was burned/locked).
///         - swapExactETHForTokens pays out LOA at a FIXED rate of
///           1,000,000 LOA per 1 BNB from the router's own LOA inventory
///           (tests fund the router first).
contract MockPancakeRouter {
    uint256 public constant LOA_PER_BNB = 1_000_000;

    MockPair public immutable pair;
    MockPancakeFactory public immutable factoryContract;
    address public immutable weth;

    // Last addLiquidityETH call, for test assertions.
    address public lastLiquidityToken;
    uint256 public lastLiquidityTokenAmount;
    uint256 public lastLiquidityETHAmount;
    address public lastLiquidityTo;

    constructor() {
        pair = new MockPair();
        factoryContract = new MockPancakeFactory();
        weth = address(0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c); // WBNB mainnet
    }

    function factory() external view returns (address) {
        return address(factoryContract);
    }

    function WETH() external view returns (address) {
        return weth;
    }

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256,
        uint256,
        address to,
        uint256
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity) {
        IERC20Minimal(token).transferFrom(msg.sender, address(this), amountTokenDesired);
        lastLiquidityToken = token;
        lastLiquidityTokenAmount = amountTokenDesired;
        lastLiquidityETHAmount = msg.value;
        lastLiquidityTo = to;
        liquidity = msg.value; // arbitrary stand-in amount
        pair.mint(to, liquidity);
        return (amountTokenDesired, msg.value, liquidity);
    }

    function swapExactETHForTokens(uint256, address[] calldata path, address to, uint256)
        external
        payable
        returns (uint256[] memory amounts)
    {
        uint256 out = msg.value * LOA_PER_BNB;
        IERC20Minimal(path[path.length - 1]).transfer(to, out);
        amounts = new uint256[](2);
        amounts[0] = msg.value;
        amounts[1] = out;
    }

    receive() external payable {}
}

/// @notice Test double whose receive() always reverts — stands in for a
///         referrer that cannot receive BNB (e.g. a contract with no
///         payable fallback). The Sale must never brick a buy because
///         of such a referrer: the reward attempt fails, the buy still
///         succeeds, and the 5% stays in the tier.
contract MockRevertingReceiver {
    receive() external payable {
        revert("MockRevertingReceiver: no BNB accepted");
    }
}

interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
