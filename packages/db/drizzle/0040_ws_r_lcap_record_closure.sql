CREATE TABLE "lcap_record_closure" (
	"record_cid" text NOT NULL,
	"related_cid" text NOT NULL,
	"relation" text NOT NULL,
	CONSTRAINT "lcap_record_closure_record_cid_related_cid_relation_pk" PRIMARY KEY("record_cid","related_cid","relation")
);
