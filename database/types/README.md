# Generated Database Types

Do not hand-author a second schema definition here. Generate TypeScript types from the reviewed local migration state after the migrations have been applied to a disposable local Supabase stack.

Example:

```bash
supabase start
supabase db reset
supabase gen types typescript --local > database/types/database.ts
```

Commit the generated file together with the migration commit it represents. Regenerate it whenever schema migrations change. Never generate types by connecting this repository to an unapproved production project.
