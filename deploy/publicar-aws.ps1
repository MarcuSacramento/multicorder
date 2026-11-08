<#
  Publica o MultiCorder na AWS (S3 + CloudFront criados pelo deploy/aws-site.yaml).

  Uso (PowerShell, na pasta do projeto):
    powershell -ExecutionPolicy Bypass -File deploy\publicar-aws.ps1
    powershell -ExecutionPolicy Bypass -File deploy\publicar-aws.ps1 -Stack multicorder -Region sa-east-1
    powershell -ExecutionPolicy Bypass -File deploy\publicar-aws.ps1 -Forcar   # reenvia tudo

  O que faz:
    1. Le o nome do bucket e da distribuicao nas saidas da stack do CloudFormation.
    2. Envia so os arquivos do app (nada de docs, .git, serve.py...), cada grupo com o tipo de
       arquivo certo (Content-Type) e o cache certo (Cache-Control):
         - pagina, codigo e estilos: o navegador guarda e so confere se mudou (304, sem baixar);
         - kits de bateria (48 MB) e icones: guardados 1 dia no navegador sem conferir;
         - na CDN (s-maxage): tudo guardado ate a proxima publicacao.
    3. Limpa o cache do CloudFront ("/*"), para a versao nova aparecer na hora.

  Precisa do AWS CLI v2 configurado (aws configure ou aws configure sso). Veja docs/PUBLICAR-AWS.md.
#>
param(
  [string]$Stack = 'multicorder',
  [string]$Region = 'sa-east-1',
  [switch]$Forcar,
  [switch]$SemLimparCache
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot

# AWS CLI: o do PATH ou o do lugar padrao de instalacao (terminais abertos antes de instalar
# ainda nao enxergam o PATH novo).
$cli = Get-Command aws -ErrorAction SilentlyContinue
if ($cli) { $AwsExe = $cli.Source }
elseif (Test-Path "$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe") { $AwsExe = "$env:ProgramFiles\Amazon\AWSCLIV2\aws.exe" }
else { throw 'AWS CLI nao encontrado. Instale: https://aws.amazon.com/cli/ (e rode "aws configure sso").' }
function aws { & $AwsExe @args }

Write-Host "Lendo a stack '$Stack' ($Region)..."
$outputs = aws cloudformation describe-stacks --stack-name $Stack --region $Region --query 'Stacks[0].Outputs' --output json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $outputs) { throw "Stack '$Stack' nao encontrada em $Region. Crie com o deploy/aws-site.yaml primeiro." }
function Get-Output($key) { ($outputs | Where-Object { $_.OutputKey -eq $key }).OutputValue }
$Bucket = Get-Output 'BucketName'
$DistId = Get-Output 'DistributionId'
$Url = Get-Output 'SiteUrl'

# Cache: navegador (max-age) e CDN (s-maxage). A CDN e limpa a cada publicacao.
$Revalidar = 'public, max-age=0, s-maxage=31536000, must-revalidate'
$UmDia = 'public, max-age=86400, s-maxage=31536000'

# Envia os arquivos de uma pasta que batem com os filtros, com tipo e cache fixos.
# sync so manda o que mudou (tamanho/data) e apaga do bucket o que saiu da pasta;
# com -Forcar usa cp, que reenvia tudo (use quando mudar as regras de tipo/cache).
function Send-Group([string]$Src, [string]$Dst, [string[]]$Include, [string]$Type, [string]$Cache) {
  $from = Join-Path $Root $Src
  $to = "s3://$Bucket/$Dst"
  if ($Forcar) { $cmd = @('s3', 'cp', $from, $to, '--recursive') } else { $cmd = @('s3', 'sync', $from, $to, '--delete') }
  $cmd += @('--exclude', '*')
  foreach ($i in $Include) { $cmd += @('--include', $i) }
  $cmd += @('--content-type', $Type, '--cache-control', $Cache, '--region', $Region, '--only-show-errors')
  & aws @cmd
  if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar $Src ($($Include -join ', '))" }
  Write-Host ("  {0,-8} {1,-22} {2}" -f $Src, ($Include -join ' '), $Type)
}

# Arquivo solto da raiz
function Send-File([string]$Name, [string]$Type, [string]$Cache) {
  & aws s3 cp (Join-Path $Root $Name) "s3://$Bucket/$Name" --content-type $Type --cache-control $Cache --region $Region --only-show-errors
  if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar $Name" }
  Write-Host ("  {0,-31} {1}" -f $Name, $Type)
}

Write-Host "Enviando para s3://$Bucket ..."
Send-File 'index.html' 'text/html; charset=utf-8' $Revalidar
Send-File 'styles.css' 'text/css; charset=utf-8' $Revalidar
Send-File 'manifest.webmanifest' 'application/manifest+json; charset=utf-8' $Revalidar
Send-Group 'src' 'src' @('*.js') 'text/javascript; charset=utf-8' $Revalidar
Send-Group 'icons' 'icons' @('*.png') 'image/png' $UmDia
Send-Group 'icons' 'icons' @('*.svg') 'image/svg+xml' $UmDia
Send-Group 'icons' 'icons' @('*.ico') 'image/x-icon' $UmDia
Send-Group 'kits' 'kits' @('*.bin') 'application/octet-stream' $UmDia
Send-Group 'kits' 'kits' @('*.json') 'application/json; charset=utf-8' $UmDia
Send-Group 'kits' 'kits' @('*.txt') 'text/plain; charset=utf-8' $UmDia

if (-not $SemLimparCache) {
  Write-Host 'Limpando o cache do CloudFront...'
  $inv = aws cloudfront create-invalidation --distribution-id $DistId --paths '/*' --query 'Invalidation.Id' --output text
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao limpar o cache do CloudFront' }
  Write-Host "  pedido $inv (leva 1 a 2 minutos para valer em todo lugar)"
}

Write-Host ''
Write-Host "Pronto: $Url"
