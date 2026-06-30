-- PUB-API-CORE-1 (§29 public-serve confidentiality gate): the REVERSE record-closure index.
-- `recordsReferencing(related_cid, relation)` resolves a wanted block/proof CID to its owning
-- record(s) to decide public-servability on the serve hot path; this index keeps that lookup
-- cheap (the table's PK leads with record_cid, so a reverse lookup would otherwise scan).
CREATE INDEX "lcap_record_closure_related_idx" ON "lcap_record_closure" USING btree ("related_cid","relation");
