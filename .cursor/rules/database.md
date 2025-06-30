---
description: Database operations and patterns for DeadTrees project
globs: ["supabase/**/*.sql", "**/models.py", "**/database.py"]
alwaysApply: true
---

# Database Guidelines

## Table Naming Convention
- `v2_*` - Current production tables
- `v1_*` - Legacy tables (deprecated)
- `dev_*` - Development/testing tables

## Environment Configuration
```python
# Development
SUPABASE_URL = "http://host.docker.internal:54321"
SUPABASE_KEY = "dev_key"

# Production
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
```

## Connection Patterns

### Self-Hosted Supabase Connections
- **Migrations**: Always use direct connection (port 5432)
  ```bash
  supabase migration up --db-url 'postgresql://user:pass@host:5432/postgres'
  ```
- **Application**: Use pooler connection (port 6543) for runtime
- **Pooler Limitations**: Transaction mode doesn't support prepared statements

### Connection Troubleshooting
- **SQLSTATE 42P05** (prepared statement exists): Switch from pooler to direct connection
- **Connection timeouts**: Check if using correct port for operation type

## Authentication Architecture

### Dual Authentication Pattern
The project uses two authentication methods that must be handled in database functions:

```sql
-- Handle both regular users and processor user
DECLARE
  current_user_id uuid;
BEGIN
  IF (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text THEN
    -- Processor user: lookup by email
    SELECT id INTO current_user_id FROM auth.users WHERE email = 'processor@deadtrees.earth';
  ELSE
    -- Regular users: use auth.uid()
    current_user_id := auth.uid();
  END IF;
END;
```

### RLS Policy Patterns
```sql
-- Standard pattern for processor + user access
using (((auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text) OR (auth.uid() = user_id))
```

## Migration Patterns

### View Dependencies
When altering columns referenced by views:
1. **Drop dependent views first**
2. **Alter column types**
3. **Recreate views with complete definitions**

```sql
-- Migration sequence
drop view if exists "public"."dependent_view";
alter table "public"."table" alter column "col" type new_type;
create or replace view "public"."dependent_view" as SELECT ...;
```

### Migration Best Practices
- Test with `supabase db reset` in development
- Use `--debug` flag for detailed error information
- Include complete view definitions in migrations
- Never rely on external state for view recreation

## Core Tables
- `v2_datasets` - Dataset metadata and processing status
- `v2_upload_requests` - File upload tracking
- `v2_process_requests` - Processing job queue
- `v2_logs` - Application logging
- `v2_dataset_edit_history` - Dataset change tracking

## Database Operations
```python
from supabase import create_client

client = create_client(SUPABASE_URL, SUPABASE_KEY)

# Insert with error handling
try:
    result = client.table("v2_datasets").insert(data).execute()
    return result.data[0]
except Exception as e:
    logger.error(f"Database insert failed: {e}")
    raise
```

## Error Code Reference

### Common Migration Errors
- **SQLSTATE 42P05**: Prepared statement conflicts → Use direct connection (port 5432)
- **SQLSTATE 0A000**: View/rule dependency → Drop dependent objects first
- **SQLSTATE 42703**: Column doesn't exist → Check migration sequence
- **SQLSTATE 42P07**: Object already exists → Use `IF NOT EXISTS` or `OR REPLACE`

### Debugging Commands
```bash
# Debug migration with detailed output
supabase migration up --debug --db-url 'postgresql://...:5432/postgres'

# Reset local database for testing
supabase db reset

# Run tests after migration
deadtrees dev test api
```

## MCP Tool Usage
- Use postgres-mcp for read-only database exploration
- Never use MCP for write operations
- Use MCP to understand schema and relationships

## Trigger and Function Patterns

### Edit History Triggers
Always handle dual authentication in triggers:
```sql
CREATE OR REPLACE FUNCTION log_changes() RETURNS trigger AS $$
DECLARE
  current_user_id uuid;
BEGIN
  -- Handle processor and regular users
  IF (auth.jwt() ->> 'email'::text) = 'processor@deadtrees.earth'::text THEN
    SELECT id INTO current_user_id FROM auth.users WHERE email = 'processor@deadtrees.earth';
  ELSE
    current_user_id := auth.uid();
  END IF;
  
  -- Only proceed if we have a valid user
  IF current_user_id IS NOT NULL THEN
    -- Log changes...
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
``` 