CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(2048),
	"page_number" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"token_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"storage_path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"page_count" integer,
	"error_message" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_status_check" CHECK ("documents"."status" IN ('pending','processing','ready','failed'))
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"cited_chunk_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_role_check" CHECK ("messages"."role" IN ('user','assistant'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chunks_document_id" ON "chunks" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chunks_document_chunk_index" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "idx_conversations_user_id" ON "conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_document_id" ON "conversations" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "idx_documents_user_id" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_messages_conversation_id" ON "messages" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email_lower" ON "users" USING btree (lower("email"));