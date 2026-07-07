$ErrorActionPreference = 'Stop'
$env:CGO_ENABLED = '0'

$targets = @(
    @{ GOOS='windows'; GOARCH='amd64';  Name='cfstd-windows-x86_64.exe' },
    @{ GOOS='windows'; GOARCH='386';    Name='cfstd-windows-x86.exe'    },
    @{ GOOS='windows'; GOARCH='arm64';  Name='cfstd-windows-arm64.exe'  },
    @{ GOOS='linux';   GOARCH='amd64';  Name='cfstd-linux-x86_64'       },
    @{ GOOS='linux';   GOARCH='386';    Name='cfstd-linux-x86'          },
    @{ GOOS='linux';   GOARCH='arm64';  Name='cfstd-linux-aarch64'      },
    @{ GOOS='linux';   GOARCH='arm';    GOARM='7'; Name='cfstd-linux-armv7' },
    @{ GOOS='linux';   GOARCH='arm';    Name='cfstd-linux-arm'          },
    @{ GOOS='linux';   GOARCH='loong64'; Name='cfstd-linux-loongarch64' },
    @{ GOOS='linux';   GOARCH='riscv64'; Name='cfstd-linux-riscv64'     },
    @{ GOOS='linux';   GOARCH='mips';   GOMIPS='softfloat'; Name='cfstd-linux-mips'     },
    @{ GOOS='linux';   GOARCH='mips64'; GOMIPS='softfloat'; Name='cfstd-linux-mips64'   },
    @{ GOOS='linux';   GOARCH='mipsle'; GOMIPS='softfloat'; Name='cfstd-linux-mipsle'   },
    @{ GOOS='linux';   GOARCH='mips64le'; GOMIPS='softfloat'; Name='cfstd-linux-mips64le' },
    @{ GOOS='darwin';  GOARCH='amd64';  Name='cfstd-macos-x86_64'       },
    @{ GOOS='darwin';  GOARCH='arm64';  Name='cfstd-macos-aarch64'      }
)

$outDir = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$ok = 0; $fail = 0

foreach ($t in $targets) {
    $env:GOOS   = $t.GOOS
    $env:GOARCH = $t.GOARCH
    $env:GOARM  = if ($t.GOARM)  { $t.GOARM }  else { '' }
    $env:GOMIPS = if ($t.GOMIPS) { $t.GOMIPS } else { '' }

    $out = Join-Path $outDir $t.Name
    Write-Host "  [$($t.GOOS)/$($t.GOARCH)] $($t.Name) ... " -NoNewline

    try {
        & go build -o $out -ldflags="-s -w" . 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
            $fail++
        } else {
            Write-Host "OK" -ForegroundColor Green
            $ok++
        }
    } catch {
        Write-Host "FAILED ($_)" -ForegroundColor Red
        $fail++
    }
}

Write-Host ""
Write-Host "完成：$ok 成功，$fail 失败。输出目录：$outDir"
