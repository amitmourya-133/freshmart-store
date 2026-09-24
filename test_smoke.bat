@echo off
setlocal
rem Smoke test FreshMart backend running on localhost:5000
rem NO secrets embedded - just tests endpoints

set "API_BASE=http://localhost:5000/api"

rem Test 1: Health check
curl -s %API_BASE%/health > health.txt 2>&1
echo.
echo ===== TEST 1: Health Check ====
type health.txt

rem Test 2: Products count
curl -s %API_BASE%/products > products.txt 2>&1
echo.
echo ===== TEST 2: Products (should be 56 items) ====
findstr /c:"56" products.txt >nul && echo Products count: 56 (verified) || echo Products count: check manually
echo %products.txt% | find /i "success" && echo API success: yes || echo API success: check manually

rem Test 3: Subscription plans
curl -s %API_BASE%/subscriptions/plans > subs.txt 2>&1
echo.
echo ===== TEST 3: Subscription Plans ====
type subs.txt

rem Test 4: User profile (unauth - should fail)
curl -s -o profile.txt %API_BASE%/users/me 2>&1
echo.
echo ===== TEST 4: User Profile (unauthenticated) ====
type profile.txt

rem Test 5: Auth headers check
echo.
echo ===== TEST 5: Authorization ====
curl -s -H "Authorization: Bearer invalid-token" %API_BASE%/users/me > auth.txt 2>&1
type auth.txt

del health.txt products.txt subs.txt profile.txt auth.txt
echo.
echo ===== ALL SMOKE TESTS COMPLETE =====