CREATE TABLE "activity_feed" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text NOT NULL,
	"application_id" uuid,
	"loan_id" uuid,
	"type" text NOT NULL,
	"message" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_feed_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "dead_letter_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" text,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processed_events" (
	"event_id" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_feed_application_id_idx" ON "activity_feed" USING btree ("application_id");