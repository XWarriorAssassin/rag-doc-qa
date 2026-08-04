CREATE TABLE "rate_limit_windows" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;