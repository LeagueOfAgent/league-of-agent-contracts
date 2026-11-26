require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // OpenZeppelin v5.6 uses the `mcopy` opcode (utils/Bytes.sol),
      // which requires the Cancun EVM target.
      evmVersion: "cancun",
    },
  },
  networks: {
    hardhat: {},
    // BSC Testnet (chainId 97). The deployer key is read ONLY from the
    // DEPLOYER_PRIVATE_KEY environment variable — never hardcode a key.
    // With no env set, accounts is empty and compile/test still work fine.
    bscTestnet: {
      url: "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    // BSC Mainnet (chainId 56). Added 2026-11-26 for the CREATE2
    // mainnet deploy (user order). Same key discipline as testnet:
    // DEPLOYER_PRIVATE_KEY env only, never hardcoded.
    bsc: {
      url: "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
};
