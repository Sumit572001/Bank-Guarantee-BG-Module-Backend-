# Highrise Bank Guarantee Module Backend Server
# Written in native PowerShell to leverage built-in .NET HttpListener and avoid runtime/permission issues.

$port = 8080
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DbDir = Join-Path $ScriptDir "db"
$UploadsDir = Join-Path $ScriptDir "uploads"

# Ensure directories exist
if (!(Test-Path $DbDir)) { New-Item -ItemType Directory -Path $DbDir | Out-Null }
if (!(Test-Path $UploadsDir)) { New-Item -ItemType Directory -Path $UploadsDir | Out-Null }

$RequestsPath = Join-Path $DbDir "requests.json"
$RegisterPath = Join-Path $DbDir "register.json"

if (!(Test-Path $RequestsPath)) { Set-Content -Path $RequestsPath -Value "[]" -Encoding utf8 }
if (!(Test-Path $RegisterPath)) { Set-Content -Path $RegisterPath -Value "[]" -Encoding utf8 }

$MimeTypes = @{
    ".json" = "application/json"
    ".png"  = "image/png"
    ".jpg"  = "image/jpeg"
    ".gif"  = "image/gif"
    ".svg"  = "image/svg+xml"
    ".pdf"  = "application/pdf"
    ".doc"  = "application/msword"
    ".docx" = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ".xls"  = "application/vnd.ms-excel"
    ".xlsx" = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

# --- Helper Functions ---

function Read-Db($collection) {
    $dbPath = Join-Path $DbDir "$collection.json"
    if (!(Test-Path $dbPath)) { return @() }
    try {
        $content = Get-Content -Path $dbPath -Raw -Encoding utf8
        if ([string]::IsNullOrWhiteSpace($content)) { return @() }
        $parsed = $content | ConvertFrom-Json
        if ($null -eq $parsed) { return @() }
        # Force array return even if single element
        if ($parsed -is [Array]) { return ,$parsed }
        return ,$parsed
    } catch {
        Write-Host "Error reading database: $_" -ForegroundColor Red
        return @()
    }
}

function Write-Db($collection, $data) {
    $dbPath = Join-Path $DbDir "$collection.json"
    try {
        $json = ConvertTo-Json -InputObject $data -Depth 10
        Set-Content -Path $dbPath -Value $json -Encoding utf8
        return $true
    } catch {
        Write-Host "Error writing database: $_" -ForegroundColor Red
        return $false
    }
}

function Generate-Id($collection, $prefix) {
    $items = Read-Db $collection
    $year = (Get-Date).Year
    $count = 1
    
    if ($items -and $items.Count -gt 0) {
        $pattern = "^$prefix-$year-(\d{4})$"
        $counts = @()
        foreach ($item in $items) {
            if ($item.id -match $pattern) {
                $counts += [int]$Matches[1]
            }
        }
        if ($counts.Count -gt 0) {
            $count = ($counts | Measure-Object -Maximum).Maximum + 1
        }
    }
    
    $formattedCount = $count.ToString().PadLeft(4, '0')
    return "$prefix-$year-$formattedCount"
}

function Calculate-AlertDates($expiryDateStr) {
    if ([string]::IsNullOrWhiteSpace($expiryDateStr)) {
        return @{ alertDate = ""; initiationDate = "" }
    }
    try {
        $expiry = [DateTime]::Parse($expiryDateStr)
        $alert = $expiry.AddDays(-30)
        $initiation = $expiry.AddDays(-15)
        return @{
            alertDate = $alert.ToString("yyyy-MM-dd")
            initiationDate = $initiation.ToString("yyyy-MM-dd")
        }
    } catch {
        return @{ alertDate = ""; initiationDate = "" }
    }
}

function Save-Attachment($filename, $base64Data) {
    try {
        # Strip MIME prefix (e.g., "data:application/pdf;base64,")
        $base64Clean = $base64Data
        if ($base64Data -match "^data:.*;base64,(.*)$") {
            $base64Clean = $Matches[1]
        }
        
        $bytes = [System.Convert]::FromBase64String($base64Clean)
        
        # Build unique filename
        $ext = [System.IO.Path]::GetExtension($filename)
        $base = [System.IO.Path]::GetFileNameWithoutExtension($filename)
        $timestamp = (Get-Date).Ticks
        $uniqueName = "${base}_${timestamp}${ext}"
        $filePath = Join-Path $UploadsDir $uniqueName
        
        [System.IO.File]::WriteAllBytes($filePath, $bytes)
        
        return @{
            success = $true
            filename = $uniqueName
            originalName = $filename
            path = "/uploads/$uniqueName"
        }
    } catch {
        Write-Host "Error saving attachment: $_" -ForegroundColor Red
        return @{ success = $false; error = $_.Exception.Message }
    }
}

# --- HTTP listener initialization ---
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()

Write-Host "PowerShell Backend Server listening at http://localhost:$port/" -ForegroundColor Green
Write-Host "Press Ctrl+C to terminate the server." -ForegroundColor Yellow

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $req = $context.Request
        $res = $context.Response

        $reqPath = $req.Url.AbsolutePath
        $method = $req.HttpMethod

        Write-Host "$method $reqPath" -ForegroundColor Cyan

        # CORS Setup
        $res.AddHeader("Access-Control-Allow-Origin", "*")
        $res.AddHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        $res.AddHeader("Access-Control-Allow-Headers", "Content-Type")

        if ($method -eq "OPTIONS") {
            $res.StatusCode = 200
            $res.Close()
            continue
        }

        # --- API ROUTES ---
        if ($reqPath.StartsWith("/api/")) {
            $res.ContentType = "application/json"
            
            try {
                # GET /api/test
                if ($reqPath -eq "/api/test" -and $method -eq "GET") {
                    $payload = @{
                        success = $true
                        message = "Backend is working successfully"
                        status = "healthy"
                        timestamp = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                # GET /api/dashboard
                elseif ($reqPath -eq "/api/dashboard" -and $method -eq "GET") {
                    $requests = Read-Db "requests"
                    $register = Read-Db "register"
                    
                    $now = Get-Date
                    $thirtyDaysFromNow = $now.AddDays(30)
                    
                    $outstandingCount = 0
                    $totalAmount = 0.0
                    $totalMarginMoney = 0.0
                    $activeCount = 0
                    $releasedCount = 0
                    $cancelledCount = 0
                    $expiredCount = 0
                    $urgentCount = 0
                    
                    foreach ($bg in $register) {
                        $bgAmount = 0.0
                        if ($bg.bgAmount) { $bgAmount = [double]$bg.bgAmount }
                        $bgMargin = 0.0
                        if ($bg.marginMoney) { $bgMargin = [double]$bg.marginMoney }
                        
                        if ($bg.status -eq "Active") {
                            $activeCount++
                            $outstandingCount++
                            $totalAmount += $bgAmount
                            $totalMarginMoney += $bgMargin
                            
                            if ($bg.expiryDate) {
                                $expDate = [DateTime]::Parse($bg.expiryDate)
                                if ($expDate -le $thirtyDaysFromNow) {
                                    $urgentCount++
                                }
                            }
                        } elseif ($bg.status -eq "Expired") {
                            $expiredCount++
                            $outstandingCount++
                            $totalAmount += $bgAmount
                            $totalMarginMoney += $bgMargin
                            $urgentCount++
                        } elseif ($bg.status -eq "Released") {
                            $releasedCount++
                        } elseif ($bg.status -eq "Cancelled") {
                            $cancelledCount++
                        }
                    }
                    
                    $pendingRequestsCount = 0
                    foreach ($r in $requests) {
                        if ($r.status -eq "Pending") { $pendingRequestsCount++ }
                    }
                    
                    # Get 5 recent BGs sorted by lastUpdatedOn desc
                    $sorted = $register | Sort-Object -Property @{Expression={[DateTime]::Parse($_.lastUpdatedOn)}} -Descending
                    $recent = @()
                    if ($sorted) {
                        $recent = $sorted | Select-Object -First 5
                    }
                    
                    $payload = @{
                        outstandingCount = $outstandingCount
                        totalAmount = $totalAmount
                        totalMarginMoney = $totalMarginMoney
                        activeCount = $activeCount
                        releasedCount = $releasedCount
                        cancelledCount = $cancelledCount
                        expiredCount = $expiredCount
                        pendingRequestsCount = $pendingRequestsCount
                        urgentCount = $urgentCount
                        recentBgs = $recent
                    }
                    
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($payload | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # GET /api/requests
                elseif ($reqPath -eq "/api/requests" -and $method -eq "GET") {
                    $requests = Read-Db "requests"
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($requests | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # POST /api/requests
                elseif ($reqPath -eq "/api/requests" -and $method -eq "POST") {
                    $reader = New-Object System.IO.StreamReader($req.InputStream)
                    $body = $reader.ReadToEnd()
                    $data = $body | ConvertFrom-Json
                    
                    $requests = Read-Db "requests"
                    
                    $processedAttachments = @()
                    if ($data.attachments) {
                        foreach ($file in $data.attachments) {
                            if ($file.name -and $file.data) {
                                $saved = Save-Attachment $file.name $file.data
                                if ($saved.success) {
                                    $processedAttachments += @{
                                        originalName = $saved.originalName
                                        filename = $saved.filename
                                        path = $saved.path
                                    }
                                }
                            }
                        }
                    }
                    
                    $newRequest = @{
                        id = Generate-Id "requests" "REQ"
                        projectRef = if ($data.projectRef) { $data.projectRef } else { "General" }
                        bgType = if ($data.bgType) { $data.bgType } else { "EMD" }
                        amount = if ($data.amount) { [double]$data.amount } else { 0.0 }
                        dueDate = if ($data.dueDate) { $data.dueDate } else { "" }
                        beneficiaryName = if ($data.beneficiaryName) { $data.beneficiaryName } else { "" }
                        beneficiaryAddress = if ($data.beneficiaryAddress) { $data.beneficiaryAddress } else { "" }
                        beneficiaryBank = if ($data.beneficiaryBank) { $data.beneficiaryBank } else { "" }
                        duration = if ($data.duration) { $data.duration } else { "" }
                        requestedBy = if ($data.requestedBy) { $data.requestedBy } else { "Unknown" }
                        approvalsNeeded = if ($data.approvalsNeeded) { $data.approvalsNeeded } else { "Finance" }
                        remarks = if ($data.remarks) { $data.remarks } else { "" }
                        status = "Pending"
                        createdAt = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                        attachments = $processedAttachments
                    }
                    
                    $requests += $newRequest
                    $success = Write-Db "requests" $requests
                    
                    $response = @{ success = $success; request = $newRequest }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # PUT /api/requests (Approvals)
                elseif ($reqPath -eq "/api/requests" -and $method -eq "PUT") {
                    $reader = New-Object System.IO.StreamReader($req.InputStream)
                    $body = $reader.ReadToEnd()
                    $data = $body | ConvertFrom-Json
                    
                    if (!$data.id) {
                        $res.StatusCode = 400
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false,"error":"Request ID is required"}')
                        $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                        $res.Close()
                        continue
                    }
                    
                    $requests = Read-Db "requests"
                    $targetReq = $null
                    
                    foreach ($r in $requests) {
                        if ($r.id -eq $data.id) {
                            $targetReq = $r
                            break
                        }
                    }
                    
                    if ($null -eq $targetReq) {
                        $res.StatusCode = 404
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false,"error":"Request not found"}')
                        $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                        $res.Close()
                        continue
                    }
                    
                    $oldStatus = $targetReq.status
                    $targetReq.status = $data.status
                    $targetReq.approvedBy = $data.approvedBy
                    $targetReq.approvedOn = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    
                    Write-Db "requests" $requests | Out-Null
                    
                    # Workflow: If approved, create draft in register
                    if ($data.status -eq "Approved" -and $oldStatus -ne "Approved") {
                        $register = Read-Db "register"
                        $newBg = @{
                            id = Generate-Id "register" "BG"
                            requestId = $targetReq.id
                            bgNumber = ""
                            bgType = $targetReq.bgType
                            beneficiary = $targetReq.beneficiaryName
                            siteName = $targetReq.projectRef
                            clientName = $targetReq.beneficiaryName
                            issuingBank = $targetReq.beneficiaryBank
                            issueDate = ""
                            effectiveDate = ""
                            expiryDate = ""
                            claimExpiryDate = ""
                            bgAmount = $targetReq.amount
                            bgCommission = 0.0
                            autoRenewal = $false
                            status = "Active"
                            releasedDate = ""
                            remarks = "Auto-created from approved request $($targetReq.id). $($targetReq.remarks)"
                            attachments = $targetReq.attachments
                            marginMoney = 0.0
                            fdrNo = ""
                            costCenter = ""
                            lastUpdatedBy = $targetReq.approvedBy
                            lastUpdatedOn = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                        }
                        $register += $newBg
                        Write-Db "register" $register | Out-Null
                    }
                    
                    $response = @{ success = $true; request = $targetReq }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # GET /api/register
                elseif ($reqPath -eq "/api/register" -and $method -eq "GET") {
                    $register = Read-Db "register"
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($register | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # POST /api/register
                elseif ($reqPath -eq "/api/register" -and $method -eq "POST") {
                    $reader = New-Object System.IO.StreamReader($req.InputStream)
                    $body = $reader.ReadToEnd()
                    $data = $body | ConvertFrom-Json
                    
                    $register = Read-Db "register"
                    
                    $processedAttachments = @()
                    if ($data.attachments) {
                        foreach ($file in $data.attachments) {
                            if ($file.name -and $file.data) {
                                $saved = Save-Attachment $file.name $file.data
                                if ($saved.success) {
                                    $processedAttachments += @{
                                        originalName = $saved.originalName
                                        filename = $saved.filename
                                        path = $saved.path
                                    }
                                }
                            }
                        }
                    }
                    
                    $alertDates = Calculate-AlertDates $data.expiryDate
                    
                    $newBg = @{
                        id = Generate-Id "register" "BG"
                        requestId = if ($data.requestId) { $data.requestId } else { "" }
                        bgNumber = if ($data.bgNumber) { $data.bgNumber } else { "" }
                        bgType = if ($data.bgType) { $data.bgType } else { "EMD" }
                        beneficiary = if ($data.beneficiary) { $data.beneficiary } else { "" }
                        clientName = if ($data.clientName) { $data.clientName } else { "" }
                        siteName = if ($data.siteName) { $data.siteName } else { "" }
                        issuingBank = if ($data.issuingBank) { $data.issuingBank } else { "" }
                        issueDate = if ($data.issueDate) { $data.issueDate } else { "" }
                        effectiveDate = if ($data.effectiveDate) { $data.effectiveDate } else { "" }
                        expiryDate = if ($data.expiryDate) { $data.expiryDate } else { "" }
                        claimExpiryDate = if ($data.claimExpiryDate) { $data.claimExpiryDate } else { "" }
                        bgAmount = if ($data.bgAmount) { [double]$data.bgAmount } else { 0.0 }
                        bgCommission = if ($data.bgCommission) { [double]$data.bgCommission } else { 0.0 }
                        marginMoney = if ($data.marginMoney) { [double]$data.marginMoney } else { 0.0 }
                        fdrNo = if ($data.fdrNo) { $data.fdrNo } else { "" }
                        costCenter = if ($data.costCenter) { $data.costCenter } else { "" }
                        status = if ($data.status) { $data.status } else { "Active" }
                        autoRenewal = if ($data.autoRenewal) { [bool]$data.autoRenewal } else { $false }
                        releasedDate = if ($data.releasedDate) { $data.releasedDate } else { "" }
                        remarks = if ($data.remarks) { $data.remarks } else { "" }
                        renewalAlertDate = $alertDates.alertDate
                        renewalInitiationDate = $alertDates.initiationDate
                        attachments = $processedAttachments
                        lastUpdatedBy = if ($data.lastUpdatedBy) { $data.lastUpdatedBy } else { "Admin" }
                        lastUpdatedOn = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    }
                    
                    $register += $newBg
                    $success = Write-Db "register" $register
                    
                    $response = @{ success = $success; bg = $newBg }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                # PUT /api/register
                elseif ($reqPath -eq "/api/register" -and $method -eq "PUT") {
                    $reader = New-Object System.IO.StreamReader($req.InputStream)
                    $body = $reader.ReadToEnd()
                    $data = $body | ConvertFrom-Json
                    
                    if (!$data.id) {
                        $res.StatusCode = 400
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false,"error":"Register ID is required"}')
                        $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                        $res.Close()
                        continue
                    }
                    
                    $register = Read-Db "register"
                    $targetBg = $null
                    
                    foreach ($bg in $register) {
                        if ($bg.id -eq $data.id) {
                            $targetBg = $bg
                            break
                        }
                    }
                    
                    if ($null -eq $targetBg) {
                        $res.StatusCode = 404
                        $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"success":false,"error":"BG not found"}')
                        $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                        $res.Close()
                        continue
                    }
                    
                    # Handle new attachments
                    $processedAttachments = @()
                    if ($targetBg.attachments) {
                        $processedAttachments = $targetBg.attachments
                    }
                    if ($data.newAttachments) {
                        foreach ($file in $data.newAttachments) {
                            if ($file.name -and $file.data) {
                                $saved = Save-Attachment $file.name $file.data
                                if ($saved.success) {
                                    $processedAttachments += @{
                                        originalName = $saved.originalName
                                        filename = $saved.filename
                                        path = $saved.path
                                    }
                                }
                            }
                        }
                    }
                    
                    $alertDates = Calculate-AlertDates $data.expiryDate
                    
                    # Update properties
                    if ($null -ne $data.bgNumber) { $targetBg.bgNumber = $data.bgNumber }
                    if ($null -ne $data.bgType) { $targetBg.bgType = $data.bgType }
                    if ($null -ne $data.beneficiary) { $targetBg.beneficiary = $data.beneficiary }
                    if ($null -ne $data.clientName) { $targetBg.clientName = $data.clientName }
                    if ($null -ne $data.siteName) { $targetBg.siteName = $data.siteName }
                    if ($null -ne $data.issuingBank) { $targetBg.issuingBank = $data.issuingBank }
                    if ($null -ne $data.issueDate) { $targetBg.issueDate = $data.issueDate }
                    if ($null -ne $data.effectiveDate) { $targetBg.effectiveDate = $data.effectiveDate }
                    if ($null -ne $data.expiryDate) { $targetBg.expiryDate = $data.expiryDate }
                    if ($null -ne $data.claimExpiryDate) { $targetBg.claimExpiryDate = $data.claimExpiryDate }
                    if ($null -ne $data.bgAmount) { $targetBg.bgAmount = [double]$data.bgAmount }
                    if ($null -ne $data.bgCommission) { $targetBg.bgCommission = [double]$data.bgCommission }
                    if ($null -ne $data.marginMoney) { $targetBg.marginMoney = [double]$data.marginMoney }
                    if ($null -ne $data.fdrNo) { $targetBg.fdrNo = $data.fdrNo }
                    if ($null -ne $data.costCenter) { $targetBg.costCenter = $data.costCenter }
                    if ($null -ne $data.status) { $targetBg.status = $data.status }
                    if ($null -ne $data.autoRenewal) { $targetBg.autoRenewal = [bool]$data.autoRenewal }
                    if ($null -ne $data.releasedDate) { $targetBg.releasedDate = $data.releasedDate }
                    if ($null -ne $data.remarks) { $targetBg.remarks = $data.remarks }
                    
                    $targetBg.renewalAlertDate = $alertDates.alertDate
                    $targetBg.renewalInitiationDate = $alertDates.initiationDate
                    $targetBg.attachments = $processedAttachments
                    $targetBg.lastUpdatedBy = $data.lastUpdatedBy
                    $targetBg.lastUpdatedOn = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
                    
                    $success = Write-Db "register" $register
                    
                    $response = @{ success = $success; bg = $targetBg }
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes(($response | ConvertTo-Json -Depth 10))
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
                
                else {
                    $res.StatusCode = 404
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Endpoint not found"}')
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
            } catch {
                Write-Host "API Request Error: $_" -ForegroundColor Red
                $res.StatusCode = 500
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Internal server error"}')
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
            
            $res.Close()
            continue
        }

        # --- STATIC FILE SERVING (Uploads Only) ---
        if ($reqPath.StartsWith("/uploads/")) {
            $filePath = Join-Path $ScriptDir $reqPath.Replace("/", "\").Substring(1)
            if (Test-Path $filePath -PathType Leaf) {
                $ext = [System.IO.Path]::GetExtension($filePath).ToLower()
                $contentType = "application/octet-stream"
                if ($MimeTypes.ContainsKey($ext)) {
                    $contentType = $MimeTypes[$ext]
                }
                $res.ContentType = $contentType
                $res.StatusCode = 200
                try {
                    $fileBytes = [System.IO.File]::ReadAllBytes($filePath)
                    $res.OutputStream.Write($fileBytes, 0, $fileBytes.Length)
                } catch {
                    Write-Host "Error reading file $filePath : $_" -ForegroundColor Red
                    $res.StatusCode = 500
                    $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Error reading file"}')
                    $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
                }
            } else {
                $res.StatusCode = 404
                $res.ContentType = "application/json"
                $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"File not found"}')
                $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
            }
        } else {
            $res.StatusCode = 404
            $res.ContentType = "application/json"
            $resBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Not Found"}')
            $res.OutputStream.Write($resBytes, 0, $resBytes.Length)
        }

        $res.Close()
    }
} finally {
    $listener.Stop()
    Write-Host "Server stopped." -ForegroundColor Yellow
}
