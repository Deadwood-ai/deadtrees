import logging
from shared.logging import UnifiedLogger, SupabaseHandler

# Create logger instance
logger = UnifiedLogger(__name__)

# Add Supabase handler if not in dev mode
logger.add_supabase_handler(SupabaseHandler())
