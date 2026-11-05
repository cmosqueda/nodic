$ErrorActionPreference = "Stop"

$androidStudioJbr = "C:\Program Files\Android\Android Studio\jbr"
if ((-not $env:JAVA_HOME) -or -not (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    if (Test-Path (Join-Path $androidStudioJbr "bin\java.exe")) {
        $env:JAVA_HOME = $androidStudioJbr
    } else {
        throw "JDK 21 is required. Set JAVA_HOME before building Nodic."
    }
}

$javaRelease = Get-Content (Join-Path $env:JAVA_HOME "release") | Select-String '^JAVA_VERSION=' | Select-Object -First 1
if ($javaRelease -notmatch 'JAVA_VERSION="(2[1-9]|[3-9][0-9])') {
    if (Test-Path (Join-Path $androidStudioJbr "bin\java.exe")) {
        $env:JAVA_HOME = $androidStudioJbr
    } else {
        throw "Capacitor 8 requires JDK 21 or newer. Found: $javaRelease"
    }
}

$env:Path = "$(Join-Path $env:JAVA_HOME 'bin');$env:Path"
Push-Location (Join-Path $PSScriptRoot "..\android")
try {
    & .\gradlew.bat assembleDebug
    if ($LASTEXITCODE -ne 0) { throw "Android build failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}
