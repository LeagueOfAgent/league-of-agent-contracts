// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title League Of Agent — Login Pass NFT (LOAID)
/// @notice Separate ERC-721 contract for the game's login proof.
///         Free public mint, max 1 pass per wallet, unlimited total supply,
///         soulbound (non-transferable). Holding this NFT is checked by the
///         game server (hasLoginPass / balanceOf) after the player connects
///         their Binance Agentic Wallet and signs a nonce message.
/// @dev    Pass-style NFT: every token shares ONE metadata document (the
///         metadata.json prepared in the login-nft asset pack). Uniqueness
///         lives in the tokenId + owning wallet recorded on-chain, not in
///         per-token artwork. Therefore tokenURI() returns the shared
///         baseURI for every tokenId, and baseURI should be set to the full
///         metadata URI (e.g. "ipfs://<METADATA_CID>/metadata.json").
contract LoginPassNFT is ERC721, Ownable {
    /// @notice Thrown when a wallet that already holds a pass tries to mint again.
    error AlreadyHasLoginPass(address wallet);
    /// @notice Thrown on any transfer between wallets — the pass is soulbound.
    error SoulboundTransferNotAllowed();

    /// @notice Total number of passes ever minted (never decreases).
    uint256 public totalMinted;

    uint256 private _nextTokenId;
    string private _baseURIValue;
    string private _contractURI;

    event LoginPassMinted(address indexed wallet, uint256 indexed tokenId);
    event LoginPassBurned(address indexed wallet, uint256 indexed tokenId);
    event BaseURIUpdated(string newBaseURI);
    event ContractURIUpdated(string newContractURI);

    /// @param baseURI_    Full shared-metadata URI, e.g. "ipfs://<CID>/metadata.json".
    ///                    May be empty at deploy time and set later via setBaseURI
    ///                    once the IPFS pin exists.
    /// @param contractURI_ Collection-level metadata URI (OpenSea standard),
    ///                    pointing at the collection.json of the login-nft pack,
    ///                    e.g. "ipfs://<CID>/collection.json". May be empty at
    ///                    deploy time and set later via setContractURI.
    constructor(string memory baseURI_, string memory contractURI_)
        ERC721("League Of Agent Login Pass", "LOAID")
        Ownable(msg.sender)
    {
        _baseURIValue = baseURI_;
        _contractURI = contractURI_;
        _nextTokenId = 1; // tokenIds start at 1
    }

    // ------------------------------------------------------------------ mint

    /// @notice Mint your free Login Pass. One per wallet, enforced in-contract.
    /// @return tokenId The id of the minted pass.
    function mint() external returns (uint256 tokenId) {
        if (balanceOf(msg.sender) > 0) {
            revert AlreadyHasLoginPass(msg.sender);
        }
        tokenId = _nextTokenId++;
        totalMinted += 1;
        _safeMint(msg.sender, tokenId);
        emit LoginPassMinted(msg.sender, tokenId);
    }

    /// @notice Burn your own pass. Burning is the only way a pass leaves a
    ///         wallet besides never existing; after burning, the wallet may
    ///         mint a fresh pass (the 1-per-wallet cap is on holding, and
    ///         balanceOf returns to 0).
    function burn(uint256 tokenId) external {
        address tokenOwner = _requireOwned(tokenId);
        if (!_isAuthorized(tokenOwner, msg.sender, tokenId)) {
            revert ERC721InsufficientApproval(msg.sender, tokenId);
        }
        _burn(tokenId);
        emit LoginPassBurned(tokenOwner, tokenId);
    }

    // ----------------------------------------------------------------- views

    /// @notice The check the game server / sale contract performs at login:
    ///         does this wallet currently hold a Login Pass?
    function hasLoginPass(address wallet) external view returns (bool) {
        if (wallet == address(0)) return false;
        return balanceOf(wallet) > 0;
    }

    /// @notice Shared metadata URI every token points at.
    function baseURI() public view returns (string memory) {
        return _baseURIValue;
    }

    /// @notice Collection-level metadata URI (OpenSea contractURI standard),
    ///         pointing at the collection.json document of the login-nft pack.
    function contractURI() public view returns (string memory) {
        return _contractURI;
    }

    /// @dev Pass-style: all tokenIds resolve to the same shared metadata.
    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _baseURIValue;
    }

    // ------------------------------------------------------------ owner admin

    /// @notice Point every pass at a (new) shared metadata document,
    ///         e.g. after pinning metadata.json to IPFS.
    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseURIValue = newBaseURI;
        emit BaseURIUpdated(newBaseURI);
    }

    /// @notice Update the collection-level metadata URI,
    ///         e.g. after pinning collection.json to IPFS.
    function setContractURI(string calldata newContractURI) external onlyOwner {
        _contractURI = newContractURI;
        emit ContractURIUpdated(newContractURI);
    }

    // -------------------------------------------------------------- soulbound

    /// @dev OpenZeppelin v5 central transfer hook. Mints (from == 0) and
    ///      burns (to == 0) are allowed; every wallet-to-wallet move reverts,
    ///      which makes the pass soulbound — transferFrom, both
    ///      safeTransferFrom variants and operator transfers all funnel here.
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) {
            revert SoulboundTransferNotAllowed();
        }
        return super._update(to, tokenId, auth);
    }
}
