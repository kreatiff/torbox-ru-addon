import type { MigrationBuilder } from 'node-pg-migrate';

// Structured counterpart to proposal_reason. The two are not redundant:
// proposal_reason is prose written for the human reading the Queue, while
// queue_reason is the machine-readable "why is this still queued", which the
// ingest pipeline's retry step (retryQueuedProviderMismatches) selects on.
// That retry previously matched proposal_reason with a LIKE against its
// English prefix, so rewording a sentence meant for humans would silently
// stop the retry from ever finding its rules again.
//
// NULL means "not queued" -- a committed auto-proposal, or any manual rule.
// Every write path clears it when a rule stops being queued; Rule.queueReason
// is non-optional in TypeScript precisely so no construction site can forget.

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules add column queue_reason text
      constraint rules_queue_reason_check
      check (queue_reason in (
        'llm_unavailable',
        'no_title_match',
        'incomplete_coverage',
        'provider_mismatch',
        'llm_not_confident'
      ));
  `);

  // Backfill from the prose these rules were stored with, so anything already
  // sitting in the Queue stays visible to the retry step across this upgrade.
  // Hardcoding the old strings is deliberate: a migration is a snapshot of the
  // format that existed when it ran, and must not drift with the source that
  // has since moved on. The confidence floor is MEDIUM_SCORE_THRESHOLD's value
  // at the time of writing (0.45), inlined for the same reason.
  pgm.sql(`
    update rules set queue_reason = case
      when proposal_reason like 'Queued: LLM-assigned episode numbers fall outside the known season %'
        then 'provider_mismatch'
      when proposal_reason like 'Queued: no confident title match%'
        then 'no_title_match'
      when proposal_reason like 'Queued: LLM extraction did not cover every video file%'
        then 'incomplete_coverage'
      when proposal_reason like 'Queued: LLM extraction unavailable%'
        then 'llm_unavailable'
      when proposal_reason like 'Queued: %'
        then 'llm_not_confident'
      else null
    end
    where source = 'auto' and confidence < 0.45;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    alter table rules drop column if exists queue_reason;
  `);
}
