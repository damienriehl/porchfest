# Complete participant retention after application anonymization

The application can remove participant identity from its live database, but it
cannot erase off-host backups. A deletion receipt therefore has two separate
states. “Application data anonymized” means the live application work is done.
“Backup rotation pending” means older copies may still contain the identity and
the deletion is not complete.

The live-data window enforces itself opportunistically. The application sweeps
eligible participants once when the container boots, then at most once every six
hours when an authenticated organizer uses an admin route. The admin request
does not wait for the deferred sweep, and no scheduler, timer, or process runs
while the container is idle. A failed attempt logs a fixed retention warning and
does not prevent startup, sign-in, or organizer work; a later eligible activity
can try again after the throttle interval.

Each automatic anonymization writes the same pending deletion receipt as an
organizer action. Use those receipts for the off-host backup procedure below;
there is no separate automatic-sweep audit trail.

## Operator procedure

1. In **Organizer data controls → Participant retention**, note the pending
   receipt ID and its application-anonymized timestamp. The receipt contains a
   structural participant key, not copied contact details.
2. Inventory every off-host backup generation created before that timestamp,
   including replicated snapshots and any restore-test copies. Follow the
   deployment's documented retention policy: expire or securely destroy each of
   those generations, while preserving backups that the policy still requires
   until their scheduled turnover.
3. After the rotation has turned over, confirm from the backup provider's
   inventory that no restorable generation from before the receipt timestamp
   remains. Include replicas and restore-test storage in this check. Record the
   provider job or audit reference in the private operator log; do not copy
   participant identity into that log.
4. Only after that confirmation, mark the receipt's backup half complete using
   the deployment's normal authenticated SQLite administration channel. Run the
   following transaction with the pending receipt ID bound as `:receipt_id`:

   ```sql
   BEGIN IMMEDIATE;
   UPDATE deletion_receipts
      SET backup_status = 'completed',
          backup_completed_at = unixepoch(),
          version = version + 1,
          updated_at = unixepoch()
    WHERE id = :receipt_id
      AND backup_status = 'pending';
   COMMIT;
   ```

5. Confirm that exactly one row changed. Reload **Participant retention** and
   verify that the receipt now says “Backup rotation completed” with a
   completion time. If zero rows changed, stop and inspect the receipt instead
   of rerunning an unscoped update.

Once the backup rotation has turned over, anonymization is irreversible. Do not
mark a receipt complete early: an older restorable backup means the operator's
half of the deletion is still pending, even though the live application has
already scrubbed the participant.
