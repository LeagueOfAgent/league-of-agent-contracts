const { expect } = require("chai");
const { ethers } = require("hardhat");

// Shared metadata URI as it will look once metadata.json is pinned to IPFS.
const SHARED_METADATA_URI = "ipfs://bafyTESTCID/metadata.json";
// Collection metadata URI as it will look once collection.json is pinned.
const COLLECTION_URI = "ipfs://bafyTESTCID/collection.json";

describe("LoginPassNFT", function () {
  let nft;
  let owner, alice, bob, carol;

  beforeEach(async function () {
    [owner, alice, bob, carol] = await ethers.getSigners();
    const LoginPassNFT = await ethers.getContractFactory("LoginPassNFT");
    nft = await LoginPassNFT.deploy(SHARED_METADATA_URI, COLLECTION_URI);
    await nft.waitForDeployment();
  });

  it("deploys with the settled name and symbol", async function () {
    expect(await nft.name()).to.equal("League Of Agent Login Pass");
    expect(await nft.symbol()).to.equal("LOAID");
  });

  it("free public mint works and assigns tokenId 1 to the first minter", async function () {
    await expect(nft.connect(alice).mint())
      .to.emit(nft, "LoginPassMinted")
      .withArgs(alice.address, 1);
    expect(await nft.balanceOf(alice.address)).to.equal(1);
    expect(await nft.ownerOf(1)).to.equal(alice.address);
    expect(await nft.totalMinted()).to.equal(1);
  });

  it("minting is free — the contract never asks for payment", async function () {
    // mint() is non-payable; sending value must fail at the EVM level.
    await expect(
      alice.sendTransaction({
        to: await nft.getAddress(),
        value: ethers.parseEther("0.01"),
        data: nft.interface.encodeFunctionData("mint"),
      })
    ).to.be.reverted;
  });

  it("second mint from the same wallet reverts", async function () {
    await nft.connect(alice).mint();
    await expect(nft.connect(alice).mint())
      .to.be.revertedWithCustomError(nft, "AlreadyHasLoginPass")
      .withArgs(alice.address);
    expect(await nft.balanceOf(alice.address)).to.equal(1);
    expect(await nft.totalMinted()).to.equal(1);
  });

  it("different wallets can each mint — supply is unlimited", async function () {
    await nft.connect(alice).mint();
    await nft.connect(bob).mint();
    await nft.connect(carol).mint();
    expect(await nft.ownerOf(2)).to.equal(bob.address);
    expect(await nft.ownerOf(3)).to.equal(carol.address);
    expect(await nft.totalMinted()).to.equal(3);
  });

  it("hasLoginPass returns true for a holder and false otherwise", async function () {
    expect(await nft.hasLoginPass(alice.address)).to.equal(false);
    expect(await nft.hasLoginPass(bob.address)).to.equal(false);
    await nft.connect(alice).mint();
    expect(await nft.hasLoginPass(alice.address)).to.equal(true);
    expect(await nft.hasLoginPass(bob.address)).to.equal(false);
    expect(await nft.hasLoginPass(ethers.ZeroAddress)).to.equal(false);
  });

  it("soulbound: transferFrom reverts", async function () {
    await nft.connect(alice).mint();
    await expect(
      nft.connect(alice).transferFrom(alice.address, bob.address, 1)
    ).to.be.revertedWithCustomError(nft, "SoulboundTransferNotAllowed");
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it("soulbound: safeTransferFrom reverts, even for an approved operator", async function () {
    await nft.connect(alice).mint();
    await expect(
      nft.connect(alice)["safeTransferFrom(address,address,uint256)"](
        alice.address,
        bob.address,
        1
      )
    ).to.be.revertedWithCustomError(nft, "SoulboundTransferNotAllowed");

    await nft.connect(alice).approve(bob.address, 1);
    await expect(
      nft.connect(bob).transferFrom(alice.address, bob.address, 1)
    ).to.be.revertedWithCustomError(nft, "SoulboundTransferNotAllowed");
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });

  it("tokenURI resolves to the shared metadata for every token", async function () {
    await nft.connect(alice).mint();
    await nft.connect(bob).mint();
    expect(await nft.baseURI()).to.equal(SHARED_METADATA_URI);
    expect(await nft.tokenURI(1)).to.equal(SHARED_METADATA_URI);
    expect(await nft.tokenURI(2)).to.equal(SHARED_METADATA_URI);
  });

  it("owner can update baseURI and tokenURI follows; non-owner cannot", async function () {
    await nft.connect(alice).mint();
    const NEW_URI = "ipfs://bafyNEWCID/metadata.json";
    await expect(nft.setBaseURI(NEW_URI))
      .to.emit(nft, "BaseURIUpdated")
      .withArgs(NEW_URI);
    expect(await nft.baseURI()).to.equal(NEW_URI);
    expect(await nft.tokenURI(1)).to.equal(NEW_URI);

    await expect(nft.connect(alice).setBaseURI("ipfs://evil/metadata.json"))
      .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("contractURI returns the value set at deploy (collection metadata)", async function () {
    expect(await nft.contractURI()).to.equal(COLLECTION_URI);
  });

  it("owner can update contractURI; non-owner cannot", async function () {
    const NEW_COLLECTION_URI = "ipfs://bafyNEWCID/collection.json";
    await expect(nft.setContractURI(NEW_COLLECTION_URI))
      .to.emit(nft, "ContractURIUpdated")
      .withArgs(NEW_COLLECTION_URI);
    expect(await nft.contractURI()).to.equal(NEW_COLLECTION_URI);

    await expect(nft.connect(alice).setContractURI("ipfs://evil/collection.json"))
      .to.be.revertedWithCustomError(nft, "OwnableUnauthorizedAccount")
      .withArgs(alice.address);
  });

  it("holder can burn their own pass, then hasLoginPass is false and re-mint works", async function () {
    await nft.connect(alice).mint();
    await expect(nft.connect(alice).burn(1))
      .to.emit(nft, "LoginPassBurned")
      .withArgs(alice.address, 1);
    expect(await nft.hasLoginPass(alice.address)).to.equal(false);

    await nft.connect(alice).mint();
    expect(await nft.hasLoginPass(alice.address)).to.equal(true);
    expect(await nft.ownerOf(2)).to.equal(alice.address);
  });

  it("a stranger cannot burn someone else's pass", async function () {
    await nft.connect(alice).mint();
    await expect(nft.connect(bob).burn(1)).to.be.reverted;
    expect(await nft.ownerOf(1)).to.equal(alice.address);
  });
});
