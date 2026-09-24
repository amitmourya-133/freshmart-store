@echo off
cd /d "D:\vegetable store"
rem Note: MONGODB_URI is loaded from .env at runtime
node server.js
timeout 10 >nul