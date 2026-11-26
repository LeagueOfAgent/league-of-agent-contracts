// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal PancakeSwap V2 router surface used by LeagueOfAgentToken
///         (per-tier liquidity adds + season buyback swaps). The real V2
///         router exposes factory() and WETH() (WETH is WBNB on BSC —
///         there is NO router.WBNB() function).
interface IPancakeV2Router {
    function factory() external view returns (address);
    function WETH() external pure returns (address);

    function addLiquidityETH(
        address token,
        uint256 amountTokenDesired,
        uint256 amountTokenMin,
        uint256 amountETHMin,
        address to,
        uint256 deadline
    ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity);

    function swapExactETHForTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable returns (uint256[] memory amounts);
}

/// @notice Minimal PancakeSwap V2 factory surface: getPair.
interface IPancakeV2Factory {
    function getPair(address tokenA, address tokenB) external view returns (address pair);
}

/// @notice Minimal Agent ID registry surface (SPACE ID ".ai" registry on BSC,
///         mainnet 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F). A wallet
///         "holds a Binance Agent ID" iff balanceOf(wallet) > 0.
interface IAgentIDRegistry {
    function balanceOf(address wallet) external view returns (uint256);
}

/// @notice Minimal Login Pass NFT surface used by the Sale contract.
interface ILoginPassNFT {
    function hasLoginPass(address wallet) external view returns (bool);
}
