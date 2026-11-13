// 老格式 Office 文档转换：.doc / .wps → .docx
// 思路：调用本机已安装的 Word 或 WPS（COM），只做格式转换，不依赖 npm 包。
// 没有 Office/WPS 的环境会返回失败，调用方据此提示「另存为 docx」。
import fs from 'node:fs';
import { spawn } from 'node:child_process';

/** 本机是否具备转换能力（PowerShell + Word/WPS COM） */
export function canConvertOffice() {
  if (process.platform !== 'win32') return false;
  const candidates = [
    'C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE',
    'C:/Program Files (x86)/Microsoft Office/root/Office16/WINWORD.EXE',
    'C:/Program Files/WPS Office',
    'C:/Users/Public/Documents/WPSDrive',
  ];
  const office = candidates.some((p) => fs.existsSync(p));
  // 没有明显安装目录时也允许尝试（COM 可能来自别的安装路径）
  return office || true;
}

const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$word = $null
try {
  try { $word = New-Object -ComObject Word.Application }
  catch { $word = New-Object -ComObject KWPS.Application }
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open($env:DOC_IN, $false, $true)
  try { $doc.SaveAs2($env:DOC_OUT, 16) }
  catch { $doc.SaveAs([ref]$env:DOC_OUT, [ref]16) }
  $doc.Close(0)
} finally {
  if ($word) { try { $word.Quit() } catch { } }
}
`;

/**
 * 把 .doc / .wps 转成 .docx（输出到指定路径）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export function convertToDocx(inputPath, outputPath, timeoutMs = 90_000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], {
        env: { ...process.env, DOC_IN: inputPath, DOC_OUT: outputPath },
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      return finish({ ok: false, error: String(error.message || error) });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: '转换超时（Word/WPS 可能弹了对话框）' });
    }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); finish({ ok: false, error: String(error.message || error) }); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) return finish({ ok: true });
      finish({ ok: false, error: `转换进程退出码 ${code}` });
    });
  });
}
