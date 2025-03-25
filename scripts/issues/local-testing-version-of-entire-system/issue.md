# Local Testing Version of Entire System

Set up a local version of the database for testing and development without duplicating tables.

## Database

1. **Install Supabase CLI**

   ```bash
   npm install -g supabase
   supabase login
   ```

2. **Initialize Local Development**

   ```bash
   supabase init
   supabase start
   ```

3. **Pull Production Schema**

   ```bash
   supabase link --project-ref your-project-ref
   supabase db pull --schema-only
   ```

4. **Update Settings**

   - Add a flag for local development in `shared/settings.py`.
   - Use local Supabase URL and anon key when `SUPABASE_LOCAL` is `True`.

5. **Modify Docker Compose**

   - Add a local Supabase service in `docker-compose.test.yaml`.

6. **Adjust Tests**
   - Use a mock token or local user for authentication in tests.

## Benefits

- Consistent schema across environments.
- Safe local testing without affecting production data.
- Faster and more reliable test execution.

## Remove Table Prefix Logic

- Eliminate dev/prod table prefixes in settings.
- Use environment switching for different setups.
