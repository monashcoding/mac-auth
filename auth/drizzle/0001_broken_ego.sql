CREATE TABLE "roster" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notion_id" text NOT NULL,
	"name" text NOT NULL,
	"teams" text[] DEFAULT '{}' NOT NULL,
	"is_exec" boolean DEFAULT false NOT NULL,
	"position" text,
	"student_email" text,
	"personal_email" text,
	"discord_handle" text,
	"source" text DEFAULT 'notion' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roster_notion_id_unique" UNIQUE("notion_id")
);
--> statement-breakpoint
CREATE TABLE "roster_email" (
	"email" text PRIMARY KEY NOT NULL,
	"roster_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "roster_email" ADD CONSTRAINT "roster_email_roster_id_roster_id_fk" FOREIGN KEY ("roster_id") REFERENCES "public"."roster"("id") ON DELETE cascade ON UPDATE no action;