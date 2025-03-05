# from pathlib import Path
# from typing import Optional
# from pydantic_settings import BaseSettings
# from functools import lru_cache

# class Settings(BaseSettings):
#     """CLI Configuration Settings"""
    
#     # Environment
#     ENV: str = "development"
    
#     # API Settings
#     API_ENDPOINT: str
#     SUPABASE_URL: str
#     SUPABASE_KEY: str
#     PROCESSOR_USERNAME: str
#     PROCESSOR_PASSWORD: str
    
#     # Development Settings
#     DEV_MODE: bool = True
    
#     class Config:
#         env_file = ".env"
#         env_file_encoding = "utf-8"

# @lru_cache()
# def get_settings() -> Settings:
#     """Get cached settings instance"""
#     return Settings() 