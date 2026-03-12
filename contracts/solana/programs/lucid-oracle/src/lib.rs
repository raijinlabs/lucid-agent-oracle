use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod lucid_oracle {
    use super::*;

    pub fn initialize_feed(
        ctx: Context<InitializeFeed>,
        feed_id: [u8; 16],
        feed_version: u16,
        update_cadence: u32,
        signer_set: Vec<Pubkey>,
    ) -> Result<()> {
        instructions::initialize_feed::handler(ctx, feed_id, feed_version, update_cadence, signer_set)
    }

    pub fn post_report(
        ctx: Context<PostReport>,
        value: u64,
        decimals: u8,
        confidence: u16,
        revision: u16,
        report_timestamp: i64,
        input_manifest_hash: [u8; 32],
        computation_hash: [u8; 32],
    ) -> Result<()> {
        instructions::post_report::handler(
            ctx, value, decimals, confidence, revision, report_timestamp,
            input_manifest_hash, computation_hash,
        )
    }

    pub fn rotate_authority(ctx: Context<RotateAuthority>, new_authority: Pubkey) -> Result<()> {
        instructions::rotate_authority::handler(ctx, new_authority)
    }
}
