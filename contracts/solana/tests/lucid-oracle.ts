import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { LucidOracle } from "../target/types/lucid_oracle";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  Ed25519Program,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import * as ed from "@noble/ed25519";
import { createHash } from "crypto";

ed.etc.sha512Sync = (...msgs: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of msgs) h.update(m);
  return new Uint8Array(h.digest());
};

function padFeedId(s: string): number[] {
  const buf = Buffer.alloc(16);
  buf.write(s, "utf8");
  return Array.from(buf);
}

function buildReportMessage(
  feedId: number[],
  reportTimestamp: bigint,
  value: bigint,
  decimals: number,
  confidence: number,
  revision: number,
  inputManifestHash: number[],
  computationHash: number[]
): Buffer {
  const buf = Buffer.alloc(101);
  let offset = 0;
  Buffer.from(feedId).copy(buf, offset); offset += 16;
  buf.writeBigInt64LE(reportTimestamp, offset); offset += 8;
  buf.writeBigUInt64LE(value, offset); offset += 8;
  buf.writeUInt8(decimals, offset); offset += 1;
  buf.writeUInt16LE(confidence, offset); offset += 2;
  buf.writeUInt16LE(revision, offset); offset += 2;
  Buffer.from(inputManifestHash).copy(buf, offset); offset += 32;
  Buffer.from(computationHash).copy(buf, offset);
  return buf;
}

describe("lucid-oracle", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.LucidOracle as Program<LucidOracle>;

  const feedId = padFeedId("aegdp");
  const feedIdBytes = Buffer.from(feedId);

  const signerPrivKey = ed.utils.randomPrivateKey();
  const signerPubKey = ed.getPublicKey(signerPrivKey);
  const signerPubkey = new PublicKey(signerPubKey);

  const zeroHash = new Array(32).fill(0);

  let feedConfigPda: PublicKey;
  let feedReportPda: PublicKey;

  before(async () => {
    [feedConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("feed"), feedIdBytes],
      program.programId
    );
    [feedReportPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("report"), feedIdBytes],
      program.programId
    );
  });

  it("initialize_feed creates PDAs with correct values", async () => {
    await program.methods
      .initializeFeed(feedId, 1, 300, [signerPubkey])
      .accounts({
        feedConfig: feedConfigPda,
        feedReport: feedReportPda,
        authority: provider.wallet.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const config = await program.account.feedConfig.fetch(feedConfigPda);
    expect(Buffer.from(config.feedId).toString("utf8").replace(/\0/g, "")).to.equal("aegdp");
    expect(config.feedVersion).to.equal(1);
    expect(config.authority.toBase58()).to.equal(provider.wallet.publicKey.toBase58());
    expect(config.signerSet).to.have.lengthOf(1);
    expect(config.updateCadence).to.equal(300);
  });

  it("post_report updates FeedReport with correct values", async () => {
    const timestamp = BigInt(Date.now());
    const value = BigInt(847_000_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey,
      message,
      signature: sig,
    });

    await program.methods
      .postReport(
        new anchor.BN(value.toString()),
        6, 9700, 0,
        new anchor.BN(timestamp.toString()),
        zeroHash, zeroHash,
      )
      .accounts({
        feedConfig: feedConfigPda,
        feedReport: feedReportPda,
        authority: provider.wallet.publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .rpc();

    const report = await program.account.feedReport.fetch(feedReportPda);
    expect(report.value.toString()).to.equal(value.toString());
    expect(report.decimals).to.equal(6);
    expect(report.confidence).to.equal(9700);
  });

  it("post_report accepts same timestamp with higher revision", async () => {
    const report = await program.account.feedReport.fetch(feedReportPda);
    const timestamp = BigInt(report.reportTimestamp.toString());
    const value = BigInt(847_100_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 1, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    await program.methods
      .postReport(new anchor.BN(value.toString()), 6, 9700, 1, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
      .accounts({
        feedConfig: feedConfigPda, feedReport: feedReportPda,
        authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      })
      .preInstructions([ed25519Ix])
      .rpc();

    const updated = await program.account.feedReport.fetch(feedReportPda);
    expect(updated.revision).to.equal(1);
  });

  it("post_report rejects stale timestamp + same revision", async () => {
    const staleTimestamp = BigInt(1_000_000);
    const message = buildReportMessage(feedId, staleTimestamp, BigInt(100), 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(100), 6, 9700, 0, new anchor.BN(staleTimestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("StaleReport");
    }
  });

  it("post_report rejects wrong authority", async () => {
    const wrongAuth = Keypair.generate();
    const airdropSig = await provider.connection.requestAirdrop(wrongAuth.publicKey, 1e9);
    await provider.connection.confirmTransaction(airdropSig);

    const timestamp = BigInt(Date.now() + 1000000);
    const message = buildReportMessage(feedId, timestamp, BigInt(100), 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, signerPrivKey);
    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(100), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: wrongAuth.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .signers([wrongAuth])
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("has_one");
    }
  });

  it("post_report rejects Ed25519 instruction with wrong signer", async () => {
    const wrongPrivKey = ed.utils.randomPrivateKey();
    const wrongPubKey = ed.getPublicKey(wrongPrivKey);

    const timestamp = BigInt(Date.now() + 5000000);
    const value = BigInt(900_000_000_000);
    const message = buildReportMessage(feedId, timestamp, value, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(message, wrongPrivKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: wrongPubKey, message, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(value.toString()), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("UnauthorizedSigner");
    }
  });

  it("post_report rejects Ed25519 instruction with wrong message", async () => {
    const timestamp = BigInt(Date.now() + 6000000);
    const value = BigInt(900_000_000_000);
    const wrongValue = BigInt(123);
    const wrongMessage = buildReportMessage(feedId, timestamp, wrongValue, 6, 9700, 0, zeroHash, zeroHash);
    const sig = ed.sign(wrongMessage, signerPrivKey);

    const ed25519Ix = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signerPubKey, message: wrongMessage, signature: sig,
    });

    try {
      await program.methods
        .postReport(new anchor.BN(value.toString()), 6, 9700, 0, new anchor.BN(timestamp.toString()), zeroHash, zeroHash)
        .accounts({
          feedConfig: feedConfigPda, feedReport: feedReportPda,
          authority: provider.wallet.publicKey, instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .preInstructions([ed25519Ix])
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("MessageMismatch");
    }
  });

  it("rotate_authority transfers authority", async () => {
    const newAuth = Keypair.generate();

    await program.methods
      .rotateAuthority(newAuth.publicKey)
      .accounts({
        feedConfig: feedConfigPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const config = await program.account.feedConfig.fetch(feedConfigPda);
    expect(config.authority.toBase58()).to.equal(newAuth.publicKey.toBase58());

    try {
      await program.methods
        .rotateAuthority(provider.wallet.publicKey)
        .accounts({
          feedConfig: feedConfigPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have thrown");
    } catch (e: any) {
      expect(e.message).to.include("has_one");
    }

    const airdropSig = await provider.connection.requestAirdrop(newAuth.publicKey, 1e9);
    await provider.connection.confirmTransaction(airdropSig);
    await program.methods
      .rotateAuthority(provider.wallet.publicKey)
      .accounts({ feedConfig: feedConfigPda, authority: newAuth.publicKey })
      .signers([newAuth])
      .rpc();
  });
});
