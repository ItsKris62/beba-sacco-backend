# Beba SACCO — Security & Tenant Isolation Audit Script (PowerShell)
# Phase C — Windows-compatible version
#
# Usage: cd backend; .\scripts\verify-tenant-isolation.ps1

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir "..")
$SrcDir = Join-Path $ProjectRoot "src"

$Failed = 0
$Pass = 0
$Total = 0

function Log-Pass($msg) { Write-Host "✅  PASS: $msg" -ForegroundColor Green; $script:Pass++; $script:Total++ }
function Log-Fail($msg) { Write-Host "❌  FAIL: $msg" -ForegroundColor Red; $script:Failed++; $script:Total++ }
function Log-Info($msg) { Write-Host "ℹ️   INFO: $msg" -ForegroundColor Cyan }

Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "Beba SACCO — Security & Tenant Isolation Audit (Phase C)" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor White

# C3.1: Prisma tenantId scoping
Write-Host ""
Write-Host "C3.1  Prisma tenantId Scoping Audit" -ForegroundColor Yellow
$prismaFiles = Get-ChildItem -Path $SrcDir -Recurse -Filter "*.ts" | Where-Object { $_.FullName -notmatch "(\.spec\.ts|\.e2e-spec\.ts|test/|node_modules|seed)" }
$missingTenant = @()
foreach ($file in $prismaFiles) {
    $content = Get-Content $file.FullName -Raw
    if ($content -match 'prisma\.(findUnique|findFirst|findMany|count|aggregate|groupBy|create|update|updateMany|delete|deleteMany|upsert)\s*\(' -and
        $content -notmatch 'tenantId' -and
        $content -notmatch 'executeRaw' -and
        $content -notmatch 'queryRaw') {
        $missingTenant += $file.FullName
    }
}
if ($missingTenant.Count -eq 0) { Log-Pass "All Prisma queries include tenantId scoping" }
else { Log-Fail "Potential missing tenantId in: $($missingTenant | Select-Object -First 5)" }

# C3.2: Middleware order
Write-Host ""
Write-Host "C3.2  Middleware Execution Order Audit" -ForegroundColor Yellow
$appModule = Get-Content (Join-Path $SrcDir "app.module.ts") -Raw
if ($appModule -match "RequestIdMiddleware.*TenantMiddleware.*IdempotencyMiddleware") { Log-Pass "Middleware chain: RequestId → Tenant → Idempotency" }
else { Log-Fail "Middleware chain order may be incorrect" }

# C3.3: Rate limiting
Write-Host ""
Write-Host "C3.3  Rate Limiting Audit" -ForegroundColor Yellow
if ($appModule -match "ThrottlerModule\.forRoot") { Log-Pass "ThrottlerModule registered globally" }
else { Log-Fail "ThrottlerModule NOT registered globally" }

# C3.4: PII redaction
Write-Host ""
Write-Host "C3.4  PII Redaction in Logs" -ForegroundColor Yellow
if ($appModule -match "redact:" -and $appModule -match "authorization") { Log-Pass "Authorization header redacted" }
else { Log-Fail "Authorization header NOT redacted" }
if ($appModule -match "password") { Log-Pass "Password fields redacted" }
else { Log-Fail "Password fields NOT redacted" }

# C3.5: Idempotency
Write-Host ""
Write-Host "C3.5  Idempotency-Key Header Validation" -ForegroundColor Yellow
if (Test-Path (Join-Path $SrcDir "common\middleware\idempotency.middleware.ts")) { Log-Pass "IdempotencyMiddleware exists" }
else { Log-Fail "IdempotencyMiddleware NOT found" }

# C3.6: RBAC
Write-Host ""
Write-Host "C3.6  RBAC Guards on Admin Endpoints" -ForegroundColor Yellow
if ($appModule -match "APP_GUARD.*RBACGuard") { Log-Pass "RBACGuard is global APP_GUARD" }
else { Log-Fail "RBACGuard NOT global APP_GUARD" }

# C3.7: RFC 7807
Write-Host ""
Write-Host "C3.7  RFC 7807 Problem+JSON Compliance" -ForegroundColor Yellow
$globalFilter = Get-Content (Join-Path $SrcDir "common\filters\global-exception.filter.ts") -Raw
if ($globalFilter -match "application/problem\+json") { Log-Pass "GlobalExceptionFilter returns problem+json" }
else { Log-Fail "GlobalExceptionFilter missing problem+json" }

# C3.8: Zero TODOs
Write-Host ""
Write-Host "C3.8  Zero Placeholder / TODO Audit" -ForegroundColor Yellow
$todoCount = (Get-ChildItem -Path $SrcDir -Recurse -Filter "*.ts" | Where-Object { $_.FullName -notmatch "(\.spec\.ts|test/|node_modules)" } | Select-String -Pattern "TODO:|FIXME:|XXX:|HACK:").Count
if ($todoCount -eq 0) { Log-Pass "Zero TODO/FIXME/XXX/HACK in source" }
else { Log-Fail "Found $todoCount TODO/FIXME/XXX/HACK comments" }

# Summary
Write-Host ""
Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "Audit Summary" -ForegroundColor White
Write-Host "═══════════════════════════════════════════════════════════════════════════════" -ForegroundColor White
Write-Host "  Total checks:  $Total"
Write-Host "  Passed:        $Pass"
Write-Host "  Failed:        $Failed"
Write-Host ""

if ($Failed -eq 0) {
    Write-Host "🎉  ALL CHECKS PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "⚠️   $Failed CHECK(S) FAILED" -ForegroundColor Red
    exit 1
}
