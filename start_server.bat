@echo off
rem FreshMart local dev launcher.
rem Database credentials MUST come from the .env file (loaded by server.js) or
rem from the environment - never hardcode them in scripts/committed files.
cd /d "D:\vegetable store"
node server.js
timeout 10 >nul