-- Supabase Auth identity mapping (email + password sign-in). Nullable: phone-era users stay as they are.
ALTER TABLE "User" ADD COLUMN "supabaseAuthUserId" TEXT;

CREATE UNIQUE INDEX "User_supabaseAuthUserId_key" ON "User"("supabaseAuthUserId");
