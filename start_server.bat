@echo off
cd /d "D:\vegetable store"
set MONGODB_URI=mongodb+srv://amitmourya822_db_user:admin@cluster0.axfeqs1.mongodb.net/freshmart
node server.js
timeout 10 >nul